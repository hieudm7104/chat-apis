import { BufferJSON, extractMessageContent, getContentType, toNumber } from 'baileys'
import type { Chat, Contact, GroupMetadata, WAMessage } from 'baileys'
import { db } from './db.js'

const MEDIA_TYPES = ['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage', 'ptvMessage']

export const isMediaType = (type: string | undefined | null) => !!type && MEDIA_TYPES.includes(type)

export const toRaw = (msg: WAMessage) => JSON.stringify(msg, BufferJSON.replacer)
export const fromRaw = (raw: string): WAMessage => JSON.parse(raw, BufferJSON.reviver)

const upsertMessageStmt = db.prepare(`
INSERT INTO messages (chat_jid, id, from_me, sender_jid, sender_alt, push_name, timestamp, type, text, raw)
VALUES (@chat_jid, @id, @from_me, @sender_jid, @sender_alt, @push_name, @timestamp, @type, @text, @raw)
ON CONFLICT (chat_jid, id, from_me) DO UPDATE SET
	sender_jid = COALESCE(excluded.sender_jid, sender_jid),
	sender_alt = COALESCE(excluded.sender_alt, sender_alt),
	push_name  = COALESCE(excluded.push_name, push_name),
	timestamp  = COALESCE(excluded.timestamp, timestamp),
	type       = COALESCE(excluded.type, type),
	text       = COALESCE(excluded.text, text),
	raw        = excluded.raw
`)

export const describeMessage = (msg: WAMessage) => {
	const content = extractMessageContent(msg.message)
	const type = getContentType(content) ?? (msg.messageStubType ? 'stub' : null)
	const text =
		content?.conversation ??
		content?.extendedTextMessage?.text ??
		content?.imageMessage?.caption ??
		content?.videoMessage?.caption ??
		content?.documentMessage?.caption ??
		null
	return { content, type, text }
}

export const saveMessage = (msg: WAMessage) => {
	const chat = msg.key.remoteJid
	if (!chat || !msg.key.id) return null
	const { type, text } = describeMessage(msg)
	const fromMe = msg.key.fromMe ? 1 : 0
	const isGroup = chat.endsWith('@g.us')
	upsertMessageStmt.run({
		chat_jid: chat,
		id: msg.key.id,
		from_me: fromMe,
		sender_jid: isGroup ? (msg.key.participant ?? null) : fromMe ? null : chat,
		sender_alt: isGroup ? (msg.key.participantAlt ?? null) : (msg.key.remoteJidAlt ?? null),
		push_name: msg.pushName ?? null,
		timestamp: msg.messageTimestamp ? toNumber(msg.messageTimestamp as number) : null,
		type,
		text,
		raw: toRaw(msg)
	})
	return { chat, id: msg.key.id, fromMe, type }
}

export const setMediaPath = (chat: string, id: string, fromMe: number, mediaPath: string) =>
	db
		.prepare('UPDATE messages SET media_path = ? WHERE chat_jid = ? AND id = ? AND from_me = ?')
		.run(mediaPath, chat, id, fromMe)

export const markDeleted = (chat: string, id: string) =>
	db.prepare('UPDATE messages SET deleted = 1 WHERE chat_jid = ? AND id = ?').run(chat, id)

const upsertChatStmt = db.prepare(`
INSERT INTO chats (jid, name, unread_count, conversation_ts, raw)
VALUES (@jid, @name, @unread_count, @conversation_ts, @raw)
ON CONFLICT (jid) DO UPDATE SET
	name = COALESCE(excluded.name, name),
	unread_count = COALESCE(excluded.unread_count, unread_count),
	conversation_ts = COALESCE(excluded.conversation_ts, conversation_ts),
	raw = excluded.raw
`)

