import { timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable, type Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'
import { constants, createBrotliCompress, createGzip } from 'node:zlib'

/** Set by the CloudFront viewer-request function. Lambda forces `Host` to the endpoint domain. */
export const VIEWER_HOST_HEADER = 'x-mos-viewer-host'
/** Set by the same function, so compression never depends on what CloudFront forwards. */
const VIEWER_ACCEPT_ENCODING_HEADER = 'x-mos-accept-encoding'
/** CloudFront origin custom header. */
const ORIGIN_VERIFY_HEADER = 'x-mos-origin-verify'

// Front-door headers, plus hop-by-hop headers that fetch rejects or that describe this connection.
const DROPPED_REQUEST_HEADERS = new Set([
    'host',
    VIEWER_HOST_HEADER,
    VIEWER_ACCEPT_ENCODING_HEADER,
    ORIGIN_VERIFY_HEADER,
    'connection',
    'keep-alive',
    'proxy-connection',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
    'expect',
    'content-length',
    // A viewer's value, forwarded unchecked, would let it pick the host an origin that trusts these builds URLs from.
    'x-forwarded-host',
    'forwarded',
])
// fetch decodes these, so the origin is only offered them and the decoded body is re-framed here.
const ORIGIN_ACCEPT_ENCODING = 'gzip, deflate, br'
const DECODED_ENCODINGS = new Set(['gzip', 'x-gzip', 'deflate', 'br', 'identity'])
const DROPPED_RESPONSE_HEADERS = ['content-length', 'transfer-encoding', 'connection', 'keep-alive']
const COMPRESSIBLE = /^(text\/|image\/svg\+xml|application\/([\w.+-]+\+)?(json|javascript|x-javascript|xml|wasm)\b)/

/** A request the proxy can't map to a viewer URL. */
export class BadRequestError extends Error {}

export function isFromFrontDoor(req: IncomingMessage, secret: string | undefined): boolean {
    if (!secret) return true
    const given = req.headers[ORIGIN_VERIFY_HEADER]
    if (typeof given !== 'string') return false
    const a = Buffer.from(given)
    const b = Buffer.from(secret)
    return a.length === b.length && timingSafeEqual(a, b)
}

const single = (value: string | string[] | undefined): string | undefined => (Array.isArray(value) ? value.join(',') : value)

/**
 * The viewer's URL. The path is appended to a validated origin rather than resolved against it,
 * since `new URL('//evil.com/', base)` would move the request, its links and redirects to evil.com.
 */
export function viewerUrl(req: IncomingMessage): URL {
    const host = single(req.headers[VIEWER_HOST_HEADER]) ?? req.headers.host ?? 'localhost'
    // CloudFront always sends the viewer's protocol; a request without it is local.
    const proto = single(req.headers['cloudfront-forwarded-proto']) === 'https' ? 'https' : 'http'
    const path = req.url ?? '/'
    let base: URL
    try {
        base = new URL(`${proto}://${host}`)
    } catch {
        throw new BadRequestError(`Invalid host: ${host}`)
    }
    if (!path.startsWith('/') || base.username || base.password || base.pathname !== '/' || base.search || base.hash) {
        throw new BadRequestError(`Invalid host or path: ${host} ${path}`)
    }
    return new URL(`${base.origin}${path}`)
}

/**
 * Rebuilds the viewer's request as a web `Request`, minus headers only meant for this hop.
 * The body is buffered: Lambda delivers it whole before any response anyway (half-duplex),
 * and a buffered body reaches the origin with Content-Length, as from a Worker, not chunked.
 */
export async function toFetchRequest(req: IncomingMessage, signal: AbortSignal): Promise<Request> {
    const url = viewerUrl(req)

    const headers = new Headers()
    for (const [name, value] of Object.entries(req.headers)) {
        if (value === undefined || DROPPED_REQUEST_HEADERS.has(name) || name.startsWith('lambda-web-')) continue
        // CloudFront's OAC signature for Lambda; the origin has no use for it.
        if (name.startsWith('x-amz-') && name !== 'x-amz-cf-id') continue
        for (const v of Array.isArray(value) ? value : [value]) headers.append(name, v)
    }
    headers.set('accept-encoding', ORIGIN_ACCEPT_ENCODING)

    const declaresBody = req.headers['content-length'] !== undefined || req.headers['transfer-encoding'] !== undefined
    const body = declaresBody && req.method !== 'GET' && req.method !== 'HEAD' ? Buffer.concat(await req.toArray()) : undefined
    if (body) headers.set('content-length', String(body.length))

    return new Request(url, { method: req.method, headers, body, redirect: 'manual', signal })
}

/** Brotli over gzip, honouring `q=0`. */
export function pickEncoding(acceptEncoding: string | undefined): 'br' | 'gzip' | undefined {
    const accepted = new Set(
        (acceptEncoding ?? '')
            .split(',')
            .map((part) => part.trim().split(';'))
            .filter(([, q]) => !q || Number(q.trim().replace(/^q=/, '')) > 0)
            .map(([name]) => name?.trim().toLowerCase()),
    )
    return accepted.has('br') ? 'br' : accepted.has('gzip') ? 'gzip' : undefined
}

// An encoding fetch didn't decode stays on the response, untouched.
const isDecoded = (encoding: string | null): boolean =>
    !encoding || encoding.split(',').every((e) => DECODED_ENCODINGS.has(e.trim().toLowerCase()))

// Cloudflare compresses Worker responses at the edge; CloudFront won't under CachingDisabled, so
// the proxy does it. Flushing per chunk keeps streamed HTML streaming, at a small cost in ratio.
function compressor(req: IncomingMessage, response: Response): { encoding: string; stream: Transform } | undefined {
    const { status, headers } = response
    if (!response.body || req.method === 'HEAD' || status === 204 || status === 206 || status === 304) return undefined
    if (headers.has('content-range') || /\bno-transform\b/i.test(headers.get('cache-control') ?? '')) return undefined
    if (!isDecoded(headers.get('content-encoding')) || !COMPRESSIBLE.test(headers.get('content-type') ?? '')) return undefined
    const encoding = pickEncoding(single(req.headers[VIEWER_ACCEPT_ENCODING_HEADER]) ?? req.headers['accept-encoding'])
    if (encoding === 'br') {
        return {
            encoding,
            stream: createBrotliCompress({
                flush: constants.BROTLI_OPERATION_FLUSH,
                params: { [constants.BROTLI_PARAM_QUALITY]: 4 },
            }),
        }
    }
    if (encoding === 'gzip') return { encoding, stream: createGzip({ flush: constants.Z_SYNC_FLUSH }) }
    return undefined
}

/** Streams a web `Response` to Node, compressed when the viewer accepts it. */
export async function sendResponse(req: IncomingMessage, res: ServerResponse, response: Response): Promise<void> {
    const headers = new Headers(response.headers)
    for (const name of DROPPED_RESPONSE_HEADERS) headers.delete(name)
    if (isDecoded(headers.get('content-encoding'))) headers.delete('content-encoding')
    const setCookies = headers.getSetCookie()
    headers.delete('set-cookie')

    const compression = compressor(req, response)
    if (compression) {
        headers.set('content-encoding', compression.encoding)
        headers.append('vary', 'accept-encoding')
    }

    headers.forEach((value, name) => {
        res.appendHeader(name, value)
    })
    for (const cookie of setCookies) res.appendHeader('set-cookie', cookie)
    res.writeHead(response.status, response.statusText)

    if (!response.body) {
        res.end()
        return
    }
    const body = Readable.fromWeb(response.body as NodeReadableStream)
    await (compression ? pipeline(body, compression.stream, res) : pipeline(body, res))
}
