// Runs build/index.js the way a Web Function does (a Node process told where to listen through
// AWS_LAMBDA_HTTP_ENDPOINT) against a fake origin and a fake MOS API, sending the headers that
// CloudFront + Lambda would add. Run with `pnpm e2e`.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer, request as httpRequest } from 'node:http'
import { brotliDecompressSync } from 'node:zlib'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 3, 255])
const listen = async (server) => {
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    return `http://127.0.0.1:${server.address().port}`
}

const originRequests = []
const origin = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    originRequests.push({ url: req.url, headers: req.headers, body })
    if (req.url === '/logo.png') {
        res.writeHead(200, { 'content-type': 'image/png' }).end(PNG)
        return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(`<html><head><title>t</title></head><body>
<a id="link" href="${originUrl}/other">other</a>
<p class="lede">Free</p><div class="paywall">SECRET</div></body></html>`)
})
const originUrl = await listen(origin)

const decisionRequests = []
const mos = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    decisionRequests.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body) })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
        JSON.stringify({
            status: 'success',
            identity: { identifier: 'anon-1', isAuthenticated: false, authType: 'anonymous', jwtClaims: {} },
            features: {},
            customer: { hasProducts: false },
            surfaceBehavior: { http: { addHeaders: [{ name: 'x-mos-decided', value: 'yes' }] } },
            componentsSkipped: false,
            componentBehaviors: { paywall: { metadata: { cssSelector: '.paywall' }, content: { remove: true } } },
        }),
    )
})
const mosUrl = await listen(mos)

const port = 18000 + Math.floor(Math.random() * 1000)
const proxy = spawn(process.execPath, ['build/index.js'], {
    env: {
        PATH: process.env.PATH,
        AWS_LAMBDA_HTTP_ENDPOINT: `127.0.0.1:${port}`,
        ORIGIN_URL: originUrl,
        SURFACE_SLUG: 'web',
        MONETIZATION_OS_SECRET_KEY: 'sk_test_env_secret',
        MONETIZATION_OS_HOST: mosUrl,
        ANONYMOUS_SESSION_COOKIE_NAME: 'mos_anon',
        AUTHENTICATED_USER_JWT_COOKIE_NAME: '__session',
        ORIGIN_VERIFY_SECRET: 'front-door-secret',
    },
    stdio: ['ignore', 'pipe', 'inherit'],
})
proxy.on('exit', (code) => {
    if (code !== 0 && code !== null) process.exitCode = 1
})
const logs = []
proxy.stdout.setEncoding('utf8').on('data', (d) => logs.push(d))
const startedAt = Date.now()
while (!logs.join('').includes('listening')) {
    assert.equal(proxy.exitCode, null, 'proxy exited during startup')
    assert.ok(Date.now() - startedAt < 10_000, 'server must listen within 10 s (Lambda init limit)')
    await new Promise((r) => setTimeout(r, 20))
}
console.log(`listening after ${Date.now() - startedAt} ms`)

// What arrives at the server behind CloudFront (AllViewerExceptHostHeader + viewer-request function) and Lambda.
const viewerHeaders = {
    host: 'bcdfghjklmnpqrst.b7t.lambda-web.us-east-1.on.aws',
    'x-mos-viewer-host': 'news.example.com',
    'x-mos-accept-encoding': 'gzip, br',
    'x-mos-origin-verify': 'front-door-secret',
    'cloudfront-forwarded-proto': 'https',
    'cloudfront-viewer-address': '2001:db8::1:51234',
    'cloudfront-viewer-country': 'BR',
    'cloudfront-viewer-city': 'S%C3%A3o%20Paulo',
    'cloudfront-viewer-country-region': 'SP',
    'cloudfront-viewer-time-zone': 'America/Sao_Paulo',
    'cloudfront-viewer-latitude': '-23.54750',
    'cloudfront-viewer-longitude': '-46.63610',
    'cloudfront-viewer-asn': '28573',
    'cloudfront-viewer-tls': 'TLSv1.3:TLS_AES_128_GCM_SHA256:fullHandshake',
    'cloudfront-viewer-http-version': '2.0',
    'x-amz-cf-id': 'cf-req-456',
    'lambda-web-request-id': 'req-123',
    'user-agent': 'Mozilla/5.0 e2e',
}
const proxyUrl = `http://127.0.0.1:${port}`

