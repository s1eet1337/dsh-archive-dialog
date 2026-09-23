export function writeJson(res, status, body, headers) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
    res.end(JSON.stringify(body));
}
/**
 * Same-origin / loopback fence: refuses anything that isn't coming from the
 * local web UI, so the JSON API never becomes an open localhost endpoint.
 */
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
/** Collect a JSON request body (IncomingMessage shaped). */
export async function readJsonBody(req) {
    const chunks = [];
    await new Promise((resolve, reject) => {
        const emitter = req;
        emitter.on('data', (chunk) => {
            if (chunk !== null && chunk !== undefined)
                chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
        });
        emitter.on('end', () => resolve());
        emitter.on('error', (err) => reject(err));
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
