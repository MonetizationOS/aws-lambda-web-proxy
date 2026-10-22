// The specs mutate `env` and then re-import the worker. Writing through to process.env
// means a re-imported src/env.ts sees the change, so those tests run unmodified.
const KEYS = [
    'ORIGIN_URL',
    'SURFACE_SLUG',
    'AUTHENTICATED_USER_JWT_COOKIE_NAME',
    'ANONYMOUS_SESSION_COOKIE_NAME',
    'INJECT_SCRIPT_URL',
    'MONETIZATION_OS_HOST',
    'MONETIZATION_OS_ENDPOINTS_PREFIX',
    'MONETIZATION_OS_SECRET_KEY',
    'ORIGIN_REQUEST_HEADERS',
    'SURFACE_DECISIONS_IGNORE_PATHS',
    'SURFACE_DECISIONS_COOKIES',
]
const JSON_KEYS = new Set(['ORIGIN_REQUEST_HEADERS'])

export const env = new Proxy({} as Env, {
    get: (_, key: string) => {
        const value = process.env[key]
        return value !== undefined && JSON_KEYS.has(key) ? JSON.parse(value) : value
    },
    set: (_, key: string, value: unknown) => {
        if (value === undefined) delete process.env[key]
        else process.env[key] = typeof value === 'string' ? value : JSON.stringify(value)
        return true
    },
    ownKeys: () => KEYS,
    getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
})
