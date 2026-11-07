import * as path from 'path';

/*
 * Pure checks shared by the local dashboard server, the development socket,
 * and the handlers that write files on the dashboard's behalf. They have no
 * VS Code dependency so they can be unit tested directly.
 */

const LOOPBACK_ADDRESSES: ReadonlySet<string> = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** True when a TCP peer address belongs to this machine. */
export function isLoopbackAddress(address: string | undefined): boolean {
    return typeof address === 'string' && LOOPBACK_ADDRESSES.has(address);
}

/** Canonical form of a host[:port] authority, for comparisons. */
export function normalizeAuthority(authority: string): string {
    return authority.trim().toLowerCase();
}

/**
 * True when a request's Host header names one of the server's own
 * authorities. Rejecting every other Host value defeats DNS rebinding, where a
 * hostile domain is re-pointed at 127.0.0.1 so a web page can read local
 * responses.
 */
export function isAllowedHost(hostHeader: string | undefined, allowed: ReadonlySet<string>): boolean {
    return typeof hostHeader === 'string' && allowed.has(normalizeAuthority(hostHeader));
}

/** The host[:port] of an http(s) Origin header, or undefined for anything else. */
export function originAuthority(origin: string | undefined): string | undefined {
    if (typeof origin !== 'string' || origin.length === 0) {
        return undefined;
    }
    try {
        const url = new URL(origin);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
            return undefined;
        }
        return normalizeAuthority(url.host);
    } catch {
        return undefined;
    }
}

/**
 * True when an Origin header belongs to an allowed authority. Browsers always
 * send Origin on WebSocket handshakes and on POST requests, so this is what
 * stops an arbitrary web page from driving the extension.
 */
export function isOriginAllowed(origin: string | undefined, allowed: ReadonlySet<string>): boolean {
    const authority = originAuthority(origin);
    return authority !== undefined && allowed.has(authority);
}

/**
 * Resolve `relativePath` against `root` and return the result only when it
 * stays strictly inside `root`. Empty input, NUL bytes, absolute paths and any
 * `..` escape are rejected, so a name received from a client can never reach
 * other files.
 */
export function resolveInside(root: string, relativePath: string): string | undefined {
    if (typeof relativePath !== 'string' || relativePath.length === 0 || relativePath.includes('\0')) {
        return undefined;
    }
    const base = path.resolve(root);
    const target = path.resolve(base, relativePath);
    const prefix = base.endsWith(path.sep) ? base : base + path.sep;
    return target.startsWith(prefix) ? target : undefined;
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.eot': 'application/vnd.ms-fontobject',
    '.swf': 'application/x-shockwave-flash',
};

/** Content-Type for a static dashboard file, chosen by its extension. */
export function contentTypeFor(filePath: string): string {
    return CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}
