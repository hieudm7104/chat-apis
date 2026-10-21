import fs from 'node:fs'
import path from 'node:path'
import { imageSize } from 'image-size'
import { FriendEventType, GroupEventType, LoginQRCallbackEventType, ThreadType, Zalo } from 'zca-js'
import type { API, Credentials, Message, TMessage } from 'zca-js'
import { config } from './config.js'
import { db } from './db.js'
import { emitEvent, logger } from './events.js'
import {
	chatTypeOf,
	markDeleted,
	saveFriendRequest,
	saveGroup,
	saveMemberProfile,
	saveMessage,
	saveUser,
	setMediaPath
} from './store.js'
import type { Attachment, StoredMessage } from './store.js'
import { imageDims, isImageName, mimeFor, safe } from './util.js'

type State = 'idle' | 'starting' | 'qr' | 'scanned' | 'open' | 'reconnecting' | 'logged_out'

export const status: {
	state: State
	qr: string | null
	scanned_as: { name: string; avatar: string } | null
	me: { id: string; name?: string; avatar?: string; phone?: string } | null
	error: string | null
} = { state: 'idle', qr: null, scanned_as: null, me: null, error: null }

let api: API | null = null
let starting = false
let restartTimer: NodeJS.Timeout | null = null
let abortQr: (() => unknown) | null = null

export const getApi = () => {
	if (!api || status.state !== 'open') throw new Error('Zalo chưa đăng nhập hoặc đang mất kết nối')
	return api
}

const readCreds = (): Credentials | null => {
	try {
		return JSON.parse(fs.readFileSync(config.credFile, 'utf8')) as Credentials
	} catch {
		return null
	}
}

const writeCreds = (c: Credentials) => {
	fs.mkdirSync(config.authDir, { recursive: true })
	fs.writeFileSync(config.credFile, JSON.stringify(c), { mode: 0o600 })
}

const clearCreds = () => fs.rmSync(config.credFile, { force: true })

const newZalo = () =>
	new Zalo({
		selfListen: config.selfListen,
		checkUpdate: false,
		logging: false,
		imageMetadataGetter: async filePath => {
			try {
				const buf = fs.readFileSync(filePath)
				const { width, height } = imageSize(buf)
				return width && height ? { width, height, size: buf.length } : null
			} catch {
				return null
			}
		}
	})

// ---------- tra cứu / đồng bộ ----------

export const ensureUsers = async (ids: string[]) => {
	const a = getApi()
	for (let i = 0; i < ids.length; i += 50) {
		const chunk = ids.slice(i, i + 50)
		const res = await a.getUserInfo(chunk)
		for (const u of Object.values(res.changed_profiles ?? {})) saveUser(u)
	}
}

export const refreshFriends = async () => {
	const friends = await getApi().getAllFriends()
	db.transaction(() => friends.forEach(u => saveUser(u, true)))()
	return friends.length
}

const unnamed = db.prepare('SELECT 1 FROM users WHERE id = ? AND display_name IS NOT NULL')

/** Điền tên cho các uid chưa có hồ sơ; từng lô độc lập để một lô lỗi không làm hỏng cả đợt. */
export const fillMissingProfiles = async (ids: string[]) => {
	const a = getApi()
	let missing = ids.filter(id => !unnamed.get(id))
	for (let i = 0; i < missing.length; i += 100) {
		try {
			const res = await a.getGroupMembersInfo(missing.slice(i, i + 100))
			for (const p of Object.values(res.profiles ?? {})) saveMemberProfile(p)
		} catch (err) {
			logger.warn({ err: (err as Error).message, size: Math.min(100, missing.length - i) }, 'getGroupMembersInfo lỗi, dùng getUserInfo')
		}
	}
	// getGroupMembersInfo bỏ sót một số người; getUserInfo tra được cả người chưa kết bạn
	missing = missing.filter(id => !unnamed.get(id))
	for (let i = 0; i < missing.length; i += 50) {
		try {
			await ensureUsers(missing.slice(i, i + 50))
		} catch (err) {
			logger.warn({ err: (err as Error).message }, 'getUserInfo lỗi')
		}
	}
	return missing.filter(id => !unnamed.get(id)).length
}

const fillMemberProfiles = fillMissingProfiles

export const refreshGroup = async (groupId: string) => {
	const res = await getApi().getGroupInfo(groupId)
	const g = res.gridInfoMap[groupId]
	if (!g) return null
	saveGroup(g)
	await fillMemberProfiles(g.memberIds ?? []).catch(err => logger.warn({ err: (err as Error).message, groupId }, 'không lấy được tên thành viên'))
	return g
}

