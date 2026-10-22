import { createServer, request as httpRequest, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { createRequestListener } from '../src/app'
import { cloudfrontEdge } from '../src/cloudfrontViewer'
import { BadRequestError, pickEncoding, toFetchRequest, viewerUrl } from '../src/nodeHttp'

const incoming = (url: string, headers: Record<string, string>, method = 'GET', body?: string): IncomingMessage =>
    Object.assign(Readable.from(body ? [Buffer.from(body)] : []), { url, method, headers }) as unknown as IncomingMessage

describe('viewerUrl', () => {
    const viewer = { 'x-mos-viewer-host': 'news.example.com', 'cloudfront-forwarded-proto': 'https' }

    it('keeps a protocol-relative path on the viewer host', () => {
        const url = viewerUrl(incoming('//evil.com/home?x=1', viewer))
        expect(url.host).toBe('news.example.com')
        expect(url.pathname).toBe('//evil.com/home')
    })

    it.each([
        ['an absolute-form target', 'http://evil.com/', viewer],
        ['userinfo in the host', '/', { ...viewer, 'x-mos-viewer-host': 'news.example.com@evil.com' }],
        ['a path in the host', '/', { ...viewer, 'x-mos-viewer-host': 'evil.com/x' }],
    ])('rejects %s', (_, path, headers) => {
        expect(() => viewerUrl(incoming(path, headers))).toThrow(BadRequestError)
    })

    it('uses http without CloudFront', () => {
        expect(viewerUrl(incoming('/a', { host: '127.0.0.1:8787' })).href).toBe('http://127.0.0.1:8787/a')
    })
})

describe('toFetchRequest', () => {
    it('drops hop-by-hop, front-door, signing and viewer-forwarded host headers, and frames the buffered body', async () => {
        const request = await toFetchRequest(
            incoming(
                '/form',
                {
                    host: 'endpoint.lambda-web.us-east-1.on.aws',
                    'x-mos-viewer-host': 'news.example.com',
                    'x-mos-origin-verify': 'secret',
                    'transfer-encoding': 'chunked',
                    connection: 'keep-alive',
                    expect: '100-continue',
                    'x-amz-date': '20261015T000000Z',
                    'x-amz-security-token': 'token',
                    'x-amz-cf-id': 'cf-1',
                    'x-forwarded-host': 'evil.example',
                    forwarded: 'host=evil.example',
                    'accept-encoding': 'zstd',
                    'x-custom': 'kept',
                },
                'POST',
                'a=1&b=2',
            ),
            new AbortController().signal,
        )
        const headers = Object.fromEntries(request.headers)
        expect(headers).toEqual({
            'x-amz-cf-id': 'cf-1',
            'x-custom': 'kept',
            'accept-encoding': 'gzip, deflate, br',
            'content-length': '7',
        })
        expect(await request.text()).toBe('a=1&b=2')
    })

    it('sends no body when the request declares none', async () => {
        const request = await toFetchRequest(incoming('/x', { host: 'a.example' }, 'DELETE'), new AbortController().signal)
        expect(request.body).toBeNull()
    })
})

describe('pickEncoding', () => {
    it.each([
        ['gzip, deflate, br', 'br'],
        ['gzip', 'gzip'],
        ['br;q=0, gzip', 'gzip'],
        ['identity', undefined],
        [undefined, undefined],
    ])('%s -> %s', (header, expected) => {
        expect(pickEncoding(header)).toBe(expected)
    })
})

describe('response handling', () => {
    const serve = async (handle: (request: Request) => Promise<Response>, path = '/', headers: Record<string, string> = {}) => {
        const server = createServer(createRequestListener(handle))
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
        const { port } = server.address() as AddressInfo
        try {
            return await new Promise<{ status: number; headers: Record<string, unknown> }>((resolve, reject) => {
                httpRequest({ port, path, headers: { 'accept-encoding': 'br', ...headers } }, (res) => {
                    res.resume().on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers }))
                })
                    .on('error', reject)
                    .end()
            })
        } finally {
            server.close()
        }
    }
    const html =
        (headers: Record<string, string>, status = 200) =>
        async () =>
            new Response('<p>hi</p>', { status, headers: { 'content-type': 'text/html', ...headers } })

    it('compresses text for a viewer that accepts it', async () => {
        expect((await serve(html({}))).headers['content-encoding']).toBe('br')
    })

    it.each([
        ['a partial response', html({ 'content-range': 'bytes 0-8/100' }, 206)],
        ['a no-transform response', html({ 'cache-control': 'public, no-transform' })],
    ])('leaves %s uncompressed', async (_, handle) => {
        expect((await serve(handle)).headers['content-encoding']).toBeUndefined()
    })

    it('keeps an encoding fetch could not decode', async () => {
        expect((await serve(html({ 'content-encoding': 'x-custom' }))).headers['content-encoding']).toBe('x-custom')
    })

    it('answers 400 for a host it cannot use, and 502 without the origin headers on failure', async () => {
        expect((await serve(html({}), '/', { 'x-mos-viewer-host': 'a@evil.com' })).status).toBe(400)
        const failed = await serve(async () => {
            throw new Error('origin down')
        })
        expect(failed.status).toBe(502)
    })
})

describe('cloudfrontEdge', () => {
    it('is sent when CloudFront cannot geolocate the viewer', () => {
        expect(cloudfrontEdge(new Headers({ 'x-amz-cf-id': 'cf-1' }))).toEqual({ provider: 'cloudfront', requestId: 'cf-1', geo: {} })
    })

    it('ignores fingerprints the origin request policy cannot have forwarded', () => {
        const edge = cloudfrontEdge(new Headers({ 'x-amz-cf-id': 'cf-1', 'cloudfront-viewer-ja4-fingerprint': 't13d_spoofed' }))
        expect(edge?.tls).toBeUndefined()
    })

    it('is absent outside CloudFront', () => {
        expect(cloudfrontEdge(new Headers())).toBeUndefined()
    })
})
