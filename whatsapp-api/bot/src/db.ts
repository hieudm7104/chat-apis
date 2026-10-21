import fs from 'node:fs'
import Database from 'better-sqlite3'
import { config } from './config.js'

fs.mkdirSync(config.dataDir, { recursive: true })

export const db = new Database(config.dbFile)
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

db.exec(`
CREATE TABLE IF NOT EXISTS messages (
	chat_jid    TEXT NOT NULL,
	id          TEXT NOT NULL,
	from_me     INTEGER NOT NULL,
	sender_jid  TEXT,
	sender_alt  TEXT,           -- dạng còn lại của sender (LID <-> số điện thoại), nếu WA cung cấp
	push_name   TEXT,
	timestamp   INTEGER,        -- giây
	type        TEXT,
	text        TEXT,
	media_path  TEXT,           -- đường dẫn tương đối trong DATA_DIR/media
	deleted     INTEGER NOT NULL DEFAULT 0,
	raw         TEXT NOT NULL,  -- toàn bộ WAMessage dạng JSON (BufferJSON)
	PRIMARY KEY (chat_jid, id, from_me)
);
CREATE INDEX IF NOT EXISTS idx_messages_chat_ts ON messages (chat_jid, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages (sender_jid);

CREATE TABLE IF NOT EXISTS chats (
	jid                TEXT PRIMARY KEY,
	name               TEXT,
	unread_count       INTEGER,
	conversation_ts    INTEGER,
	raw                TEXT
);

CREATE TABLE IF NOT EXISTS contacts (
	jid           TEXT PRIMARY KEY,
	lid           TEXT,
	phone_number  TEXT,
	name          TEXT,   -- tên lưu trong danh bạ điện thoại bot
	notify        TEXT,   -- tên người đó tự đặt (pushName)
	verified_name TEXT,
	username      TEXT,
	img_url       TEXT,
	status        TEXT,
	updated_at    INTEGER
);

CREATE TABLE IF NOT EXISTS groups (
	jid             TEXT PRIMARY KEY,
	subject         TEXT,
	owner           TEXT,
	owner_pn        TEXT,
	creation        INTEGER,
	description     TEXT,
	announce        INTEGER,
	restrict        INTEGER,
	size            INTEGER,
	addressing_mode TEXT,
	is_community    INTEGER,
	linked_parent   TEXT,
	raw             TEXT,
	updated_at      INTEGER
);

CREATE TABLE IF NOT EXISTS group_participants (
	group_jid    TEXT NOT NULL,
	jid          TEXT NOT NULL,
	lid          TEXT,
	phone_number TEXT,
	admin        TEXT,    -- NULL | 'admin' | 'superadmin'
	PRIMARY KEY (group_jid, jid)
);

CREATE TABLE IF NOT EXISTS lid_map (
	lid TEXT PRIMARY KEY,
	pn  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lid_map_pn ON lid_map (pn);
`)

db.exec(`
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