export const refreshGroups = async () => {
	const a = getApi()
	const ids = Object.keys((await a.getAllGroups()).gridVerMap ?? {})
	for (let i = 0; i < ids.length; i += 20) {
		const res = await a.getGroupInfo(ids.slice(i, i + 20))
		for (const g of Object.values(res.gridInfoMap)) {
			saveGroup(g)
			await fillMemberProfiles(g.memberIds ?? []).catch(() => undefined)
		}
	}
	logger.info({ count: ids.length }, 'đã đồng bộ nhóm')
	return ids.length
}

// ---------- gửi tin ----------

const quoteFor = (chatId: string, msgId: string) => {
	const row = db.prepare('SELECT raw FROM messages WHERE chat_id = ? AND id = ?').get(chatId, msgId) as { raw: string } | undefined
	if (!row) throw new Error('không tìm thấy tin để trích dẫn')
	const m = JSON.parse(row.raw) as TMessage
	return { content: m.content, msgType: m.msgType, propertyExt: m.propertyExt, uidFrom: m.uidFrom, msgId: m.msgId, cliMsgId: m.cliMsgId, ts: m.ts, ttl: m.ttl }
}

export type SendFile = { data: Buffer; filename: string }

export const sendToChat = async (
	chatId: string,
	opts: {
		text?: string
		type?: 'user' | 'group'
		quoteId?: string
		mentions?: { uid: string; pos: number; len: number }[]
		files?: SendFile[]
	}
) => {
	const a = getApi()
	const type = opts.type ?? chatTypeOf(chatId) ?? 'user'
	const attachments = opts.files?.map(f => {
		const meta: { totalSize: number; width?: number; height?: number } = { totalSize: f.data.length }
		if (isImageName(f.filename) || /\.gif$/i.test(f.filename)) {
			const d = imageDims(f.data)
			if (!d) throw new Error(`không đọc được kích thước ảnh ${f.filename}`)
			Object.assign(meta, d)
		}
		return { data: f.data, filename: f.filename as `${string}.${string}`, metadata: meta }
	})
	const res = await a.sendMessage(
		{
			msg: opts.text ?? '',
			quote: opts.quoteId ? quoteFor(chatId, opts.quoteId) : undefined,
			mentions: opts.mentions,
			attachments
		},
		chatId,
		type === 'group' ? ThreadType.Group : ThreadType.User
	)
	return {
		chat_id: chatId,
		chat_type: type,
		id: res.message ? String(res.message.msgId) : null,
		attachment_ids: res.attachment.map(x => String(x.msgId))
	}
}

// ---------- tải file ----------

const extFromType = (ct: string | null) => {
	const sub = ct?.split(';')[0]?.split('/')[1]
	if (!sub) return ''
	const map: Record<string, string> = { jpeg: '.jpg', mpeg: '.mp3', plain: '.txt', 'octet-stream': '' }
	return sub in map ? map[sub]! : '.' + sub.replace(/[^a-z0-9]/gi, '')
}

export const downloadMedia = async (chatId: string, msgId: string): Promise<string | null> => {
	const row = db.prepare('SELECT attachment, media_path, kind FROM messages WHERE chat_id = ? AND id = ?').get(chatId, msgId) as
		| { attachment: string | null; media_path: string | null; kind: string }
		| undefined
	if (!row?.attachment || row.kind === 'link') return null
	if (row.media_path && fs.existsSync(path.join(config.mediaDir, row.media_path))) return row.media_path
	const att = JSON.parse(row.attachment) as Attachment

	let res = await fetch(att.url, { signal: AbortSignal.timeout(120_000) })
	if (!res.ok && api) {
		const cookie = await api.getCookie().getCookieString(att.url).catch(() => '')
		if (cookie) res = await fetch(att.url, { headers: { cookie }, signal: AbortSignal.timeout(120_000) })
	}
	if (!res.ok) throw new Error(`HTTP ${res.status} khi tải ${att.url}`)

	let name: string
	if (att.name) name = safe(att.name)
	else name = 'file' + (path.extname(new URL(att.url).pathname) || extFromType(res.headers.get('content-type')))
	const rel = path.join(safe(chatId), `${safe(msgId)}_${name}`)
	const abs = path.join(config.mediaDir, rel)
	fs.mkdirSync(path.dirname(abs), { recursive: true })
	fs.writeFileSync(abs, Buffer.from(await res.arrayBuffer()))
	setMediaPath(chatId, msgId, rel)
	return rel
}

export const mediaMime = (rel: string) => mimeFor(rel)

// ---------- xử lý sự kiện realtime ----------

const downloadable = new Set(['image', 'video', 'voice', 'file', 'gif'])

const onMessage = (m: Message) => {
	const saved = saveMessage(m)
	if (!saved) return
	emitEvent('message', saved)
	if (saved.attachment && downloadable.has(saved.kind)) void announceFile(saved)
}

