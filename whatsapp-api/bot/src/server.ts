import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import Fastify from 'fastify'
import QRCode from 'qrcode'
import { config } from './config.js'
import { db } from './db.js'
import { downloadAndSaveMedia, getSock, logger, logoutWhatsApp, refreshGroups, requestPairingCode, status } from './wa.js'
import { fromRaw } from './store.js'
import { saveGroup } from './store.js'
import { registerExtras } from './extras.js'

const MIME: Record<string, string> = {
	'.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif',
	'.mp4': 'video/mp4', '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.pdf': 'application/pdf'
}

const clampInt = (v: unknown, def: number, max: number) => Math.min(Math.max(parseInt(String(v ?? ''), 10) || def, 1), max)

const keyOk = (given: string | undefined) => {
	if (!given || !config.apiKey) return false
	const a = Buffer.from(given)
	const b = Buffer.from(config.apiKey)
	return a.length === b.length && crypto.timingSafeEqual(a, b)
}

const createApp = () => Fastify({ loggerInstance: logger })
export type App = ReturnType<typeof createApp>

export const buildServer = async () => {
	const app = createApp()

	app.addHook('onRequest', async (req, reply) => {
		if (req.url === '/health') return
		const auth = req.headers.authorization?.replace(/^Bearer\s+/i, '')
		const queryKey = (req.query as { key?: string } | undefined)?.key
		const given = (req.headers['x-api-key'] as string | undefined) ?? auth ?? queryKey
		if (!keyOk(given)) return reply.code(401).send({ error: 'unauthorized' })
	})

	app.get('/health', async () => ({ ok: true }))

	// ---- đăng nhập ----
	app.get('/status', async () => ({ ...status, qr: status.qr ? 'available' : null }))

	app.get('/qr.png', async (_req, reply) => {
		if (!status.qr) return reply.code(404).send({ error: 'không có QR (đã đăng nhập hoặc chưa sẵn sàng)' })
		return reply.type('image/png').send(await QRCode.toBuffer(status.qr, { width: 320 }))
	})

	app.get('/qr', async (req, reply) => {
		const key = encodeURIComponent((req.query as { key?: string }).key ?? '')
		const body = status.qr
			? `<img src="/qr.png?key=${key}&t=${Date.now()}" width="320" height="320"><p>WhatsApp → Thiết bị đã liên kết → Liên kết thiết bị</p>`
			: `<p>${status.registered ? 'Đã đăng nhập: ' + (status.me?.name ?? status.me?.id ?? '') : 'Đang chờ QR… (trang tự tải lại)'}</p>`
		return reply
			.type('text/html')
			.send(`<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="5"><title>Pair</title><body style="font-family:sans-serif;text-align:center;padding:2em">${body}</body>`)
	})

	app.post('/pairing-code', async (req, reply) => {
		const phone = (req.body as { phone?: string } | undefined)?.phone
		if (!phone) return reply.code(400).send({ error: 'thiếu phone (dạng 84xxxxxxxxx)' })
		try {
			return { code: await requestPairingCode(phone) }
		} catch (err) {
			return reply.code(409).send({ error: (err as Error).message })
		}
	})

	app.post('/logout', async () => {
		await logoutWhatsApp()
		return { ok: true }
	})

	// ---- dữ liệu ----
	app.get('/me', async () => status.me)

	app.get('/chats', async req => {
		const q = req.query as Record<string, string>
		const limit = clampInt(q.limit, 100, 1000)
		const offset = Math.max(parseInt(q.offset ?? '0', 10) || 0, 0)
		return db
			.prepare(
				`SELECT c.jid, c.name, c.unread_count, c.conversation_ts,
					(SELECT COUNT(*) FROM messages m WHERE m.chat_jid = c.jid) AS stored_messages
				 FROM chats c ORDER BY c.conversation_ts DESC LIMIT ? OFFSET ?`
			)
			.all(limit, offset)
	})

	app.get('/contacts', async req => {
		const q = req.query as Record<string, string>
		const limit = clampInt(q.limit, 200, 5000)
		if (q.q) {
			const like = `%${q.q}%`
			return db
				.prepare('SELECT * FROM contacts WHERE name LIKE ? OR notify LIKE ? OR jid LIKE ? OR phone_number LIKE ? LIMIT ?')
				.all(like, like, like, like, limit)
		}
		return db.prepare('SELECT * FROM contacts ORDER BY updated_at DESC LIMIT ?').all(limit)
	})

	app.get('/lid-map', async () => db.prepare('SELECT lid, pn FROM lid_map').all())

	app.get('/groups', async () => db.prepare('SELECT jid, subject, owner, owner_pn, creation, size, announce, restrict, is_community, linked_parent FROM groups ORDER BY subject').all())

	app.get<{ Params: { jid: string }; Querystring: { refresh?: string } }>('/groups/:jid', async (req, reply) => {
		if (req.query.refresh) saveGroup(await getSock().groupMetadata(req.params.jid))
		const group = db.prepare('SELECT * FROM groups WHERE jid = ?').get(req.params.jid) as Record<string, unknown> | undefined
		if (!group) return reply.code(404).send({ error: 'không có group này' })
		delete group.raw
		const participants = db
			.prepare(
				`SELECT p.jid, p.lid, p.phone_number, p.admin, c.name, c.notify, c.username
				 FROM group_participants p LEFT JOIN contacts c ON c.jid = p.jid WHERE p.group_jid = ?`
			)
			.all(req.params.jid)
		return { ...group, participants }
	})

	app.post('/groups/refresh', async () => {
		await refreshGroups()
		return { ok: true }
	})

	app.get<{ Params: { jid: string }; Querystring: Record<string, string> }>('/chats/:jid/messages', async req => {
		const { jid } = req.params
		const q = req.query
		const where = ['chat_jid = @jid']
		const p: Record<string, unknown> = { jid, limit: clampInt(q.limit, 50, 1000) }
		if (q.before) { where.push('timestamp < @before'); p.before = Number(q.before) }
		if (q.after) { where.push('timestamp > @after'); p.after = Number(q.after) }
		if (q.sender) { where.push('(sender_jid = @sender OR sender_alt = @sender)'); p.sender = q.sender }
		if (q.q) { where.push('text LIKE @q'); p.q = `%${q.q}%` }
		const rows = db
			.prepare(
				`SELECT chat_jid, id, from_me, sender_jid, sender_alt, push_name, timestamp, type, text, media_path, deleted
				 FROM messages WHERE ${where.join(' AND ')} ORDER BY timestamp DESC LIMIT @limit`
			)
			.all(p)
		return rows
	})

	app.get<{ Params: { chat: string; id: string }; Querystring: { raw?: string } }>('/messages/:chat/:id', async (req, reply) => {
		const row = db.prepare('SELECT * FROM messages WHERE chat_jid = ? AND id = ?').get(req.params.chat, req.params.id) as
			| (Record<string, unknown> & { raw: string })
			| undefined
		if (!row) return reply.code(404).send({ error: 'không có tin này' })
		const { raw, ...rest } = row
		return req.query.raw ? { ...rest, raw: JSON.parse(raw) } : rest
	})

	app.get<{ Params: { chat: string; id: string } }>('/messages/:chat/:id/media', async (req, reply) => {
		const row = db.prepare('SELECT raw, media_path FROM messages WHERE chat_jid = ? AND id = ?').get(req.params.chat, req.params.id) as
			| { raw: string; media_path: string | null }
			| undefined
		if (!row) return reply.code(404).send({ error: 'không có tin này' })
		let rel = row.media_path
		if (!rel) {
			try {
				rel = await downloadAndSaveMedia(fromRaw(row.raw))
			} catch (err) {
				return reply.code(502).send({ error: 'tải media thất bại (link có thể đã hết hạn)', detail: (err as Error).message })
			}
		}
		if (!rel) return reply.code(404).send({ error: 'tin này không có media' })
		const abs = path.join(config.mediaDir, rel)
		return reply.type(MIME[path.extname(abs).toLowerCase()] ?? 'application/octet-stream').send(fs.createReadStream(abs))
	})

	app.get<{ Params: { jid: string }; Querystring: { type?: string } }>('/profile-picture/:jid', async req => {
		const url = await getSock().profilePictureUrl(req.params.jid, req.query.type === 'image' ? 'image' : 'preview').catch(() => null)
		return { jid: req.params.jid, url: url ?? null }
	})

	// ---- hành động ----
	app.post('/messages/send', async (req, reply) => {
		const b = (req.body ?? {}) as { jid?: string; chat_id?: string; text?: string; quote_id?: string; mentions?: string[] }
		const jid = b.chat_id ?? b.jid
		if (!jid || !b.text) return reply.code(400).send({ error: 'cần chat_id (hoặc jid) và text' })
		let quoted
		if (b.quote_id) {
			const row = db.prepare('SELECT raw FROM messages WHERE chat_jid = ? AND id = ?').get(jid, b.quote_id) as { raw: string } | undefined
			if (!row) return reply.code(404).send({ error: 'không tìm thấy tin để trích dẫn' })
			quoted = fromRaw(row.raw)
		}
		const sent = await getSock().sendMessage(jid, { text: b.text, mentions: b.mentions }, { quoted })
		return { chat_id: jid, id: sent?.key.id }
	})

	// xin điện thoại gửi thêm tin cũ hơn tin cũ nhất đang lưu; kết quả về qua history sync (vào DB)
	app.post<{ Params: { jid: string }; Body: { count?: number } }>('/chats/:jid/fetch-history', async (req, reply) => {
		const oldest = db
			.prepare('SELECT id, from_me, timestamp FROM messages WHERE chat_jid = ? AND timestamp IS NOT NULL ORDER BY timestamp ASC LIMIT 1')
			.get(req.params.jid) as { id: string; from_me: number; timestamp: number } | undefined
		if (!oldest) return reply.code(404).send({ error: 'chưa có tin nào của chat này để làm mốc' })
		const count = clampInt(req.body?.count, 50, 50)
		const requestId = await getSock().fetchMessageHistory(
			count,
			{ remoteJid: req.params.jid, id: oldest.id, fromMe: !!oldest.from_me },
			oldest.timestamp
		)
		return { requested: count, requestId, note: 'điện thoại chính phải online; tin về qua event, xem lại /chats/:jid/messages sau vài giây' }
	})

	await registerExtras(app)

	return app
}
