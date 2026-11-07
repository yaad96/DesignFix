import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import type { Duplex } from 'stream';
import * as WebSocket from 'ws';
import { contentTypeFor, isAllowedHost, isOriginAllowed, resolveInside } from './requestGuards';

/**
 * Local server for the bundled DesignFix dashboard.
 *
 * It listens on 127.0.0.1 only and serves three things from one port: the
 * dashboard's static files, the WebSocket the dashboard talks to (/ws), and a
 * narrow proxy to the OpenAI API (/openai-proxy) that adds the user's key, so
 * the key never reaches the browser. Every request must name this server in
 * its Host header, and the socket and the proxy also require a matching
 * Origin, so neither other machines nor other web pages can use it.
 *
 * The module has no VS Code dependency: the extension supplies the key and the
 * connection handler.
 */

export interface DashboardServerOptions {
    /** Folder that holds the built dashboard (index.html and its assets). */
    dashboardRoot: string;
    /** Port to listen on. 0 lets the operating system pick a free port. */
    port: number;
    /** The user's OpenAI API key, or undefined when none is stored. */
    getApiKey: () => Thenable<string | undefined>;
    /** Receives each dashboard socket that passed the Host and Origin checks. */
    onConnection: (socket: WebSocket.WebSocket) => void;
}

const LISTEN_HOST = '127.0.0.1';
const OPENAI_HOST = 'api.openai.com';
const SOCKET_PATH = '/ws';
const KEY_STATUS_PATH = '/openai-key-status';
const PROXY_PREFIX = '/openai-proxy';

// Only the OpenAI endpoints the dashboard actually calls are forwarded.
const PROXIED_ENDPOINTS: ReadonlySet<string> = new Set(['POST /v1/chat/completions']);

// Request headers worth forwarding to OpenAI. Cookies, Origin, Referer and the
// SDK's placeholder Authorization header are dropped.
const FORWARDED_REQUEST_HEADERS: ReadonlySet<string> = new Set([
    'accept', 'accept-encoding', 'content-type', 'content-length', 'user-agent',
]);
const FORWARDED_REQUEST_HEADER_PREFIXES = ['openai-', 'x-stainless-'];

// Hop-by-hop and cookie headers are not relayed back to the browser.
const DROPPED_RESPONSE_HEADERS: ReadonlySet<string> = new Set([
    'connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'set-cookie',
]);

// Marks the page as served by the extension, so the dashboard opens its
// socket on this origin instead of the development port.
const EMBEDDED_MARKER = '<script>window.__DESIGNFIX_EMBEDDED__=true;</script>';

const SECURITY_HEADERS: Readonly<Record<string, string>> = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
};

export class DashboardServer {
    private server: http.Server | null = null;
    private readonly socketServer = new WebSocket.WebSocketServer({ noServer: true });
    private readonly authorities = new Set<string>();
    private boundPort = 0;

    constructor(private readonly options: DashboardServerOptions) { }