export const saveChat = (chat: Partial<Chat>) => {
	if (!chat.id) return
	// tránh lưu hàng nghìn tin nhắn lồng bên trong object chat (đã lưu riêng ở bảng messages)
	const { messages: _messages, ...rest } = chat
	upsertChatStmt.run({
		jid: chat.id,
		name: chat.name ?? null,
		unread_count: chat.unreadCount ?? null,
		conversation_ts: chat.conversationTimestamp ? toNumber(chat.conversationTimestamp as number) : null,
		raw: JSON.stringify(rest, BufferJSON.replacer)
	})
}

const upsertContactStmt = db.prepare(`
INSERT INTO contacts (jid, lid, phone_number, name, notify, verified_name, username, img_url, status, updated_at)
VALUES (@jid, @lid, @phone_number, @name, @notify, @verified_name, @username, @img_url, @status, @updated_at)
ON CONFLICT (jid) DO UPDATE SET
	lid = COALESCE(excluded.lid, lid),
	phone_number = COALESCE(excluded.phone_number, phone_number),
	name = COALESCE(excluded.name, name),
	notify = COALESCE(excluded.notify, notify),
	verified_name = COALESCE(excluded.verified_name, verified_name),
	username = COALESCE(excluded.username, username),
	img_url = COALESCE(excluded.img_url, img_url),
	status = COALESCE(excluded.status, status),
	updated_at = excluded.updated_at
`)

export const saveContact = (c: Partial<Contact>) => {
	if (!c.id) return
	upsertContactStmt.run({
		jid: c.id,
		lid: c.lid ?? (c.id.endsWith('@lid') ? c.id : null),
		phone_number: c.phoneNumber ?? (c.id.endsWith('@s.whatsapp.net') ? c.id : null),
		name: c.name ?? null,
		notify: c.notify ?? null,
		verified_name: c.verifiedName ?? null,
		username: c.username ?? null,
		img_url: c.imgUrl ?? null,
		status: c.status ?? null,
		updated_at: Date.now()
	})
}

export const saveLidMapping = (lid: string, pn: string) =>
	db.prepare('INSERT INTO lid_map (lid, pn) VALUES (?, ?) ON CONFLICT (lid) DO UPDATE SET pn = excluded.pn').run(lid, pn)

export const saveGroup = db.transaction((g: GroupMetadata) => {
	db.prepare(
		`INSERT INTO groups (jid, subject, owner, owner_pn, creation, description, announce, restrict, size,
			addressing_mode, is_community, linked_parent, raw, updated_at)
		VALUES (@jid, @subject, @owner, @owner_pn, @creation, @description, @announce, @restrict, @size,
			@addressing_mode, @is_community, @linked_parent, @raw, @updated_at)
		ON CONFLICT (jid) DO UPDATE SET
			subject = excluded.subject, owner = excluded.owner, owner_pn = excluded.owner_pn,
			creation = excluded.creation, description = excluded.description, announce = excluded.announce,
			restrict = excluded.restrict, size = excluded.size, addressing_mode = excluded.addressing_mode,
			is_community = excluded.is_community, linked_parent = excluded.linked_parent,
			raw = excluded.raw, updated_at = excluded.updated_at`
	).run({
		jid: g.id,
		subject: g.subject ?? null,
		owner: g.owner ?? null,
		owner_pn: g.ownerPn ?? null,
		creation: g.creation ?? null,
		description: g.desc ?? null,
		announce: g.announce ? 1 : 0,
		restrict: g.restrict ? 1 : 0,
		size: g.size ?? g.participants?.length ?? null,
		addressing_mode: g.addressingMode ?? null,
		is_community: g.isCommunity ? 1 : 0,
		linked_parent: g.linkedParent ?? null,
		raw: JSON.stringify(g, BufferJSON.replacer),
		updated_at: Date.now()
	})
	db.prepare('DELETE FROM group_participants WHERE group_jid = ?').run(g.id)
	const ins = db.prepare(
		'INSERT OR REPLACE INTO group_participants (group_jid, jid, lid, phone_number, admin) VALUES (?, ?, ?, ?, ?)'
	)
	for (const p of g.participants ?? []) {
		ins.run(g.id, p.id, p.lid ?? (p.id.endsWith('@lid') ? p.id : null), p.phoneNumber ?? (p.id.endsWith('@s.whatsapp.net') ? p.id : null), p.admin ?? null)
		saveContact({ id: p.id, lid: p.lid, phoneNumber: p.phoneNumber, name: p.name, notify: p.notify, username: p.username })
	}
})