const announceFile = async (saved: StoredMessage) => {
	let mediaPath: string | null = null
	if (config.autoDownloadMedia) {
		try {
			mediaPath = await downloadMedia(saved.chat_id, saved.id)
		} catch (err) {
			logger.warn({ err: (err as Error).message, id: saved.id }, 'tải file lỗi')
		}
	}
	emitEvent('file_received', {
		chat_id: saved.chat_id,
		chat_type: saved.chat_type,
		message_id: saved.id,
		sender_id: saved.sender_id,
		sender_name: saved.sender_name,
		from_me: saved.from_me,
		kind: saved.kind,
		name: saved.attachment?.name ?? null,
		size: saved.attachment?.size ?? null,
		downloaded: !!mediaPath,
		download_path: `/messages/${encodeURIComponent(saved.chat_id)}/${encodeURIComponent(saved.id)}/media`
	})
}

const profileOf = async (id: string) => {
	try {
		await ensureUsers([id])
	} catch (err) {
		logger.warn({ err: (err as Error).message, id }, 'không lấy được hồ sơ')
	}
	return db.prepare('SELECT id, display_name, zalo_name, username, phone, avatar FROM users WHERE id = ?').get(id) ?? { id }
}

const onFriendEvent = async (ev: { type: FriendEventType; data: unknown; threadId: string; isSelf: boolean }, ownId: string) => {
	switch (ev.type) {
		case FriendEventType.REQUEST: {
			const d = ev.data as { toUid: string; fromUid: string; src: number; message: string }
			const incoming = d.fromUid !== ownId
			const other = incoming ? d.fromUid : d.toUid
			saveFriendRequest(other, incoming ? 'incoming' : 'outgoing', 'pending', d.message, d.src)
			emitEvent('friend_request', {
				direction: incoming ? 'incoming' : 'outgoing',
				user_id: other,
				message: d.message,
				src: d.src,
				user: await profileOf(other)
			})
			return
		}
		case FriendEventType.ADD: {
			const id = String(ev.data)
			db.prepare("UPDATE friend_requests SET status = 'accepted', updated_at = strftime('%s','now') WHERE user_id = ? AND status = 'pending'").run(id)
			emitEvent('friend_event', { event: 'added', user_id: id, user: await profileOf(id) })
			void refreshFriends().catch(() => undefined)
			return
		}
		case FriendEventType.REMOVE: {
			const id = String(ev.data)
			db.prepare('UPDATE users SET is_friend = 0 WHERE id = ?').run(id)
			emitEvent('friend_event', { event: 'removed', user_id: id })
			return
		}
		case FriendEventType.UNDO_REQUEST:
		case FriendEventType.REJECT_REQUEST: {
			const d = ev.data as { toUid: string; fromUid: string }
			const incoming = d.fromUid !== ownId
			const other = incoming ? d.fromUid : d.toUid
			const st = ev.type === FriendEventType.UNDO_REQUEST ? 'canceled' : 'rejected'
			db.prepare("UPDATE friend_requests SET status = ?, updated_at = strftime('%s','now') WHERE user_id = ? AND status = 'pending'").run(st, other)
			emitEvent('friend_event', { event: st, direction: incoming ? 'incoming' : 'outgoing', user_id: other })
			return
		}
		default:
			emitEvent('friend_event', { event: String(ev.type).toLowerCase(), data: ev.data })
	}
}

const groupTimers = new Map<string, NodeJS.Timeout>()
const refreshGroupSoon = (groupId: string) => {
	clearTimeout(groupTimers.get(groupId))
	groupTimers.set(
		groupId,
		setTimeout(() => void refreshGroup(groupId).catch(err => logger.warn({ err: (err as Error).message, groupId }, 'refresh nhóm lỗi')), 1500)
	)
}

const memberEvents = new Set<string>([
	GroupEventType.JOIN, GroupEventType.LEAVE, GroupEventType.REMOVE_MEMBER, GroupEventType.BLOCK_MEMBER,
	GroupEventType.ADD_ADMIN, GroupEventType.REMOVE_ADMIN, GroupEventType.UPDATE, GroupEventType.UPDATE_AVATAR
])

