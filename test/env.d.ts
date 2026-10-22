import type { Env as ProxyEnv } from '../src/env'

// Stands in for the Cloudflare proxy worker's generated worker-configuration.d.ts.
declare global {
    interface Env extends ProxyEnv {}
}
