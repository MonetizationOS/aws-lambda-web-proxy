import { createServer } from 'node:http'
import { createRequestListener } from './app.js'
import { env } from './env.js'
import worker from './index.js'

// Lambda Web Functions start this file as a plain Node process and route requests to
// AWS_LAMBDA_HTTP_ENDPOINT. It must be listening within 10 s of startup.
const endpoint = process.env.AWS_LAMBDA_HTTP_ENDPOINT ?? '127.0.0.1:8787'
const host = endpoint.slice(0, endpoint.lastIndexOf(':')).replace(/^\[|\]$/g, '')
const port = endpoint.slice(endpoint.lastIndexOf(':') + 1)

const server = createServer(createRequestListener(worker.fetch, { originVerifySecret: env.ORIGIN_VERIFY_SECRET || undefined }))
server.listen(Number(port), host, () => console.log(`mos-proxy listening on ${host}:${port}`))

// Lambda allows 1 s after SIGTERM.
process.on('SIGTERM', () => {
    server.close()
    process.exit(0)
})
