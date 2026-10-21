import fs from 'node:fs'
import path from 'node:path'
import type { Boom } from '@hapi/boom'
import makeWASocket, {
	Browsers,
	DisconnectReason,
	downloadMediaMessage,
	fetchLatestBaileysVersion,
	useMultiFileAuthState
} from 'baileys'
import type { WAMessage, WASocket } from 'baileys'
import pino from 'pino'
import { config } from './config.js'
import { db } from './db.js'
import { emitEvent } from './events.js'
import {
	fromRaw,
	isMediaType,
	markDeleted,
	saveChat,
	saveContact,
	saveGroup,
	saveLidMapping,
	saveMessage,
	setMediaPath,
	describeMessage,
	messageEvent
} from './store.js'

export const logger = pino({ level: config.logLevel })

type Status = {
	connection: 'idle' | 'connecting' | 'open' | 'close'
	registered: boolean
	qr: string | null
	loggedOut: boolean
	me: { id?: string; lid?: string; name?: string } | null
}

export const status: Status = { connection: 'idle', registered: false, qr: null, loggedOut: false, me: null }

let sock: WASocket | null = null
let starting = false

export const getSock = () => {
	if (!sock || status.connection !== 'open') throw new Error('WhatsApp chưa kết nối')
	return sock
}

const extFor = (mime?: string | null, fileName?: string | null) => {
	if (fileName && path.extname(fileName)) return path.extname(fileName)
	const sub = mime?.split(';')[0]?.split('/')[1]
	if (!sub) return '.bin'
	const map: Record<string, string> = { jpeg: '.jpg', 'ogg': '.ogg', mpeg: '.mp3', plain: '.txt' }
	return '.' + (map[sub] ?? sub.replace(/[^a-z0-9]/gi, ''))
}

const safe = (s: string) => s.replace(/[^a-zA-Z0-9._-]/g, '_')

/** Tải media của một tin đã lưu về đĩa; trả về đường dẫn tương đối trong mediaDir. */
export const downloadAndSaveMedia = async (msg: WAMessage): Promise<string | null> => {
	const { content, type } = describeMessage(msg)
	if (!isMediaType(type) || !content || !msg.key.remoteJid || !msg.key.id) return null
	const media = (content as any)[type!] as { mimetype?: string; fileName?: string } | undefined
	const rel = path.join(safe(msg.key.remoteJid), safe(msg.key.id) + extFor(media?.mimetype, media?.fileName))
	const abs = path.join(config.mediaDir, rel)
	if (fs.existsSync(abs)) return rel
	const s = getSock()
	const buffer = (await downloadMediaMessage(msg, 'buffer', {}, { logger, reuploadRequest: s.updateMediaMessage })) as Buffer
	fs.mkdirSync(path.dirname(abs), { recursive: true })
	fs.writeFileSync(abs, buffer)
	setMediaPath(msg.key.remoteJid, msg.key.id, msg.key.fromMe ? 1 : 0, rel)
	return rel
}

export const refreshGroups = async () => {
	const s = getSock()
	const groups = await s.groupFetchAllParticipating()
	for (const g of Object.values(groups)) saveGroup(g)
	// một số bản WhatsApp không đưa community vào danh sách group thường
	const communities = await s.communityFetchAllParticipating().catch(err => {
		logger.warn({ err: (err as Error).message }, 'không lấy được danh sách community')
		return {}
	})
	for (const g of Object.values(communities)) saveGroup(g)
	logger.info({ groups: Object.keys(groups).length, communities: Object.keys(communities).length }, 'đã đồng bộ danh sách group')
}

const refreshGroup = async (jid: string) => {
	try {
		saveGroup(await getSock().groupMetadata(jid))
	} catch (err) {
		logger.warn({ err, jid }, 'không refresh được group')
	}
}

const wipeAuth = () => fs.rmSync(config.authDir, { recursive: true, force: true })

