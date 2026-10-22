/** The Cloudflare proxy worker's vars, read from the revision's environment variables instead of bindings. */
export interface Env {
    MONETIZATION_OS_SECRET_KEY?: string
    ORIGIN_URL?: string
    SURFACE_SLUG?: string
    AUTHENTICATED_USER_JWT_COOKIE_NAME: string
    ANONYMOUS_SESSION_COOKIE_NAME: string
    INJECT_SCRIPT_URL?: string
    MONETIZATION_OS_HOST?: string
    MONETIZATION_OS_ENDPOINTS_PREFIX?: string
    SURFACE_DECISIONS_IGNORE_PATHS?: string
    SURFACE_DECISIONS_COOKIES?: string
    ORIGIN_REQUEST_HEADERS?: Record<string, string>
    /** Shared secret CloudFront sends as x-mos-origin-verify. */
    ORIGIN_VERIFY_SECRET?: string
}

// Wrangler parses JSON vars itself; an env var arrives as a string.
const parseHeaders = (value: string | undefined): Record<string, string> | undefined => {
    if (!value) return undefined
    try {
        return JSON.parse(value)
    } catch {
        console.warn('ORIGIN_REQUEST_HEADERS is not valid JSON; ignoring')
        return undefined
    }
}

export const env: Env = {
    ...(process.env as Omit<Env, 'ORIGIN_REQUEST_HEADERS'>),
    ORIGIN_REQUEST_HEADERS: parseHeaders(process.env.ORIGIN_REQUEST_HEADERS),
}
