import type { GroupInfo, Message, User } from 'zca-js'
import { ThreadType } from 'zca-js'
import { db } from './db.js'
import { nowSec } from './util.js'

export type Attachment = {
	url: string
	name: string | null
	size: number | null
	thumb: string | null
	width: number | null
	height: number | null
	params: Record<string, unknown>
}

export type StoredMessage = {
	chat_id: string
	chat_type: 'user' | 'group'
	id: string
	cli_msg_id: string
	from_me: boolean
	sender_id: string
	sender_name: string
	timestamp: number
	type: string
	kind: string
	text: string | null
	attachment: Attachment | null
	quote: unknown
}

const KIND: Record<string, string> = {
	'webchat': 'text',
	'chat.photo': 'image',
	'chat.video.msg': 'video',
	'chat.voice': 'voice',
	'share.file': 'file',
	'chat.gif': 'gif',
	'chat.sticker': 'sticker',
	'chat.recommended': 'link',
	'chat.link': 'link'
}

const parseParams = (raw: unknown): Record<string, unknown> => {
	if (typeof raw !== 'string' || !raw) return {}
	try {
		const v = JSON.parse(raw)
		return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
	} catch {
		return {}
	}
}

export const normalizeMessage = (msg: Message): StoredMessage => {
	const d = msg.data
	const content = d.content
	const type = d.msgType
	let kind = KIND[type] ?? (typeof content === 'string' ? 'text' : 'other')
	let text: string | null = null
	let attachment: Attachment | null = null

	if (typeof content === 'string') {
		text = content
	} else if (content && typeof (content as { href?: unknown }).href === 'string' && (content as { href: string }).href) {
		const c = content as { href: string; title?: string; thumb?: string; params?: string }
		const params = parseParams(c.params)
		if (kind === 'other') kind = 'file'
		const size = Number(params.fileSize ?? params.totalSize)
		attachment = {
			url: c.href,
			name: kind === 'file' ? (c.title ?? null) : null,
			size: Number.isFinite(size) && size > 0 ? size : null,
			thumb: c.thumb || null,
			width: Number(params.width) || null,
			height: Number(params.height) || null,
			params
		}
		if (kind !== 'file' && kind !== 'link' && c.title) text = c.title
		if (kind === 'link') text = c.title ?? null
	}

	const fromMe = msg.isSelf
	return {
		chat_id: msg.threadId,
		chat_type: msg.type === ThreadType.Group ? 'group' : 'user',
		id: String(d.msgId),
		cli_msg_id: String(d.cliMsgId),
		from_me: fromMe,
		sender_id: d.uidFrom,
		sender_name: d.dName,
		timestamp: Math.floor(Number(d.ts) / 1000),
		type,
		kind,
		text,
		attachment,
		quote: d.quote ?? null
	}
}

const insertMessage = db.prepare(`
INSERT INTO messages (chat_id, chat_type, id, cli_msg_id, from_me, sender_id, sender_name, timestamp, type, kind, text, attachment, quote, raw)
VALUES (@chat_id, @chat_type, @id, @cli_msg_id, @from_me, @sender_id, @sender_name, @timestamp, @type, @kind, @text, @attachment, @quote, @raw)
ON CONFLICT (chat_id, id) DO NOTHING`)

const upsertChat = db.prepare(`
INSERT INTO chats (id, type, name, last_ts) VALUES (@id, @type, @name, @ts)
ON CONFLICT (id) DO UPDATE SET last_ts = MAX(COALESCE(chats.last_ts, 0), excluded.last_ts), name = COALESCE(excluded.name, chats.name)`)

/** Lưu tin; trả về null nếu tin đã có (tránh phát sự kiện trùng). */
export const saveMessage = (msg: Message): StoredMessage | null => {
	const m = normalizeMessage(msg)
	const info = insertMessage.run({
		...m,
		from_me: m.from_me ? 1 : 0,
		attachment: m.attachment ? JSON.stringify(m.attachment) : null,
		quote: m.quote ? JSON.stringify(m.quote) : null,
		raw: JSON.stringify(msg.data)
	})
	upsertChat.run({ id: m.chat_id, type: m.chat_type, name: m.chat_type === 'user' && !m.from_me ? m.sender_name : null, ts: m.timestamp })
	if (!m.from_me && m.sender_id) touchUser(m.sender_id, m.sender_name)
	return info.changes ? m : null
}

export const markDeleted = (chatId: string, msgId: string) =>
	db.prepare('UPDATE messages SET deleted = 1 WHERE chat_id = ? AND id = ?').run(chatId, msgId)

export const setMediaPath = (chatId: string, msgId: string, rel: string) =>
	db.prepare('UPDATE messages SET media_path = ? WHERE chat_id = ? AND id = ?').run(rel, chatId, msgId)

