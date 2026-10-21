import path from 'node:path'

const bool = (v: string | undefined, def: boolean) => (v === undefined ? def : ['1', 'true', 'yes'].includes(v.toLowerCase()))

const dataDir = path.resolve(process.env.DATA_DIR ?? './data')

export const config = {
	port: Number(process.env.PORT ?? 3001),
	logLevel: process.env.LOG_LEVEL ?? 'info',
	apiKey: process.env.API_KEY ?? '',
	dataDir,
	authDir: path.join(dataDir, 'auth'),
	credFile: path.join(dataDir, 'auth', 'credentials.json'),
	mediaDir: path.join(dataDir, 'media'),
	dbFile: path.join(dataDir, 'zalo.db'),
	autoDownloadMedia: bool(process.env.AUTO_DOWNLOAD_MEDIA, true),
	selfListen: bool(process.env.SELF_LISTEN, true),
	maxUploadMb: Number(process.env.MAX_UPLOAD_MB ?? 100),
	webhookUrl: process.env.WEBHOOK_URL ?? '',
	webhookSecret: process.env.WEBHOOK_SECRET ?? ''
}
