import type { RouteRequest, RouteResponse } from '../context.ts';
export declare function writeJson(res: RouteResponse, status: number, body: unknown, headers?: Record<string, string>): void;
/**
 * Same-origin / loopback fence: refuses anything that isn't coming from the
 * local web UI, so the JSON API never becomes an open localhost endpoint.
 */
export declare function isTrustedApiRequest(req: RouteRequest): boolean;
/** Collect a JSON request body (IncomingMessage shaped). */
export declare function readJsonBody(req: RouteRequest): Promise<unknown>;
