import fs from 'node:fs'
import Database from 'better-sqlite3'
import { config } from './config.js'

fs.mkdirSync(config.dataDir, { recursive: true })

export const db = new Database(config.dbFile)
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

db.exec(`
CREATE TABLE IF NOT EXISTS messages (
	chat_id      TEXT NOT NULL,   -- uid người kia (chat 1:1) hoặc groupId
	chat_type    TEXT NOT NULL,   -- 'user' | 'group'
	id           TEXT NOT NULL,   -- msgId
	cli_msg_id   TEXT,
	from_me      INTEGER NOT NULL,
	sender_id    TEXT,
	sender_name  TEXT,
	timestamp    INTEGER,         -- giây
	type         TEXT,            -- msgType gốc của Zalo
	kind         TEXT,            -- text | image | video | voice | file | gif | sticker | link | other
	text         TEXT,
	attachment   TEXT,            -- JSON {url,name,size,...}
	media_path   TEXT,            -- đường dẫn tương đối trong DATA_DIR/media
	quote        TEXT,            -- JSON
	deleted      INTEGER NOT NULL DEFAULT 0,
	raw          TEXT NOT NULL,
	PRIMARY KEY (chat_id, id)
);
CREATE INDEX IF NOT EXISTS idx_messages_chat_ts ON messages (chat_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages (sender_id);

CREATE TABLE IF NOT EXISTS chats (
	id       TEXT PRIMARY KEY,
	type     TEXT NOT NULL,
	name     TEXT,
	last_ts  INTEGER
);

CREATE TABLE IF NOT EXISTS users (
	id           TEXT PRIMARY KEY,   -- uid, dùng chung cho chat 1:1 và thành viên nhóm
	display_name TEXT,
	zalo_name    TEXT,
	username     TEXT,
	phone        TEXT,
	avatar       TEXT,
	global_id    TEXT,
	is_friend    INTEGER,
	updated_at   INTEGER
);

CREATE TABLE IF NOT EXISTS groups (
	id            TEXT PRIMARY KEY,
	name          TEXT,
	description   TEXT,
	creator_id    TEXT,
	avatar        TEXT,
	total_member  INTEGER,
	created_time  INTEGER,
	raw           TEXT,
	updated_at    INTEGER
);

CREATE TABLE IF NOT EXISTS group_members (
	group_id TEXT NOT NULL,
	user_id  TEXT NOT NULL,
	role     TEXT NOT NULL,       -- 'owner' | 'admin' | 'member'
	PRIMARY KEY (group_id, user_id)
);

CREATE TABLE IF NOT EXISTS friend_requests (
	user_id    TEXT NOT NULL,
	direction  TEXT NOT NULL,     -- 'incoming' | 'outgoing'
	message    TEXT,
	src        INTEGER,
	status     TEXT NOT NULL,     -- pending | accepted | rejected | canceled
	created_at INTEGER,
	updated_at INTEGER,
	PRIMARY KEY (user_id, direction)
);

CREATE TABLE IF NOT EXISTS webhooks (
	id      TEXT PRIMARY KEY,
	url     TEXT NOT NULL,
	secret  TEXT,
	events  TEXT                  -- JSON mảng; NULL = tất cả
);

CREATE TABLE IF NOT EXISTS events (
	id   INTEGER PRIMARY KEY AUTOINCREMENT,
	type TEXT NOT NULL,
	ts   INTEGER NOT NULL,
	data TEXT NOT NULL
);
`)
