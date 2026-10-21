import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import multipart from '@fastify/multipart'
import websocket from '@fastify/websocket'
import Fastify from 'fastify'
import { ThreadType } from 'zca-js'
import { config } from './config.js'
import { db } from './db.js'
import { addWebhook, bus, eventsSince, listWebhooks, logger, removeWebhook } from './events.js'
import type { ApiEvent } from './events.js'
import { publicMessage, saveFriendRequest, saveMessage, saveUser } from './store.js'
import { clampInt, safe } from './util.js'
import {
	downloadMedia,
	ensureUsers,
	fillMissingProfiles,
	getApi,
	logoutZalo,
	mediaMime,
	refreshFriends,
	refreshGroup,
	refreshGroups,
	relogin,
	sendToChat,
	status
} from './zalo.js'
import type { SendFile } from './zalo.js'

const keyOk = (given: string | undefined) => {
	if (!given || !config.apiKey) return false
	const a = Buffer.from(given)
	const b = Buffer.from(config.apiKey)
	return a.length === b.length && crypto.timingSafeEqual(a, b)
}

const USER_COLS = 'id, display_name, zalo_name, username, phone, avatar, is_friend, updated_at'

const loadFileSource = async (f: { url?: string; base64?: string; filename?: string }): Promise<SendFile> => {
	if (f.base64) {
		if (!f.filename) throw new Error('file base64 cần filename')
		return { data: Buffer.from(f.base64, 'base64'), filename: f.filename }
	}
	if (f.url) {
		const res = await fetch(f.url, { signal: AbortSignal.timeout(60_000) })
		if (!res.ok) throw new Error(`không tải được ${f.url}: HTTP ${res.status}`)
		const name = f.filename ?? (path.basename(new URL(f.url).pathname) || 'file.bin')
		return { data: Buffer.from(await res.arrayBuffer()), filename: name }
	}
	throw new Error('mỗi file cần url hoặc base64')
}

