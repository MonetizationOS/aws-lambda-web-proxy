import type { RequestListener, ServerResponse } from 'node:http'
import { BadRequestError, isFromFrontDoor, sendResponse, toFetchRequest } from './nodeHttp.js'

/** Adapts a fetch-style handler (the Workers `fetch` shape) to a Node request listener. */
export function createRequestListener(
    handle: (request: Request) => Promise<Response>,
    { originVerifySecret }: { originVerifySecret?: string | undefined } = {},
): RequestListener {
    return async (req, res) => {
        const started = performance.now()
        // Query strings can carry tokens, so logs get the path only.
        const path = req.url?.split('?')[0]

        if (!isFromFrontDoor(req, originVerifySecret)) {
            res.writeHead(403).end()
            return
        }

        // Abort the origin / MOS fetches if the viewer goes away mid-request.
        const abort = new AbortController()
        res.on('close', () => {
            if (!res.writableFinished) abort.abort()
        })

        try {
            const response = await handle(await toFetchRequest(req, abort.signal))
            await sendResponse(req, res, response)
        } catch (error) {
            if (error instanceof BadRequestError) {
                sendError(res, 400)
                return
            }
            if (!abort.signal.aborted) {
                const cause = (error as Error)?.cause
                console.error({
                    path,
                    error: error instanceof Error ? error.stack : String(error),
                    ...(cause === undefined ? {} : { cause: String(cause) }),
                })
            }
            sendError(res, 502)
        } finally {
            // An object, not a JSON string, so Lambda logs queryable fields and adds its requestId.
            console.log({ method: req.method, path, status: res.statusCode, ms: Math.round(performance.now() - started) })
        }
    }
}

// Headers the origin response already set, cookies included, don't belong on an error.
function sendError(res: ServerResponse, status: number): void {
    if (!res.headersSent) {
        for (const name of res.getHeaderNames()) res.removeHeader(name)
        res.writeHead(status)
    }
    res.end()
}