const KINDS: Record<string, string> = {
	conversation: 'text',
	extendedTextMessage: 'text',
	imageMessage: 'image',
	videoMessage: 'video',
	audioMessage: 'voice',
	documentMessage: 'file',
	stickerMessage: 'sticker',
	ptvMessage: 'video'
}

export type MessageRow = {
	chat_jid: string
	id: string
	from_me: number
	sender_jid: string | null
	sender_alt: string | null
	push_name: string | null
	timestamp: number | null
	type: string | null
	text: string | null
	media_path: string | null
	deleted: number
}

/** Dạng tin dùng cho sự kiện realtime, cùng tên field với zalo-api. */
export const messageEvent = (chat: string, id: string, fromMe: number, meId?: string | null) => {
	const row = db
		.prepare('SELECT chat_jid, id, from_me, sender_jid, sender_alt, push_name, timestamp, type, text, media_path, deleted FROM messages WHERE chat_jid = ? AND id = ? AND from_me = ?')
		.get(chat, id, fromMe) as MessageRow | undefined
	if (!row) return null
	return {
		chat_id: row.chat_jid,
		chat_type: row.chat_jid.endsWith('@g.us') ? 'group' : 'user',
		id: row.id,
		from_me: !!row.from_me,
		sender_id: row.from_me ? (meId ?? null) : (row.sender_jid ?? row.chat_jid),
		sender_alt: row.sender_alt,
		sender_name: row.push_name,
		timestamp: row.timestamp,
		type: row.type,
		kind: (row.type && KINDS[row.type]) ?? 'other',
		text: row.text,
		has_media: isMediaType(row.type),
		media_path: row.media_path
	}
}

/** jid / lid / số điện thoại -> mọi dạng đã biết của cùng một người. */
export const resolveIdentity = (input: string) => {
	const raw = input.trim()
	const digits = raw.replace(/\D/g, '')
	const seeds = new Set<string>()
	if (raw.includes('@')) seeds.add(raw.replace(/:\d+@/, '@'))
	else if (digits) seeds.add(`${digits}@s.whatsapp.net`)
	for (const s of [...seeds]) {
		if (s.endsWith('@lid')) {
			const m = db.prepare('SELECT pn FROM lid_map WHERE lid = ?').get(s) as { pn: string } | undefined
			if (m) seeds.add(m.pn.includes('@') ? m.pn : `${m.pn}@s.whatsapp.net`)
		} else {
			const m = db.prepare('SELECT lid FROM lid_map WHERE pn = ? OR pn = ?').get(s, s.split('@')[0]) as { lid: string } | undefined
			if (m) seeds.add(m.lid)
		}
	}
	const list = [...seeds]
	const ph = list.map(() => '?').join(',')
	const contacts = db
		.prepare(`SELECT * FROM contacts WHERE jid IN (${ph}) OR lid IN (${ph}) OR phone_number IN (${ph})`)
		.all(...list, ...list, ...list) as Record<string, string | null>[]
	const pick = (k: string) => contacts.map(c => c[k]).find(Boolean) ?? null
	const lid = list.find(s => s.endsWith('@lid')) ?? (pick('lid') as string | null)
	const jid = list.find(s => s.endsWith('@s.whatsapp.net')) ?? (pick('phone_number') as string | null)
	return {
		id: lid ?? jid ?? list[0] ?? raw,
		lid,
		jid,
		phone_number: jid ? jid.split('@')[0] : null,
		name: pick('name'),
		notify: pick('notify'),
		verified_name: pick('verified_name'),
		username: pick('username'),
		avatar: pick('img_url'),
		display_name: (pick('name') ?? pick('verified_name') ?? pick('notify')) as string | null,
		known: contacts.length > 0
	}
}
