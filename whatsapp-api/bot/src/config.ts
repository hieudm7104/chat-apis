import path from 'node:path'

const bool = (v: string | undefined, def: boolean) => (v === undefined ? def : ['1', 'true', 'yes'].includes(v.toLowerCase()))

const dataDir = path.resolve(process.env.DATA_DIR ?? './data')

export const config = {
	port: Number(process.env.PORT ?? 3000),
	logLevel: process.env.LOG_LEVEL ?? 'info',
	apiKey: process.env.API_KEY ?? '',
	dataDir,
	authDir: path.join(dataDir, 'auth'),
	mediaDir: path.join(dataDir, 'media'),
	dbFile: path.join(dataDir, 'bot.db'),
	autoDownloadMedia: bool(process.env.AUTO_DOWNLOAD_MEDIA, true),
	syncFullHistory: bool(process.env.SYNC_FULL_HISTORY, false),
	deviceName: process.env.DEVICE_NAME ?? 'Data Bot',
	maxUploadMb: Number(process.env.MAX_UPLOAD_MB ?? 100),
	webhookUrl: process.env.WEBHOOK_URL ?? '',
	webhookSecret: process.env.WEBHOOK_SECRET ?? ''
}