export const buildServer = async () => {
	const app = Fastify({ loggerInstance: logger, bodyLimit: config.maxUploadMb * 1.4 * 1024 * 1024 })
	await app.register(multipart, { limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 10 } })
	await app.register(websocket)

	app.addHook('onRequest', async (req, reply) => {
		if (req.url === '/health') return
		const auth = req.headers.authorization?.replace(/^Bearer\s+/i, '')
		const queryKey = (req.query as { key?: string } | undefined)?.key
		const given = (req.headers['x-api-key'] as string | undefined) ?? auth ?? queryKey
		if (!keyOk(given)) return reply.code(401).send({ error: 'unauthorized' })
	})

	app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
		const code = err.statusCode ?? (/chưa đăng nhập/.test(err.message) ? 503 : 502)
		if (code >= 500) logger.warn({ err: err.message }, 'request lỗi')
		reply.code(code).send({ error: err.message })
	})

	app.get('/health', async () => ({ ok: true }))

	// ---- phiên đăng nhập ----
	app.get('/status', async () => ({ ...status, qr: status.qr ? 'available' : null }))

	app.get('/qr', async (req, reply) => {
		const key = encodeURIComponent((req.query as { key?: string }).key ?? '')
		let body: string
		if (status.state === 'open') body = `<p>Đã đăng nhập: ${status.me?.name ?? status.me?.id}</p>`
		else if (status.state === 'scanned') body = `<p>${status.scanned_as?.name ?? ''} đã quét. Hãy bấm xác nhận trên điện thoại.</p>`
		else if (status.qr) body = `<img src="${status.qr}" width="300" height="300"><p>Zalo → biểu tượng QR (góc trên) → Quét mã QR</p>`
		else if (status.state === 'logged_out') body = `<p>Đã đăng xuất. POST /login?key=${key} để lấy QR mới.</p>`
		else body = '<p>Đang chờ QR… (trang tự tải lại)</p>'
		return reply
			.type('text/html')
			.send(`<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="3"><title>Zalo login</title><body style="font-family:sans-serif;text-align:center;padding:2em">${body}</body>`)
	})

	app.post('/login', async (_req, reply) => {
		try {
			relogin()
			return { ok: true }
		} catch (err) {
			return reply.code(409).send({ error: (err as Error).message })
		}
	})

	app.post('/logout', async () => {
		await logoutZalo()
		return { ok: true }
	})

	app.get('/me', async () => status.me)

	// ---- người dùng: tên từ id ----
	app.get<{ Querystring: { ids?: string; refresh?: string } }>('/users', async req => {
		const ids = (req.query.ids ?? '').split(',').map(s => s.trim()).filter(Boolean)
		if (!ids.length) return []
		const sel = db.prepare(`SELECT ${USER_COLS} FROM users WHERE id = ?`)
		const missing = req.query.refresh ? ids : ids.filter(id => !sel.get(id))
		if (missing.length) await ensureUsers(missing).catch(() => undefined)
		return ids.map(id => sel.get(id) ?? { id, display_name: null })
	})

	app.get<{ Querystring: { phone?: string; username?: string } }>('/users/search', async (req, reply) => {
		const a = getApi()
		if (req.query.phone) {
			const u = await a.findUser(req.query.phone)
			return { id: u.uid, display_name: u.display_name, zalo_name: u.zalo_name, avatar: u.avatar }
		}
		if (req.query.username) {
			const u = await a.findUserByUsername(req.query.username)
			return u
		}
		return reply.code(400).send({ error: 'cần phone hoặc username' })
	})

	app.get<{ Params: { id: string }; Querystring: { refresh?: string } }>('/users/:id', async (req, reply) => {
		const sel = () => db.prepare(`SELECT ${USER_COLS} FROM users WHERE id = ?`).get(req.params.id) as Record<string, unknown> | undefined
		let u = sel()
		if (!u || req.query.refresh || !u.display_name) {
			await ensureUsers([req.params.id]).catch(() => undefined)
			u = sel()
		}
		if (!u) return reply.code(404).send({ error: 'không có người dùng này' })
		return u
	})

	// ---- chat và tin nhắn ----
	app.get('/chats', async req => {
		const q = req.query as Record<string, string>
		return db
			.prepare(
				`SELECT c.id, c.type, COALESCE(g.name, u.display_name, c.name) AS name, c.last_ts,
					(SELECT COUNT(*) FROM messages m WHERE m.chat_id = c.id) AS stored_messages
				 FROM chats c LEFT JOIN groups g ON g.id = c.id AND c.type = 'group' LEFT JOIN users u ON u.id = c.id AND c.type = 'user'
				 ORDER BY c.last_ts DESC LIMIT ? OFFSET ?`
			)
			.all(clampInt(q.limit, 100, 1000), Math.max(parseInt(q.offset ?? '0', 10) || 0, 0))
	})

	app.get<{ Params: { id: string }; Querystring: Record<string, string> }>('/chats/:id/messages', async req => {
		const q = req.query
		const where = ['chat_id = @id']
		const p: Record<string, unknown> = { id: req.params.id, limit: clampInt(q.limit, 50, 1000) }
		if (q.before) { where.push('timestamp < @before'); p.before = Number(q.before) }
		if (q.after) { where.push('timestamp > @after'); p.after = Number(q.after) }
		if (q.sender) { where.push('sender_id = @sender'); p.sender = q.sender }
		if (q.kind) { where.push('kind = @kind'); p.kind = q.kind }
		if (q.q) { where.push('text LIKE @q'); p.q = `%${q.q}%` }
		const rows = db
			.prepare(
				`SELECT chat_id, chat_type, id, cli_msg_id, from_me, sender_id, sender_name, timestamp, type, kind, text, attachment, media_path, quote, deleted
				 FROM messages WHERE ${where.join(' AND ')} ORDER BY timestamp DESC LIMIT @limit`
			)
			.all(p) as Record<string, unknown>[]
		return rows.map(publicMessage)
	})

	app.get<{ Params: { chat: string; id: string }; Querystring: { raw?: string } }>('/messages/:chat/:id', async (req, reply) => {
		const row = db.prepare('SELECT * FROM messages WHERE chat_id = ? AND id = ?').get(req.params.chat, req.params.id) as
			| (Record<string, unknown> & { raw: string })
			| undefined
		if (!row) return reply.code(404).send({ error: 'không có tin này' })
		const { raw, ...rest } = row
		const out = publicMessage(rest)
		return req.query.raw ? { ...out, raw: JSON.parse(raw) } : out
	})

	app.get<{ Params: { chat: string; id: string } }>('/messages/:chat/:id/media', async (req, reply) => {
		const exists = db.prepare('SELECT attachment FROM messages WHERE chat_id = ? AND id = ?').get(req.params.chat, req.params.id) as
			| { attachment: string | null }
			| undefined
		if (!exists) return reply.code(404).send({ error: 'không có tin này' })
		if (!exists.attachment) return reply.code(404).send({ error: 'tin này không có file đính kèm' })
		let rel: string | null
		try {
			rel = await downloadMedia(req.params.chat, req.params.id)
		} catch (err) {
			return reply.code(502).send({ error: 'tải file thất bại (link có thể đã hết hạn)', detail: (err as Error).message })
		}
		if (!rel) return reply.code(404).send({ error: 'không có file để tải' })
		const abs = path.join(config.mediaDir, rel)
		const base = path.basename(rel).replace(/^[^_]*_/, '')
		return reply
			.type(mediaMime(abs))
			.header('content-disposition', `inline; filename*=UTF-8''${encodeURIComponent(base)}`)
			.send(fs.createReadStream(abs))
	})

	app.post('/messages/send', async (req, reply) => {
		const b = (req.body ?? {}) as { chat_id?: string; text?: string; chat_type?: 'user' | 'group'; quote_id?: string; mentions?: { uid: string; pos: number; len: number }[] }
		if (!b.chat_id || !b.text) return reply.code(400).send({ error: 'cần chat_id và text' })
		return sendToChat(b.chat_id, { text: b.text, type: b.chat_type, quoteId: b.quote_id, mentions: b.mentions })
	})

	// multipart: chat_id, text (chú thích), chat_type, quote_id + 1..10 phần file; hoặc JSON {chat_id, text, files:[{url|base64, filename}]}
	app.post('/messages/send-file', async (req, reply) => {
		let chatId: string | undefined
		let text: string | undefined
		let type: 'user' | 'group' | undefined
		let quoteId: string | undefined
		const files: SendFile[] = []
		if (req.isMultipart()) {
			for await (const part of req.parts()) {
				if (part.type === 'file') files.push({ data: await part.toBuffer(), filename: safe(part.filename || 'file.bin') })
				else if (part.fieldname === 'chat_id') chatId = String(part.value)
				else if (part.fieldname === 'text') text = String(part.value)
				else if (part.fieldname === 'chat_type') type = part.value === 'group' ? 'group' : 'user'
				else if (part.fieldname === 'quote_id') quoteId = String(part.value)
			}
		} else {
			const b = (req.body ?? {}) as { chat_id?: string; text?: string; chat_type?: 'user' | 'group'; quote_id?: string; files?: { url?: string; base64?: string; filename?: string }[] }
			chatId = b.chat_id
			text = b.text
			type = b.chat_type
			quoteId = b.quote_id
			for (const f of b.files ?? []) files.push(await loadFileSource(f))
		}
		if (!chatId || !files.length) return reply.code(400).send({ error: 'cần chat_id và ít nhất 1 file' })
		return sendToChat(chatId, { text, type, quoteId, files })
	})

	// nhóm: lấy thêm tin cũ từ máy chủ Zalo; chat 1:1 chỉ nhận được qua sự kiện old_messages
	app.post<{ Params: { id: string }; Body: { count?: number } }>('/chats/:id/fetch-history', async (req, reply) => {
		const a = getApi()
		const isGroup = !!db.prepare('SELECT 1 FROM groups WHERE id = ?').get(req.params.id)
		if (isGroup) {
			const res = await a.getGroupChatHistory(req.params.id, clampInt(req.body?.count, 50, 200))
			let saved = 0
			for (const m of res.groupMsgs) if (saveMessage(m)) saved++
			return { fetched: res.groupMsgs.length, saved, more: !!res.more }
		}
		a.listener.requestOldMessages(ThreadType.User)
		return { requested: true, note: 'tin cũ của chat 1:1 về qua sự kiện old_messages, xem lại /chats/:id/messages sau vài giây' }
	})

	// ---- nhóm ----
	app.get('/groups', async () =>
		db.prepare('SELECT id, name, description, creator_id, avatar, total_member, created_time FROM groups ORDER BY name').all()
	)

	app.post('/groups/refresh', async () => ({ ok: true, groups: await refreshGroups() }))

	app.get<{ Params: { id: string }; Querystring: { refresh?: string } }>('/groups/:id', async (req, reply) => {
		if (req.query.refresh) await refreshGroup(req.params.id)
		const g = db.prepare('SELECT id, name, description, creator_id, avatar, total_member, created_time FROM groups WHERE id = ?').get(req.params.id) as
			| Record<string, unknown>
			| undefined
		if (!g) return reply.code(404).send({ error: 'không có nhóm này (thử ?refresh=1 hoặc POST /groups/refresh)' })
		const lacking = db
			.prepare('SELECT m.user_id AS id FROM group_members m LEFT JOIN users u ON u.id = m.user_id WHERE m.group_id = ? AND u.display_name IS NULL')
			.all(req.params.id) as { id: string }[]
		if (lacking.length) await fillMissingProfiles(lacking.map(r => r.id)).catch(() => undefined)
		const members = db
			.prepare(
				`SELECT m.user_id AS id, m.role, u.display_name, u.zalo_name, u.avatar, u.is_friend
				 FROM group_members m LEFT JOIN users u ON u.id = m.user_id WHERE m.group_id = ?
				 ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, u.display_name`
			)
			.all(req.params.id)
		return { ...g, members }
	})

	// ---- bạn bè ----
	app.get<{ Querystring: { refresh?: string; q?: string } }>('/friends', async req => {
		if (req.query.refresh) await refreshFriends()
		if (req.query.q) {
			const like = `%${req.query.q}%`
			return db.prepare(`SELECT ${USER_COLS} FROM users WHERE is_friend = 1 AND (display_name LIKE ? OR zalo_name LIKE ? OR phone LIKE ?) ORDER BY display_name`).all(like, like, like)
		}
		return db.prepare(`SELECT ${USER_COLS} FROM users WHERE is_friend = 1 ORDER BY display_name`).all()
	})

	// Zalo không có API liệt kê lời mời đã nhận: chỉ có các lời mời bắt được qua sự kiện realtime khi service đang chạy
	app.get<{ Querystring: { status?: string; direction?: string } }>('/friends/requests', async req => {
		const where: string[] = []
		const p: string[] = []
		const st = req.query.status ?? 'pending'
		if (st !== 'all') { where.push('r.status = ?'); p.push(st) }
		if (req.query.direction) { where.push('r.direction = ?'); p.push(req.query.direction) }
		return db
			.prepare(
				`SELECT r.user_id, r.direction, r.message, r.status, r.created_at, r.updated_at, u.display_name, u.zalo_name, u.avatar
				 FROM friend_requests r LEFT JOIN users u ON u.id = r.user_id
				 ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY r.updated_at DESC`
			)
			.all(...p)
	})

	app.get('/friends/sent', async () => {
		const res = await getApi().getSentFriendRequest()
		return Object.values(res).map(r => ({ user_id: r.userId, display_name: r.displayName, zalo_name: r.zaloName, avatar: r.avatar, message: r.fReqInfo?.message, time: r.fReqInfo?.time }))
	})

	app.post('/friends/request', async (req, reply) => {
		const b = (req.body ?? {}) as { user_id?: string; message?: string }
		if (!b.user_id) return reply.code(400).send({ error: 'cần user_id' })
		await getApi().sendFriendRequest(b.message ?? 'Xin chào, mình kết bạn nhé', b.user_id)
		saveFriendRequest(b.user_id, 'outgoing', 'pending', b.message)
		return { ok: true }
	})

	app.get<{ Params: { id: string } }>('/friends/:id/status', async req => getApi().getFriendRequestStatus(req.params.id))

	app.post<{ Params: { id: string } }>('/friends/:id/accept', async req => {
		await getApi().acceptFriendRequest(req.params.id)
		saveFriendRequest(req.params.id, 'incoming', 'accepted')
		await ensureUsers([req.params.id]).catch(() => undefined)
		saveUser({ userId: req.params.id }, true)
		return { ok: true }
	})

	app.post<{ Params: { id: string } }>('/friends/:id/reject', async req => {
		await getApi().rejectFriendRequest(req.params.id)
		saveFriendRequest(req.params.id, 'incoming', 'rejected')
		return { ok: true }
	})

	app.delete<{ Params: { id: string } }>('/friends/request/:id', async req => {
		await getApi().undoFriendRequest(req.params.id)
		saveFriendRequest(req.params.id, 'outgoing', 'canceled')
		return { ok: true }
	})

	app.delete<{ Params: { id: string } }>('/friends/:id', async req => {
		await getApi().removeFriend(req.params.id)
		saveUser({ userId: req.params.id }, false)
		return { ok: true }
	})

	// ---- realtime ----
	app.get<{ Querystring: { after_id?: string; limit?: string } }>('/events', async req =>
		eventsSince(Math.max(parseInt(req.query.after_id ?? '0', 10) || 0, 0), clampInt(req.query.limit, 100, 1000))
	)

	app.post('/webhooks', async (req, reply) => {
		const b = (req.body ?? {}) as { url?: string; secret?: string; events?: string[] }
		if (!b.url || !/^https?:\/\//.test(b.url)) return reply.code(400).send({ error: 'cần url http(s)' })
		return { id: addWebhook(b.url, b.secret, b.events) }
	})
	app.get('/webhooks', async () => listWebhooks())
	app.delete<{ Params: { id: string } }>('/webhooks/:id', async (req, reply) =>
		removeWebhook(req.params.id) ? { ok: true } : reply.code(404).send({ error: 'không có webhook này' })
	)

	// ws://host/ws?key=...&after_id=123  (after_id để nhận bù các sự kiện đã lỡ)
	app.get<{ Querystring: { after_id?: string; types?: string } }>('/ws', { websocket: true }, (socket, req) => {
		const types = req.query.types ? new Set(req.query.types.split(',')) : null
		const send = (ev: ApiEvent) => {
			if (socket.readyState === socket.OPEN && (!types || types.has(ev.type))) socket.send(JSON.stringify(ev))
		}
		if (req.query.after_id) for (const ev of eventsSince(Number(req.query.after_id) || 0, 1000)) send(ev)
		bus.on('event', send)
		const ping = setInterval(() => socket.readyState === socket.OPEN && socket.ping(), 30_000)
		socket.on('close', () => {
			bus.off('event', send)
			clearInterval(ping)
		})
	})

	return app
}
