export function writeJson(res, status, body, headers) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
    res.end(JSON.stringify(body));
}
/**
 * A route failure that carries the HTTP status the handler should answer with.
 * Client-side mistakes (bad id, oversized body) are 4xx; anything else is a
 * 5xx, so the panel and any log reader can tell "you asked wrong" from "the
 * host is broken".
 */
export class ApiError extends Error {
    status;
    constructor(status, message) {
        super(message);
        this.name = 'ApiError';
        this.status = status;
    }
}
/** Same-origin / loopback fence: refuses anything that isn't coming from the
 *  local web UI, so the JSON API never becomes an open localhost endpoint. */
export function isTrustedApiRequest(req) {
    const host = req.headers.host;
    if (typeof host !== 'string' || host === '')
        return false;
    let hostUrl;
    try {
        hostUrl = new URL(`http://${host}`);
    }
    catch {
        return false;
    }
    const name = hostUrl.hostname;
    if (name !== 'localhost' && name !== '127.0.0.1' && name !== '::1' && name !== '[::1]')
        return false;
    if (req.headers['sec-fetch-site'] === 'cross-site')
        return false;
    const origin = req.headers.origin;
    if (origin === undefined)
        return true;
    try {
        return new URL(String(origin)).host === hostUrl.host;
    }
    catch {
        return false;
    }
}
/**
 * Every route body is a single small object (`{ sessionId }`); anything larger
 * is either a bug or an attempt to make the host buffer memory it never uses.
 */
const MAX_JSON_BODY_BYTES = 64 * 1024;
/** Collect a JSON request body (IncomingMessage shaped) with a hard size cap. */
export async function readJsonBody(req) {
    const chunks = [];
    let size = 0;
    let settled = false;
    await new Promise((resolve, reject) => {
        const emitter = req;
        emitter.on('data', (chunk) => {
            if (settled)
                return;
            if (chunk === null || chunk === undefined)
                return;
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
            size += buf.length;
            if (size > MAX_JSON_BODY_BYTES) {
                settled = true;
                chunks.length = 0;
                reject(new ApiError(413, '请求体过大'));
                return;
            }
            chunks.push(buf);
        });
        emitter.on('end', () => {
            if (settled)
                return;
            settled = true;
            resolve();
        });
        emitter.on('error', (err) => {
            if (settled)
                return;
            settled = true;
            reject(err);
        });
    });
    if (chunks.length === 0)
        return undefined;
    try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    }
    catch {
        return undefined;
    }
}