try {
    // 1. Requests that bypass CloudFront are refused in shared-secret mode.
    const bypass = await fetch(`${proxyUrl}/article`, { headers: { ...viewerHeaders, 'x-mos-origin-verify': 'nope' } })
    assert.equal(bypass.status, 403)
    assert.equal(decisionRequests.length, 0)

    // 2. HTML: decision applied, viewer geo, network, TLS and IP forwarded, links rewritten to the public host.
    const page = await fetch(`${proxyUrl}/article?x=1`, { headers: viewerHeaders })
    const html = await page.text()
    assert.equal(page.status, 200)
    assert.equal(page.headers.get('x-mos-decided'), 'yes')
    assert.ok(!html.includes('SECRET'), 'paywall element removed')
    assert.ok(html.includes('Free'))
    assert.ok(html.includes('href="https://news.example.com/other"'), `origin link rewritten: ${html}`)

    assert.equal(decisionRequests.length, 1)
    const decision = decisionRequests[0]
    assert.equal(decision.url, '/api/v1/surface-decisions')
    assert.equal(decision.auth, 'Bearer sk_test_env_secret')
    assert.equal(decision.body.http.url, 'https://news.example.com/article?x=1')
    assert.equal(decision.body.http.clientIP, '2001:db8::1')
    assert.equal(decision.body.http.userAgent, 'Mozilla/5.0 e2e')
    assert.deepEqual(decision.body.edge, {
        provider: 'cloudfront',
        requestId: 'cf-req-456',
        geo: {
            countryCode: 'BR',
            regionCode: 'SP',
            city: 'São Paulo',
            latitude: -23.5475,
            longitude: -46.6361,
            timezone: 'America/Sao_Paulo',
        },
        network: { asn: 28573 },
        tls: { version: 'TLSv1.3', httpProtocol: 'HTTP/2' },
    })
    assert.equal(decision.body.cloudflare, undefined)

    // 3. The origin sees its own host and none of the front-door headers.
    const toOrigin = originRequests.at(-1)
    assert.equal(toOrigin.headers.host, new URL(originUrl).host)
    assert.equal(toOrigin.headers['x-mos-origin-verify'], undefined)
    assert.equal(toOrigin.headers['x-mos-viewer-host'], undefined)
    assert.equal(toOrigin.headers['x-mos-accept-encoding'], undefined)
    assert.equal(toOrigin.headers['lambda-web-request-id'], undefined)

    // 3b. HTML is brotli-compressed for a viewer that accepts it.
    const raw = await new Promise((resolve, reject) => {
        httpRequest(`${proxyUrl}/article`, { headers: viewerHeaders }, (res) => {
            const chunks = []
            res.on('data', (c) => chunks.push(c)).on('end', () => resolve({ headers: res.headers, body: Buffer.concat(chunks) }))
        })
            .on('error', reject)
            .end()
    })
    assert.equal(raw.headers['content-encoding'], 'br')
    assert.match(raw.headers.vary, /accept-encoding/)
    assert.ok(brotliDecompressSync(raw.body).toString().includes('Free'))

    // 3c. POST bodies reach the origin with Content-Length, not chunked.
    await fetch(`${proxyUrl}/form`, { method: 'POST', headers: viewerHeaders, body: 'a=1&b=2' })
    const posted = originRequests.at(-1)
    assert.equal(posted.body, 'a=1&b=2')
    assert.equal(posted.headers['content-length'], '7')
    assert.equal(posted.headers['transfer-encoding'], undefined)

    // 4. Non-HTML passes through byte for byte, uncompressed.
    const png = await fetch(`${proxyUrl}/logo.png`, { headers: viewerHeaders })
    assert.equal(png.status, 200)
    assert.equal(png.headers.get('content-encoding'), null)
    assert.deepEqual(Buffer.from(await png.arrayBuffer()), PNG)

    // 5. Each request is logged as an object, which Lambda writes as queryable JSON.
    await new Promise((r) => setTimeout(r, 50))
    assert.match(logs.join(''), /method: 'GET', path: '\/logo\.png', status: 200/)

    // 6. SIGTERM exits promptly.
    const sigtermAt = Date.now()
    proxy.kill('SIGTERM')
    const [code] = await once(proxy, 'exit')
    assert.equal(code, 0)
    assert.ok(Date.now() - sigtermAt < 1000, 'exit within Lambda 1 s SIGTERM budget')

    console.log('e2e: all assertions passed')
} finally {
    proxy.kill()
    origin.close()
    mos.close()
}