const attachListeners = (a: API) => {
	const own = a.getOwnId()
	const l = a.listener
	l.on('connected', () => logger.info('listener Zalo đã kết nối'))
	l.on('message', onMessage)
	l.on('old_messages', msgs => msgs.forEach(m => saveMessage(m)))
	l.on('undo', u => {
		markDeleted(u.threadId, String(u.data.content.globalMsgId))
		emitEvent('message_deleted', { chat_id: u.threadId, message_id: String(u.data.content.globalMsgId), by: u.data.uidFrom })
	})
	l.on('reaction', r => emitEvent('reaction', r))
	l.on('friend_event', ev => void onFriendEvent(ev as never, own).catch(err => logger.error({ err }, 'friend_event lỗi')))
	l.on('group_event', ev => {
		const d = ev.data as { groupId?: string; sourceId?: string; updateMembers?: { id: string; dName: string }[]; groupName?: string }
		const groupId = d.groupId ?? ev.threadId
		emitEvent('group_event', {
			event: ev.type,
			group_id: groupId,
			group_name: d.groupName ?? null,
			actor_id: d.sourceId ?? null,
			members: (d.updateMembers ?? []).map(m => ({ id: m.id, name: m.dName })),
			is_self: ev.isSelf
		})
		if (memberEvents.has(ev.type)) refreshGroupSoon(groupId)
	})
	l.on('error', err => logger.warn({ err: String(err) }, 'listener lỗi'))
	l.on('closed', (code, reason) => {
		logger.warn({ code, reason }, 'listener đóng, đăng nhập lại')
		// 3000 = đã có phiên Zalo Web khác giữ kết nối; chờ lâu hơn để không giành lại liên tục
		scheduleRestart(code === 3000 ? 60_000 : 5_000)
	})
	l.start({ retryOnClose: true })
}

// ---------- đăng nhập ----------

const scheduleRestart = (delay: number) => {
	status.state = 'reconnecting'
	api = null
	if (restartTimer) clearTimeout(restartTimer)
	restartTimer = setTimeout(() => void startZalo(), delay)
}

const onOpen = async (a: API) => {
	api = a
	status.state = 'open'
	status.qr = null
	status.scanned_as = null
	status.error = null
	const ownId = a.getOwnId()
	try {
		const { profile } = await a.fetchAccountInfo()
		saveUser(profile)
		status.me = { id: ownId, name: profile.displayName || profile.zaloName, avatar: profile.avatar, phone: profile.phoneNumber }
	} catch {
		status.me = { id: ownId }
	}
	logger.info({ me: status.me }, 'đã đăng nhập Zalo')
	emitEvent('connection', { state: 'open', me: status.me })
	attachListeners(a)
	void refreshFriends().catch(err => logger.warn({ err: (err as Error).message }, 'sync bạn bè lỗi'))
	void refreshGroups().catch(err => logger.warn({ err: (err as Error).message }, 'sync nhóm lỗi'))
}

export const startZalo = async (): Promise<void> => {
	if (starting) return
	starting = true
	try {
		fs.mkdirSync(config.mediaDir, { recursive: true })
		status.state = 'starting'
		const zalo = newZalo()
		const creds = readCreds()
		if (creds) {
			try {
				await onOpen(await zalo.login(creds))
				return
			} catch (err) {
				logger.warn({ err: (err as Error).message }, 'đăng nhập bằng phiên cũ thất bại, chuyển sang QR')
				clearCreds()
			}
		}
		status.state = 'qr'
		const a = await zalo.loginQR({}, ev => {
			switch (ev.type) {
				case LoginQRCallbackEventType.QRCodeGenerated:
					status.state = 'qr'
					status.qr = ev.data.image.startsWith('data:') ? ev.data.image : `data:image/png;base64,${ev.data.image}`
					abortQr = ev.actions.abort
					logger.info('QR Zalo sẵn sàng: mở /qr để quét')
					break
				case LoginQRCallbackEventType.QRCodeScanned:
					status.state = 'scanned'
					status.scanned_as = { name: ev.data.display_name, avatar: ev.data.avatar }
					break
				case LoginQRCallbackEventType.QRCodeExpired:
				case LoginQRCallbackEventType.QRCodeDeclined:
					status.state = 'qr'
					status.scanned_as = null
					ev.actions.retry()
					break
				case LoginQRCallbackEventType.GotLoginInfo:
					writeCreds({ imei: ev.data.imei, cookie: ev.data.cookie, userAgent: ev.data.userAgent })
					break
			}
		})
		await onOpen(a)
	} catch (err) {
		if (status.state === 'logged_out') return
		status.error = (err as Error).message
		logger.error({ err: (err as Error).message }, 'khởi động Zalo lỗi, thử lại sau 10s')
		scheduleRestart(10_000)
	} finally {
		starting = false
	}
}

export const logoutZalo = async () => {
	if (restartTimer) clearTimeout(restartTimer)
	abortQr?.()
	try {
		api?.listener.stop()
	} catch {
		/* listener chưa chạy */
	}
	api = null
	clearCreds()
	status.state = 'logged_out'
	status.me = null
	status.qr = null
	emitEvent('connection', { state: 'logged_out' })
}

/** Bắt đầu lại luồng đăng nhập (ví dụ sau logout) để sinh QR mới. */
export const relogin = () => {
	if (status.state === 'open') throw new Error('Đang đăng nhập rồi, hãy POST /logout trước')
	void startZalo()
}
