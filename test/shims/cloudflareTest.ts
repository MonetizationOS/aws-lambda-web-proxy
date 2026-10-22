// Stand-in for `cloudflare:test`. fetchMock is an undici MockAgent (which Cloudflare's is too),
// installed as Node's global dispatcher so the proxy's outbound fetches hit it. SELF sends the
// request through the real Node server, with the headers CloudFront would add.
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Agent, type Dispatcher, getGlobalDispatcher, MockAgent, setGlobalDispatcher, fetch as undiciFetch } from 'undici'
import { createRequestListener } from '../../src/app'
import worker from '../../src/index'

// The core re-wraps the request for the origin, which in Node always makes the body a stream.
// Real origins still get Content-Length, but MockAgent can only match string bodies.
const bufferStreamBodies: Dispatcher.DispatcherComposeInterceptor = (dispatch) => (opts, handler) => {
    const body = opts.body as unknown
    if (!body || typeof body === 'string' || body instanceof Uint8Array || !(Symbol.asyncIterator in Object(body))) {
        return dispatch(opts, handler)
    }
    ;(async () => {
        const chunks: Buffer[] = []
        for await (const chunk of body as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk))
        dispatch({ ...opts, body: Buffer.concat(chunks).toString() }, handler)
    })().catch((error) => handler.onResponseError?.(null as never, error))
    return true
}

const original = getGlobalDispatcher()
const mockAgent = new MockAgent()
const mocked = mockAgent.compose(bufferStreamBodies)
setGlobalDispatcher(mocked)

export const fetchMock = Object.assign(mockAgent, {
    activate: () => setGlobalDispatcher(mocked),
    deactivate: () => setGlobalDispatcher(original),
})

let baseUrl: Promise<string> | undefined
const startServer = () =>
    (baseUrl ??= new Promise((resolve) => {
        const server = createServer(createRequestListener(worker.fetch))
        server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`))
        server.unref()
    }))

// Its own dispatcher, so disableNetConnect() on the mock doesn't block calls to the local server.
const direct = new Agent()

export const SELF = {
    async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url)
        const headers = new Headers(request.headers)
        headers.set('x-mos-viewer-host', url.host)
        headers.set('cloudfront-forwarded-proto', url.protocol.replace(':', ''))
        // A test playing a Cloudflare client sets CF-Connecting-IP; CloudFront's equivalent is this.
        const clientIP = headers.get('cf-connecting-ip')
        if (clientIP) headers.set('cloudfront-viewer-address', `${clientIP}:443`)
        const response = await undiciFetch(`${await startServer()}${url.pathname}${url.search}`, {
            method: request.method,
            headers: Object.fromEntries(headers),
            body: request.body,
            duplex: 'half',
            redirect: request.redirect,
            dispatcher: direct,
        })
        return response as unknown as Response
    },
}

export { env } from './env'