export const startWhatsApp = async (): Promise<void> => {
	if (starting) return
	starting = true
	try {
		fs.mkdirSync(config.authDir, { recursive: true })
		fs.mkdirSync(config.mediaDir, { recursive: true })
		const { state, saveCreds } = await useMultiFileAuthState(config.authDir)
		const { version } = await fetchLatestBaileysVersion()
		status.connection = 'connecting'
		status.registered = !!state.creds.registered

		const s = makeWASocket({
			version,
			logger: logger.child({ mod: 'baileys' }, { level: process.env.BAILEYS_LOG ?? 'warn' }),
			auth: state,
			// syncFullHistory chỉ được WhatsApp chấp nhận khi giả lập "Desktop"
			browser: config.syncFullHistory ? Browsers.windows('Desktop') : [config.deviceName, 'Chrome', '1.0.0'],
			syncFullHistory: config.syncFullHistory,
			shouldSyncHistoryMessage: () => true,
			// không đánh dấu online để điện thoại vẫn nhận thông báo
			markOnlineOnConnect: false,
			getMessage: async key => {
				if (!key.remoteJid || !key.id) return undefined
				const row = db
					.prepare('SELECT raw FROM messages WHERE chat_jid = ? AND id = ? AND from_me = ?')
					.get(key.remoteJid, key.id, key.fromMe ? 1 : 0) as { raw: string } | undefined
				return row ? fromRaw(row.raw).message ?? undefined : undefined
			}
		})
		sock = s

		s.ev.process(async events => {
			if (events['creds.update']) await saveCreds()

			if (events['connection.update']) {
				const { connection, lastDisconnect, qr } = events['connection.update']
				if (qr) status.qr = qr
				if (connection) status.connection = connection
				if (connection === 'open') {
					status.qr = null
					status.registered = true
					status.loggedOut = false
					status.me = { id: s.user?.id, lid: s.user?.lid, name: s.user?.name }
					logger.info({ me: status.me }, 'đã kết nối WhatsApp')
					emitEvent('connection', { state: 'open', me: status.me })
					refreshGroups().catch(err => logger.warn({ err }, 'sync group lỗi'))
				}
				if (connection === 'close') {
					const code = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode
					sock = null
					starting = false
					emitEvent('connection', { state: code === DisconnectReason.loggedOut ? 'logged_out' : 'close', code })
					if (code === DisconnectReason.loggedOut) {
						logger.warn('bị logout — xoá phiên cũ, chờ pair lại')
						status.loggedOut = true
						status.me = null
						status.registered = false
						wipeAuth()
					} else {
						logger.warn({ code }, 'mất kết nối, thử lại sau 3s')
					}
					setTimeout(() => void startWhatsApp(), 3000)
				}
			}

			if (events['messaging-history.set']) {
				const { chats, contacts, messages, lidPnMappings, progress } = events['messaging-history.set']
				db.transaction(() => {
					chats.forEach(saveChat)
					contacts.forEach(saveContact)
					messages.forEach(saveMessage)
					lidPnMappings?.forEach(m => saveLidMapping(m.lid, m.pn))
				})()
				logger.info({ chats: chats.length, contacts: contacts.length, messages: messages.length, progress }, 'history sync')
			}

			if (events['messages.upsert']) {
				const { messages, type } = events['messages.upsert']
				for (const msg of messages) {
					const saved = saveMessage(msg)
					if (!saved || type !== 'notify') continue
					const ev = messageEvent(saved.chat, saved.id, saved.fromMe, status.me?.id)
					if (ev) emitEvent('message', ev)
					if (!isMediaType(saved.type)) continue
					const announce = (downloaded: boolean) =>
						emitEvent('file_received', {
							chat_id: saved.chat,
							chat_type: ev?.chat_type,
							message_id: saved.id,
							sender_id: ev?.sender_id,
							sender_name: ev?.sender_name,
							from_me: !!saved.fromMe,
							kind: ev?.kind,
							downloaded,
							download_path: `/messages/${encodeURIComponent(saved.chat)}/${encodeURIComponent(saved.id)}/media`
						})
					if (config.autoDownloadMedia) {
						downloadAndSaveMedia(msg)
							.then(rel => announce(!!rel))
							.catch(err => {
								logger.warn({ err, id: saved.id }, 'tải media lỗi')
								announce(false)
							})
					} else announce(false)
				}
			}

			if (events['messages.delete']) {
				const d = events['messages.delete']
				if ('keys' in d)
					d.keys.forEach(k => {
						if (!k.remoteJid || !k.id) return
						markDeleted(k.remoteJid, k.id)
						emitEvent('message_deleted', { chat_id: k.remoteJid, message_id: k.id })
					})
			}

			if (events['chats.upsert']) events['chats.upsert'].forEach(saveChat)
			if (events['chats.update']) events['chats.update'].forEach(c => saveChat(c as any))
			if (events['contacts.upsert']) events['contacts.upsert'].forEach(saveContact)
			if (events['contacts.update']) events['contacts.update'].forEach(saveContact)
			if (events['lid-mapping.update']) saveLidMapping(events['lid-mapping.update'].lid, events['lid-mapping.update'].pn)

			if (events['groups.upsert']) events['groups.upsert'].forEach(saveGroup)
			if (events['groups.update'])
				for (const g of events['groups.update']) {
					if (!g.id) continue
					emitEvent('group_event', { event: 'update', group_id: g.id, group_name: g.subject ?? null, actor_id: g.author ?? null, members: [] })
					void refreshGroup(g.id)
				}
			if (events['group-participants.update']) {
				const u = events['group-participants.update']
				emitEvent('group_event', {
					event: u.action,
					group_id: u.id,
					actor_id: u.author ?? null,
					members: u.participants.map(p => (typeof p === 'string' ? { id: p } : { id: p.id, phone_number: p.phoneNumber ?? null }))
				})
				void refreshGroup(u.id)
			}
		})
	} catch (err) {
		starting = false
		logger.error({ err }, 'khởi động WhatsApp lỗi, thử lại sau 5s')
		setTimeout(() => void startWhatsApp(), 5000)
	}
}

export const requestPairingCode = async (phone: string): Promise<string> => {
	if (status.registered) throw new Error('Đã đăng nhập rồi — logout trước nếu muốn pair số khác')
	// requestPairingCode chỉ dùng được khi socket đã handshake xong (đã có QR)
	for (let i = 0; i < 30 && !(sock && status.qr); i++) await new Promise(r => setTimeout(r, 500))
	if (!sock || !status.qr) throw new Error('Socket chưa sẵn sàng, thử lại sau vài giây')
	return sock.requestPairingCode(phone.replace(/\D/g, ''))
}

export const logoutWhatsApp = async () => {
	if (sock) await sock.logout().catch(() => undefined)
}
