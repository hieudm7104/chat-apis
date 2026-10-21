import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'
import pino from 'pino'
import { config } from './config.js'
import { db } from './db.js'

export const logger = pino({ level: config.logLevel })

export type ApiEvent = { id: number; type: string; ts: number; data: unknown }

export const bus = new EventEmitter()
bus.setMaxListeners(0)

const insertEvent = db.prepare('INSERT INTO events (type, ts, data) VALUES (?, ?, ?)')

export const emitEvent = (type: string, data: unknown): ApiEvent => {
	const ts = Math.floor(Date.now() / 1000)
	const id = Number(insertEvent.run(type, ts, JSON.stringify(data)).lastInsertRowid)
	const ev: ApiEvent = { id, type, ts, data }
	bus.emit('event', ev)
	return ev
}

export const eventsSince = (afterId: number, limit: number): ApiEvent[] =>
	(db.prepare('SELECT id, type, ts, data FROM events WHERE id > ? ORDER BY id ASC LIMIT ?').all(afterId, limit) as ApiEvent[]).map(r => ({
		...r,
		data: JSON.parse(r.data as unknown as string)
	}))

type Hook = { id: string; url: string; secret: string | null; events: string[] | null }

const loadHooks = (): Hook[] => {
	const rows = db.prepare('SELECT id, url, secret, events FROM webhooks').all() as { id: string; url: string; secret: string | null; events: string | null }[]
	const hooks: Hook[] = rows.map(r => ({ ...r, events: r.events ? (JSON.parse(r.events) as string[]) : null }))
	if (config.webhookUrl) hooks.push({ id: 'env', url: config.webhookUrl, secret: config.webhookSecret || null, events: null })
	return hooks
}

export const addWebhook = (url: string, secret?: string, events?: string[]) => {
	const id = crypto.randomUUID()
	db.prepare('INSERT INTO webhooks (id, url, secret, events) VALUES (?, ?, ?, ?)').run(id, url, secret ?? null, events?.length ? JSON.stringify(events) : null)
	return id
}

export const listWebhooks = () => loadHooks().map(h => ({ id: h.id, url: h.url, events: h.events, signed: !!h.secret }))

export const removeWebhook = (id: string) => db.prepare('DELETE FROM webhooks WHERE id = ?').run(id).changes > 0

const deliver = async (hook: Hook, ev: ApiEvent) => {
	const body = JSON.stringify(ev)
	const headers: Record<string, string> = { 'content-type': 'application/json', 'x-event-type': ev.type, 'x-event-id': String(ev.id) }
	if (hook.secret) headers['x-signature'] = 'sha256=' + crypto.createHmac('sha256', hook.secret).update(body).digest('hex')
	for (let attempt = 0; attempt < 4; attempt++) {
		try {
			const res = await fetch(hook.url, { method: 'POST', headers, body, signal: AbortSignal.timeout(10_000) })
			if (res.ok) return
			logger.warn({ hook: hook.id, status: res.status, attempt }, 'webhook trả lỗi')
		} catch (err) {
			logger.warn({ hook: hook.id, err: (err as Error).message, attempt }, 'webhook không gọi được')
		}
		await new Promise(r => setTimeout(r, 1000 * 2 ** attempt))
	}
}

bus.on('event', (ev: ApiEvent) => {
	for (const hook of loadHooks()) {
		if (hook.events && !hook.events.includes(ev.type)) continue
		void deliver(hook, ev)
	}
})
