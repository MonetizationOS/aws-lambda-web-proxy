// The Cloudflare proxy worker's wrangler.jsonc `test` env vars, as the revision environment would carry them.
Object.assign(process.env, {
    ORIGIN_URL: 'https://origin.example',
    SURFACE_SLUG: 'web',
    AUTHENTICATED_USER_JWT_COOKIE_NAME: 'jwt-cookie',
    ANONYMOUS_SESSION_COOKIE_NAME: 'anon-session',
    INJECT_SCRIPT_URL: 'https://example.com/web-components-latest.js',
    MONETIZATION_OS_HOST: 'https://api.monetizationos.com',
    MONETIZATION_OS_ENDPOINTS_PREFIX: '/mos-endpoints/',
    MONETIZATION_OS_SECRET_KEY: 'sk_test_123_key.payload',
    ORIGIN_REQUEST_HEADERS: '{}',
})