    /** Start listening and resolve with the bound port. Safe to call twice. */
    public start(): Promise<number> {
        if (this.server) {
            return Promise.resolve(this.boundPort);
        }
        return new Promise((resolve, reject) => {
            const server = http.createServer((req, res) => {
                this.handleRequest(req, res).catch((error) => {
                    console.error('DesignFix dashboard request failed:', error);
                    if (!res.headersSent) {
                        this.send(res, 500, 'text/plain; charset=utf-8', 'Internal error');
                    } else {
                        res.destroy();
                    }
                });
            });
            server.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket, head));
            server.once('error', reject);
            server.listen(this.options.port, LISTEN_HOST, () => {
                server.off('error', reject);
                server.on('error', (error) => console.error('DesignFix dashboard server error:', error));
                const address = server.address();
                this.boundPort = typeof address === 'object' && address ? address.port : this.options.port;
                this.allowAuthority(`${LISTEN_HOST}:${this.boundPort}`);
                this.allowAuthority(`localhost:${this.boundPort}`);
                this.server = server;
                resolve(this.boundPort);
            });
        });
    }

    /** The dashboard's address on this machine. */
    public get url(): string {
        return `http://${LISTEN_HOST}:${this.boundPort}/`;
    }

    /**
     * Also accept requests addressed to `authority`, for example the forwarded
     * address VS Code assigns this port in remote development.
     */
    public allowAuthority(authority: string): void {
        if (authority) {
            this.authorities.add(authority.trim().toLowerCase());
        }
    }

    public dispose(): void {
        for (const client of this.socketServer.clients) {
            client.terminate();
        }
        this.socketServer.close();
        if (this.server) {
            this.server.close();
            this.server.closeAllConnections?.();
            this.server = null;
        }
    }

    private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!isAllowedHost(req.headers.host, this.authorities)) {
            this.send(res, 403, 'text/plain; charset=utf-8', 'Forbidden');
            return;
        }
        const url = parseRequestUrl(req.url);
        if (!url) {
            this.send(res, 400, 'text/plain; charset=utf-8', 'Bad request');
            return;
        }
        if (url.pathname === KEY_STATUS_PATH && req.method === 'GET') {
            const apiKey = await this.options.getApiKey();
            this.sendJson(res, 200, { configured: Boolean(apiKey) });
            return;
        }
        if (url.pathname.startsWith(`${PROXY_PREFIX}/`)) {
            await this.proxyToOpenAI(req, res, url.pathname.slice(PROXY_PREFIX.length), url.search);
            return;
        }
        if (req.method !== 'GET' && req.method !== 'HEAD') {
            this.send(res, 405, 'text/plain; charset=utf-8', 'Method not allowed');
            return;
        }
        await this.serveStatic(req, res, url.pathname);
    }

    private async serveStatic(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): Promise<void> {
        let relativePath: string;
        try {
            relativePath = decodeURIComponent(pathname).replace(/^\/+/, '');
        } catch {
            this.send(res, 400, 'text/plain; charset=utf-8', 'Bad request');
            return;
        }
        if (relativePath === '') {
            relativePath = 'index.html';
        }
        const isHead = req.method === 'HEAD';
        const filePath = resolveInside(this.options.dashboardRoot, relativePath);
        const stat = filePath ? await fs.promises.stat(filePath).catch(() => undefined) : undefined;
        if (!filePath || !stat || !stat.isFile()) {
            if (relativePath === 'index.html') {
                this.send(res, 503, 'text/plain; charset=utf-8',
                    'This copy of DesignFix does not include the dashboard. '
                    + 'Build it with "npm run build:dashboard" in the DesignFix-Extension folder.', {}, isHead);
            } else {
                this.send(res, 404, 'text/plain; charset=utf-8', 'Not found', {}, isHead);
            }
            return;
        }
        if (relativePath === 'index.html') {
            const html = await fs.promises.readFile(filePath, 'utf8');
            const page = html.includes('<head>')
                ? html.replace('<head>', `<head>${EMBEDDED_MARKER}`)
                : EMBEDDED_MARKER + html;
            this.send(res, 200, 'text/html; charset=utf-8', page, { 'Cache-Control': 'no-store' }, isHead);
            return;
        }
        res.writeHead(200, {
            ...SECURITY_HEADERS,
            'Content-Type': contentTypeFor(filePath),
            'Content-Length': stat.size,
            'Cache-Control': 'no-cache',
        });
        if (isHead) {
            res.end();
            return;
        }
        fs.createReadStream(filePath).on('error', () => res.destroy()).pipe(res);
    }

    private async proxyToOpenAI(
        req: http.IncomingMessage,
        res: http.ServerResponse,
        apiPath: string,
        search: string
    ): Promise<void> {
        if (!isOriginAllowed(req.headers.origin, this.authorities)) {
            this.sendJson(res, 403, { error: { message: 'Only the DesignFix dashboard may use this proxy.' } });
            return;
        }
        if (!PROXIED_ENDPOINTS.has(`${req.method} ${apiPath}`)) {
            this.sendJson(res, 404, { error: { message: `DesignFix does not forward ${req.method} ${apiPath}.` } });
            return;
        }
        const apiKey = await this.options.getApiKey();
        if (!apiKey) {
            this.sendJson(res, 400, {
                error: { message: 'No OpenAI API key is set. In VS Code, run "DesignFix: Set OpenAI API Key".' },
            });
            return;
        }

        const headers: http.OutgoingHttpHeaders = {};
        for (const [name, value] of Object.entries(req.headers)) {
            const lower = name.toLowerCase();
            const forwarded = FORWARDED_REQUEST_HEADERS.has(lower)
                || FORWARDED_REQUEST_HEADER_PREFIXES.some((prefix) => lower.startsWith(prefix));
            if (value !== undefined && forwarded) {
                headers[lower] = value;
            }
        }
        headers.authorization = `Bearer ${apiKey}`;
        headers.host = OPENAI_HOST;

        await new Promise<void>((resolve) => {
            const upstream = https.request(
                { host: OPENAI_HOST, port: 443, method: req.method, path: apiPath + search, headers },
                (upstreamRes) => {
                    const responseHeaders: http.OutgoingHttpHeaders = { ...SECURITY_HEADERS };
                    for (const [name, value] of Object.entries(upstreamRes.headers)) {
                        if (value !== undefined && !DROPPED_RESPONSE_HEADERS.has(name.toLowerCase())) {
                            responseHeaders[name] = value;
                        }
                    }
                    res.writeHead(upstreamRes.statusCode ?? 502, responseHeaders);
                    upstreamRes.pipe(res);
                    upstreamRes.on('end', () => resolve());
                    upstreamRes.on('error', () => {
                        res.destroy();
                        resolve();
                    });
                }
            );
            upstream.on('error', (error) => {
                if (!res.headersSent) {
                    this.sendJson(res, 502, { error: { message: `DesignFix could not reach the OpenAI API: ${error.message}` } });
                } else {
                    res.destroy();
                }
                resolve();
            });
            req.pipe(upstream);
        });
    }

    private handleUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
        const url = parseRequestUrl(req.url);
        if (!url || url.pathname !== SOCKET_PATH
            || !isAllowedHost(req.headers.host, this.authorities)
            || !isOriginAllowed(req.headers.origin, this.authorities)) {
            socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
            socket.destroy();
            return;
        }
        this.socketServer.handleUpgrade(req, socket, head, (client) => this.options.onConnection(client));
    }

    private sendJson(res: http.ServerResponse, status: number, body: unknown): void {
        this.send(res, status, 'application/json; charset=utf-8', JSON.stringify(body));
    }

    private send(
        res: http.ServerResponse,
        status: number,
        contentType: string,
        body: string,
        extraHeaders: Record<string, string> = {},
        omitBody = false
    ): void {
        res.writeHead(status, {
            ...SECURITY_HEADERS,
            ...extraHeaders,
            'Content-Type': contentType,
            'Content-Length': Buffer.byteLength(body),
        });
        res.end(omitBody ? undefined : body);
    }
}

function parseRequestUrl(rawUrl: string | undefined): URL | undefined {
    try {
        return new URL(rawUrl || '/', 'http://localhost');
    } catch {
        return undefined;
    }
}
