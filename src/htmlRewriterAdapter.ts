import { setImmediate } from 'node:timers/promises'
import type { ElementHandlers, HtmlRewriterAdapter, HtmlRewriterCapabilities, HtmlRewriterSession } from '@monetizationos/proxy'
import { Element, type ElementContentHandlers, type EndTag, HTMLRewriter, type TextChunk } from '../vendor/lol-html/dist/lol_html.js'

// The core hands each pass the whole page as one chunk, and a WASM write runs synchronously, so a
// 2 MB page would hold the event loop for ~30 ms per pass. Slicing and yielding between slices
// lets other requests in the environment run, at no measurable cost in total rewrite time.
const WRITE_SLICE_BYTES = 16 * 1024

const NULL_BODY_STATUSES = new Set([101, 204, 205, 304])

// Each handler argument owns a small WASM allocation that only free() or a later GC finaliser
// releases, and GC rarely runs since the JS side is tiny: ~200 KB leaked per 300 KB page. They are
// only valid during the handler anyway, as on Cloudflare, so free them as soon as it returns.
const freeAfter =
    <T extends { free(): void }>(handler: (arg: T) => unknown) =>
    (arg: T) => {
        try {
            if (handler(arg) instanceof Promise) throw new TypeError('HTML rewriter handlers must be synchronous')
        } finally {
            arg.free()
        }
    }

// A throw inside an end-tag handler traps the WASM instance (lol-html's JS API unwraps it), so it
// is held here and rethrown once the write returns. Writes are synchronous, so one slot is enough.
let endTagError: { error: unknown } | undefined

const throwEndTagError = () => {
    const pending = endTagError
    endTagError = undefined
    if (pending) throw pending.error
}

const onEndTag = Element.prototype.onEndTag
Element.prototype.onEndTag = function (this: Element, handler: (endTag: EndTag) => unknown) {
    onEndTag.call(
        this,
        freeAfter((endTag: EndTag) => {
            try {
                return handler(endTag)
            } catch (error) {
                endTagError ??= { error }
            }
        }),
    )
}

/**
 * lol-html backed HtmlRewriterAdapter for Node.js, using Cloudflare's lol-html JS API built to
 * WASM (see vendor/lol-html). Handlers must be synchronous, as the core's are.
 *
 * transform() returns a Response immediately; rewriting runs as its body is consumed.
 * Content-Encoding, Content-Length and Transfer-Encoding are dropped because the body is decoded.
 */
export class LolHtmlRewriterAdapter implements HtmlRewriterAdapter {
    readonly capabilities: HtmlRewriterCapabilities = { onEndTag: true, nthChild: true }

    create(): HtmlRewriterSession {
        return new LolHtmlSession()
    }
}

// The core learns a selector is invalid from on() throwing, before any transform, so selectors are
// checked against a throwaway rewriter. Component selectors repeat across requests, hence the cache.
const validSelectors = new Set<string>()

function assertValidSelector(selector: string): void {
    if (validSelectors.has(selector)) return
    const probe = new HTMLRewriter('utf-8', () => {})
    try {
        probe.on(selector, {})
    } finally {
        probe.free()
    }
    if (validSelectors.size >= 1024) validSelectors.clear()
    validSelectors.add(selector)
}

// The WASM rewriter only exists between transform() and the end of its body. The core creates
// sessions it never transforms, and a rewriter allocated for those would wait on GC to be freed.
class LolHtmlSession implements HtmlRewriterSession {
    private readonly handlers: [string, ElementContentHandlers][] = []
    private consumed = false

    // The vendored elements and text chunks match the core's interfaces. Handlers are called as
    // methods, since some of the core's use `this`.
    on(selector: string, handlers: ElementHandlers): this {
        assertValidSelector(selector)
        const h = handlers as unknown as Required<ElementContentHandlers>
        this.handlers.push([
            selector,
            {
                element: handlers.element ? freeAfter((el: Element) => h.element(el)) : undefined,
                text: handlers.text ? freeAfter((chunk: TextChunk) => h.text(chunk)) : undefined,
            },
        ])
        return this
    }

    transform(response: Response): Response {
        if (this.consumed) {
            throw new Error('LolHtmlSession can only transform a single response')
        }
        this.consumed = true

        const init = { status: response.status, statusText: response.statusText, headers: withoutWireEncoding(response.headers) }
        if (!response.body || NULL_BODY_STATUSES.has(response.status)) return new Response(null, init)

        // The vendored build hands over output once per write, not per token.
        const output: Uint8Array[] = []
        const rewriter = new HTMLRewriter('utf-8', (chunk) => output.push(chunk))
        let freed = false
        const free = () => {
            if (freed) return
            freed = true
            try {
                rewriter.free()
            } catch {
                // Only a trapped instance refuses; keep the original error.
            }
        }
        try {
            for (const [selector, handlers] of this.handlers) rewriter.on(selector, handlers)
        } catch (error) {
            free()
            throw error
        }

        const reader = response.body.getReader()
        // Pull-based so output streams as the origin body arrives, like Cloudflare's HTMLRewriter.
        const stream = new ReadableStream<Uint8Array>({
            async pull(controller) {
                try {
                    while (output.length === 0) {
                        const next = await reader.read()
                        if (next.done) {
                            rewriter.end()
                            throwEndTagError()
                            free()
                            enqueueAll(controller, output)
                            controller.close()
                            return
                        }
                        for (let offset = 0; offset < next.value.length; offset += WRITE_SLICE_BYTES) {
                            if (offset > 0) await setImmediate()
                            rewriter.write(next.value.subarray(offset, offset + WRITE_SLICE_BYTES))
                            throwEndTagError()
                        }
                    }
                    enqueueAll(controller, output)
                } catch (error) {
                    free()
                    reader.cancel(error).catch(() => {})
                    controller.error(error)
                }
            },
            async cancel(reason) {
                free()
                await reader.cancel(reason)
            },
        })

        return new Response(stream, init)
    }
}

const enqueueAll = (controller: ReadableStreamDefaultController<Uint8Array>, chunks: Uint8Array[]) => {
    if (chunks.length > 0) controller.enqueue(chunks.length === 1 ? (chunks.pop() as Uint8Array) : Buffer.concat(chunks.splice(0)))
}

const withoutWireEncoding = (headers: Headers): Headers => {
    const h = new Headers(headers)
    h.delete('content-encoding')
    h.delete('content-length')
    h.delete('transfer-encoding')
    return h
}
