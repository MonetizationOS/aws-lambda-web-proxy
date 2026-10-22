import type { ClientIPProvider, ClientMetadataProvider } from '@monetizationos/proxy'

// The proxy calls the MOS API from an AWS Region, so the connection carries the Region's geo and
// network. The `edge` body carries the viewer's, from CloudFront's headers.

/** The subset of the MOS API `edge` body that CloudFront can fill. It has no bot verdict. */
export interface CloudfrontEdge {
    provider: 'cloudfront'
    requestId?: string
    geo: {
        countryCode?: string
        regionCode?: string
        region?: string
        city?: string
        postalCode?: string
        metroCode?: string
        latitude?: number
        longitude?: number
        timezone?: string
    }
    network?: { asn: number }
    tls?: { version?: string; httpProtocol?: string }
}

const compact = <T extends object>(value: T): T => Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T

const header = (headers: Headers, name: string): string | undefined => headers.get(name) || undefined

// CloudFront percent-encodes non-ASCII characters in the location headers.
const decoded = (value: string | undefined): string | undefined => {
    if (!value) return undefined
    try {
        return decodeURIComponent(value)
    } catch {
        return value
    }
}

const numeric = (value: string | undefined): number | undefined => {
    const n = value ? Number(value) : Number.NaN
    return Number.isFinite(n) ? n : undefined
}

// `CloudFront-Viewer-Http-Version` is a bare version; the API uses Cloudflare's `HTTP/2` style.
const httpProtocol = (version: string | undefined): string | undefined =>
    version ? `HTTP/${version.replace(/^([23])\.0$/, '$1')}` : undefined

/**
 * Maps CloudFront-Viewer-* headers to the MOS API `edge` body. Undefined when not behind CloudFront.
 * Sent for every request through CloudFront, even when it can't geolocate the viewer.
 * JA3/JA4 aren't read: the template's origin request policy can't forward them, so any present
 * would have come from the viewer.
 */
export function cloudfrontEdge(headers: Headers): CloudfrontEdge | undefined {
    const requestId = header(headers, 'x-amz-cf-id')
    const countryCode = header(headers, 'cloudfront-viewer-country')
    if (!requestId && !countryCode) return undefined

    const asn = numeric(header(headers, 'cloudfront-viewer-asn'))
    // `TLSv1.3:TLS_AES_128_GCM_SHA256:fullHandshake`
    const tls = compact({
        version: header(headers, 'cloudfront-viewer-tls')?.split(':')[0],
        httpProtocol: httpProtocol(header(headers, 'cloudfront-viewer-http-version')),
    })

    return compact<CloudfrontEdge>({
        provider: 'cloudfront',
        requestId,
        geo: compact({
            countryCode,
            regionCode: header(headers, 'cloudfront-viewer-country-region'),
            region: decoded(header(headers, 'cloudfront-viewer-country-region-name')),
            city: decoded(header(headers, 'cloudfront-viewer-city')),
            postalCode: header(headers, 'cloudfront-viewer-postal-code'),
            metroCode: header(headers, 'cloudfront-viewer-metro-code'),
            latitude: numeric(header(headers, 'cloudfront-viewer-latitude')),
            longitude: numeric(header(headers, 'cloudfront-viewer-longitude')),
            timezone: header(headers, 'cloudfront-viewer-time-zone'),
        }),
        network: asn === undefined ? undefined : { asn },
        tls: Object.keys(tls).length ? tls : undefined,
    })
}

/** `CloudFront-Viewer-Address` is `ip:port`; IPv6 addresses contain colons, so split on the last one. */
export const cloudfrontClientIP: ClientIPProvider = (request) => {
    const address = request.headers.get('cloudfront-viewer-address')
    if (!address) return undefined
    const lastColon = address.lastIndexOf(':')
    const ip = lastColon > 0 ? address.slice(0, lastColon) : address
    return ip.replace(/^\[|\]$/g, '')
}

export const cloudfrontMetadata: ClientMetadataProvider = {
    build(request) {
        const edge = cloudfrontEdge(request.headers)
        return edge ? { edge } : {}
    },
}