const touchUser = (id: string, displayName: string) =>
	db
		.prepare(
			`INSERT INTO users (id, display_name, updated_at) VALUES (?, ?, ?)
			 ON CONFLICT (id) DO UPDATE SET display_name = COALESCE(NULLIF(excluded.display_name, ''), users.display_name)`
		)
		.run(id, displayName || null, nowSec())

const upsertUser = db.prepare(`
INSERT INTO users (id, display_name, zalo_name, username, phone, avatar, global_id, is_friend, updated_at)
VALUES (@id, @display_name, @zalo_name, @username, @phone, @avatar, @global_id, @is_friend, @updated_at)
ON CONFLICT (id) DO UPDATE SET
	display_name = COALESCE(NULLIF(excluded.display_name, ''), users.display_name),
	zalo_name = COALESCE(NULLIF(excluded.zalo_name, ''), users.zalo_name),
	username = COALESCE(NULLIF(excluded.username, ''), users.username),
	phone = COALESCE(NULLIF(excluded.phone, ''), users.phone),
	avatar = COALESCE(NULLIF(excluded.avatar, ''), users.avatar),
	global_id = COALESCE(excluded.global_id, users.global_id),
	is_friend = COALESCE(excluded.is_friend, users.is_friend),
	updated_at = excluded.updated_at`)

export const saveUser = (u: Partial<User> & { userId: string }, isFriend?: boolean) =>
	upsertUser.run({
		id: u.userId,
		display_name: u.displayName ?? null,
		zalo_name: u.zaloName ?? null,
		username: u.username ?? null,
		phone: u.phoneNumber ?? null,
		avatar: u.avatar ?? null,
		global_id: u.globalId ?? null,
		is_friend: isFriend === undefined ? (u.isFr === undefined ? null : u.isFr ? 1 : 0) : isFriend ? 1 : 0,
		updated_at: nowSec()
	})

export const saveMemberProfile = (p: { id: string; displayName?: string; zaloName?: string; avatar?: string; globalId?: string }) =>
	upsertUser.run({
		id: p.id,
		display_name: p.displayName ?? null,
		zalo_name: p.zaloName ?? null,
		username: null,
		phone: null,
		avatar: p.avatar ?? null,
		global_id: p.globalId ?? null,
		is_friend: null,
		updated_at: nowSec()
	})

export const saveGroup = (g: GroupInfo) => {
	db.transaction(() => {
		db.prepare(
			`INSERT INTO groups (id, name, description, creator_id, avatar, total_member, created_time, raw, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT (id) DO UPDATE SET name = excluded.name, description = excluded.description, creator_id = excluded.creator_id,
				avatar = excluded.avatar, total_member = excluded.total_member, created_time = excluded.created_time,
				raw = excluded.raw, updated_at = excluded.updated_at`
		).run(g.groupId, g.name, g.desc, g.creatorId, g.fullAvt || g.avt, g.totalMember, g.createdTime, JSON.stringify(g), nowSec())
		db.prepare('DELETE FROM group_members WHERE group_id = ?').run(g.groupId)
		const ins = db.prepare('INSERT OR REPLACE INTO group_members (group_id, user_id, role) VALUES (?, ?, ?)')
		const admins = new Set(g.adminIds ?? [])
		// Zalo thực tế để memberIds rỗng và trả thành viên trong memVerList dạng "uid_0"
		const ids = new Set<string>(g.memberIds ?? [])
		for (const m of g.currentMems ?? []) ids.add(m.id)
		for (const v of (g as { memVerList?: string[] }).memVerList ?? []) ids.add(v.replace(/_\d+$/, ''))
		for (const id of ids) ins.run(g.groupId, id, id === g.creatorId ? 'owner' : admins.has(id) ? 'admin' : 'member')
		for (const m of g.currentMems ?? []) saveMemberProfile({ id: m.id, displayName: m.dName, zaloName: m.zaloName, avatar: m.avatar })
		upsertChat.run({ id: g.groupId, type: 'group', name: g.name, ts: 0 })
	})()
}

export const saveFriendRequest = (userId: string, direction: 'incoming' | 'outgoing', status: string, message?: string | null, src?: number | null) => {
	const now = nowSec()
	db.prepare(
		`INSERT INTO friend_requests (user_id, direction, message, src, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT (user_id, direction) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at,
			message = COALESCE(excluded.message, friend_requests.message), src = COALESCE(excluded.src, friend_requests.src)`
	).run(userId, direction, message ?? null, src ?? null, status, now, now)
}

export const chatTypeOf = (id: string): 'user' | 'group' | null => {
	const row = db.prepare('SELECT type FROM chats WHERE id = ?').get(id) as { type: 'user' | 'group' } | undefined
	if (row) return row.type
	return db.prepare('SELECT 1 FROM groups WHERE id = ?').get(id) ? 'group' : null
}

export const publicMessage = (row: Record<string, unknown>) => ({
	...row,
	from_me: !!row.from_me,
	deleted: !!row.deleted,
	attachment: row.attachment ? JSON.parse(row.attachment as string) : null,
	quote: row.quote ? JSON.parse(row.quote as string) : null
})
