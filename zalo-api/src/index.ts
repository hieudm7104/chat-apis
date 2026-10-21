import { config } from './config.js'
import { logger } from './events.js'
import { buildServer } from './server.js'
import { startZalo } from './zalo.js'

if (!config.apiKey || config.apiKey.length < 16) {
	logger.fatal('Cần đặt API_KEY dài ít nhất 16 ký tự trong .env')
	process.exit(1)
}

const app = await buildServer()
await app.listen({ port: config.port, host: '0.0.0.0' })
void startZalo()

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
	process.on(sig, async () => {
		await app.close()
		process.exit(0)
	})
}
