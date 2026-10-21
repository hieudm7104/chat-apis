import path from 'node:path'
import multipart from '@fastify/multipart'
import websocket from '@fastify/websocket'
import type { AnyMessageContent } from 'baileys'
import { config } from './config.js'
import { db } from './db.js'
import { addWebhook, bus, eventsSince, listWebhooks, removeWebhook } from './events.js'
import type { ApiEvent } from './events.js'
import { fromRaw, resolveIdentity, saveGroup } from './store.js'
import type { App } from './server.js'
import { getSock } from './wa.js'

const clampInt = (v: unknown, def: number, max: number) => Math.min(Math.max(parseInt(String(v ?? ''), 10) || def, 1), max)

const MIME: Record<string, string> = {
	'.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif',
	'.mp4': 'video/mp4', '.mov': 'video/quicktime', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4',
	'.pdf': 'application/pdf', '.txt': 'text/plain', '.json': 'application/json', '.zip': 'application/zip',
	'.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
	'.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
}
const mimeFor = (name: string) => MIME[path.extname(name).toLowerCase()] ?? 'application/octet-stream'

type FileIn = { data: Buffer; filename: string }

const loadFileSource = async (f: { url?: string; base64?: string; filename?: string }): Promise<FileIn> => {
	if (f.base64) {
		if (!f.filename) throw new Error('file base64 cần filename')
		return { data: Buffer.from(f.base64, 'base64'), filename: f.filename }
	}
	if (f.url) {
		const res = await fetch(f.url, { signal: AbortSignal.timeout(60_000) })
		if (!res.ok) throw new Error(`không tải được ${f.url}: HTTP ${res.status}`)
		return { data: Buffer.from(await res.arrayBuffer()), filename: f.filename ?? (path.basename(new URL(f.url).pathname) || 'file.bin') }
	}
	throw new Error('mỗi file cần url hoặc base64')
}

const quotedOf = (chat: string, id: string) => {
	const row = db.prepare('SELECT raw FROM messages WHERE chat_jid = ? AND id = ?').get(chat, id) as { raw: string } | undefined
	if (!row) throw new Error('không tìm thấy tin để trích dẫn')
	return fromRaw(row.raw)
}

const contentFor = (f: FileIn, caption: string | undefined, voice: boolean): AnyMessageContent => {
	const mimetype = mimeFor(f.filename)
	if (mimetype.startsWith('image/')) return { image: f.data, caption, mimetype }
	if (mimetype.startsWith('video/')) return { video: f.data, caption, mimetype }
	if (mimetype.startsWith('audio/')) return { audio: f.data, mimetype, ptt: voice }
	return { document: f.data, fileName: f.filename, mimetype, caption }
}

const NO_FRIENDS = { error: 'WhatsApp không có lời mời kết bạn; chỉ có danh bạ (GET /friends)' }

