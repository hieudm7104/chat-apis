import path from 'node:path'
import { imageSize } from 'image-size'

export const safe = (s: string) => s.replace(/[^a-zA-Z0-9._-]/g, '_')

export const clampInt = (v: unknown, def: number, max: number) => Math.min(Math.max(parseInt(String(v ?? ''), 10) || def, 1), max)

export const nowSec = () => Math.floor(Date.now() / 1000)

const MIME: Record<string, string> = {
	'.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif',
	'.mp4': 'video/mp4', '.aac': 'audio/aac', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg',
	'.pdf': 'application/pdf', '.txt': 'text/plain', '.json': 'application/json', '.zip': 'application/zip'
}

export const mimeFor = (file: string) => MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream'

export const isImageName = (name: string) => /\.(jpe?g|png|webp)$/i.test(name)

export const imageDims = (buf: Buffer): { width: number; height: number } | null => {
	try {
		const { width, height } = imageSize(buf)
		return width && height ? { width, height } : null
	} catch {
		return null
	}
}
