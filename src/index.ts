import { MOSProxyBuilder } from '@monetizationos/proxy'
import { cloudfrontClientIP, cloudfrontMetadata } from './cloudfrontViewer.js'
import { env } from './env.js'
import { LolHtmlRewriterAdapter } from './htmlRewriterAdapter.js'

// The same wiring as the Cloudflare proxy worker. Only the platform adapters differ: the HTML
// rewriter, client metadata and client IP.
const proxy = new MOSProxyBuilder()
    .withConfig({
        originUrl: env.ORIGIN_URL || 'https://example.local',
        surfaceSlug: env.SURFACE_SLUG ?? '',
        mosHost: env.MONETIZATION_OS_HOST || 'https://api.monetizationos.com',
        mosSecretKey: env.MONETIZATION_OS_SECRET_KEY ?? '',
        mosEndpointsPrefix: env.MONETIZATION_OS_ENDPOINTS_PREFIX || '/mos-endpoints/',
        anonymousSessionCookieName: env.ANONYMOUS_SESSION_COOKIE_NAME,
        authenticatedUserJwtCookieName: env.AUTHENTICATED_USER_JWT_COOKIE_NAME,
        injectScriptUrl: env.INJECT_SCRIPT_URL || undefined,
        surfaceDecisionsIgnorePaths: env.SURFACE_DECISIONS_IGNORE_PATHS,
        surfaceDecisionsCookies: env.SURFACE_DECISIONS_COOKIES,
        originRequestHeaders: env.ORIGIN_REQUEST_HEADERS ?? {},
    })
    .withOriginFetcher(fetch)
    .withApiFetcher(fetch)
    .withHtmlRewriter(new LolHtmlRewriterAdapter())
    .withClientMetadata(cloudfrontMetadata)
    .withClientIP(cloudfrontClientIP)
    .build()

export default {
    async fetch(request: Request): Promise<Response> {
        return proxy.handle(request)
    },
}