export const registerExtras = async (app: App) => {
	await app.register(multipart, { limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 10 } })
	await app.register(websocket)

	// ---- người dùng: tên từ id (nhận jid, lid hoặc số điện thoại) ----
	app.get<{ Querystring: { ids?: string } }>('/users', async req =>
		(req.query.ids ?? '').split(',').map(s => s.trim()).filter(Boolean).map(resolveIdentity)
	)

	app.get<{ Params: { id: string }; Querystring: { refresh?: string } }>('/users/:id', async (req, reply) => {
		const who = resolveIdentity(req.params.id)
		if (!who.known && !who.lid) return reply.code(404).send({ error: 'không có người dùng này' })
		if (req.query.refresh) {
			const avatar = await getSock().profilePictureUrl(who.id, 'preview').catch(() => null)
			if (avatar) {
				db.prepare('UPDATE contacts SET img_url = ? WHERE jid = ? OR lid = ?').run(avatar, who.jid ?? who.id, who.lid ?? who.id)
				who.avatar = avatar
			}
		}
		return who
	})

	// ---- bạn bè: WhatsApp chỉ có danh bạ ----
	app.get('/friends', async () =>
		db.prepare('SELECT jid, lid, phone_number, name AS display_name, notify, username, img_url AS avatar FROM contacts WHERE name IS NOT NULL ORDER BY name').all()
	)
	app.get('/friends/requests', async () => [])
	app.get('/friends/sent', async () => [])
	app.post('/friends/request', async (_req, reply) => reply.code(501).send(NO_FRIENDS))
	app.post('/friends/:id/accept', async (_req, reply) => reply.code(501).send(NO_FRIENDS))
	app.post('/friends/:id/reject', async (_req, reply) => reply.code(501).send(NO_FRIENDS))

	// ---- gửi file: multipart (chat_id|jid, text, quote_id, voice, file…) hoặc JSON {chat_id, text, files:[{url|base64, filename}]} ----
	app.post('/messages/send-file', async (req, reply) => {
		let chat: string | undefined
		let text: string | undefined
		let quoteId: string | undefined
		let voice = false
		const files: FileIn[] = []
		if (req.isMultipart()) {
			for await (const part of req.parts()) {
				if (part.type === 'file') files.push({ data: await part.toBuffer(), filename: part.filename || 'file.bin' })
				else if (part.fieldname === 'chat_id' || part.fieldname === 'jid') chat = String(part.value)
				else if (part.fieldname === 'text') text = String(part.value)
				else if (part.fieldname === 'quote_id') quoteId = String(part.value)
				else if (part.fieldname === 'voice') voice = ['1', 'true'].includes(String(part.value))
			}
		} else {
			const b = (req.body ?? {}) as { chat_id?: string; jid?: string; text?: string; quote_id?: string; voice?: boolean; files?: { url?: string; base64?: string; filename?: string }[] }
			chat = b.chat_id ?? b.jid
			text = b.text
			quoteId = b.quote_id
			voice = !!b.voice
			for (const f of b.files ?? []) files.push(await loadFileSource(f))
		}
		if (!chat || !files.length) return reply.code(400).send({ error: 'cần chat_id và ít nhất 1 file' })
		const sock = getSock()
		const quoted = quoteId ? quotedOf(chat, quoteId) : undefined
		const ids: string[] = []
		for (const [i, f] of files.entries()) {
			const sent = await sock.sendMessage(chat, contentFor(f, i === 0 ? text : undefined, voice), { quoted })
			if (sent?.key.id) ids.push(sent.key.id)
		}
		return { chat_id: chat, ids }
	})

	// ---- communities ----
	const communityRow = (id: string) =>
		db
			.prepare(
				`SELECT jid AS id, subject AS name, description, owner, owner_pn, size, creation, addressing_mode,
					(SELECT COUNT(*) FROM groups c WHERE c.linked_parent = g.jid AND COALESCE(json_extract(c.raw, '$.isCommunityAnnounce'), 0) = 0) AS group_count,
					(SELECT jid FROM groups c WHERE c.linked_parent = g.jid AND json_extract(c.raw, '$.isCommunityAnnounce') = 1 LIMIT 1) AS announce_group_id
				 FROM groups g WHERE jid = ? AND is_community = 1`
			)
			.get(id) as Record<string, unknown> | undefined

	const refreshCommunity = async (id: string) => {
		const sock = getSock()
		saveGroup(await sock.communityMetadata(id))
		const linked = await sock.communityFetchLinkedGroups(id)
		const upsert = db.prepare(
			`INSERT INTO groups (jid, subject, owner, creation, size, is_community, linked_parent, updated_at)
			 VALUES (?, ?, ?, ?, ?, 0, ?, ?)
			 ON CONFLICT (jid) DO UPDATE SET subject = excluded.subject, size = COALESCE(excluded.size, size),
				linked_parent = excluded.linked_parent, updated_at = excluded.updated_at`
		)
		for (const g of linked.linkedGroups) if (g.id) upsert.run(g.id, g.subject, g.owner ?? null, g.creation ?? null, g.size ?? null, id, Date.now())
	}

	app.get('/communities', async () =>
		(db.prepare('SELECT jid FROM groups WHERE is_community = 1 ORDER BY subject').all() as { jid: string }[]).map(r => communityRow(r.jid))
	)

	app.get<{ Params: { id: string }; Querystring: { refresh?: string } }>('/communities/:id', async (req, reply) => {
		if (req.query.refresh) await refreshCommunity(req.params.id)
		const c = communityRow(req.params.id)
		if (!c) return reply.code(404).send({ error: 'không có community này (thử ?refresh=1 hoặc POST /groups/refresh)' })
		return c
	})

	app.get<{ Params: { id: string }; Querystring: { refresh?: string } }>('/communities/:id/groups', async (req, reply) => {
		if (req.query.refresh) await refreshCommunity(req.params.id)
		if (!communityRow(req.params.id)) return reply.code(404).send({ error: 'không có community này' })
		return db
			.prepare(
				`SELECT jid AS id, subject AS name, owner, size, creation, announce,
					COALESCE(json_extract(raw, '$.isCommunityAnnounce'), 0) AS is_announce_group
				 FROM groups WHERE linked_parent = ? ORDER BY is_announce_group DESC, subject`
			)
			.all(req.params.id)
	})

	app.get<{ Params: { id: string }; Querystring: { refresh?: string } }>('/communities/:id/members', async (req, reply) => {
		if (req.query.refresh) await refreshCommunity(req.params.id)
		if (!communityRow(req.params.id)) return reply.code(404).send({ error: 'không có community này' })
		return db
			.prepare(
				`SELECT p.jid AS id, p.lid, p.phone_number, p.admin, COALESCE(c.name, c.notify) AS display_name, c.username
				 FROM group_participants p LEFT JOIN contacts c ON c.jid = p.jid WHERE p.group_jid = ?`
			)
			.all(req.params.id)
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
}
