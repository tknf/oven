/**
 * Host header validation middleware. Rejects requests with a spoofed Host header (e.g. via a
 * reverse proxy) in a fail-closed manner (implemented as a simple string comparison written
 * from scratch, rather than a thin wrapper around a Hono standard middleware).
 *
 * Two kinds of allow patterns are supported:
 * - Exact match (e.g. `"example.com"`)
 * - Leading-dot subdomain wildcard (e.g. `".example.com"` matches both `example.com` itself
 *   and any subdomain `*.example.com`)
 *
 * Before comparing, both the Host header and the allow list are lowercased, and the port
 * portion of the Host header (the `:8787` in `example.com:8787`) is stripped. If the Host
 * header is missing, or doesn't match any allow pattern, the request is rejected with a 400
 * `HTTPException` (fail-closed).
 */
import type { Context, Env, MiddlewareHandler, Next } from "hono";
import { HTTPException } from "hono/http-exception";

/** Strips the port portion from a Host header and lowercases it. Also handles IPv6 literal notation (`[::1]:8787`). */
const stripPortAndLowercase = (host: string): string => {
	const bracketMatch = host.match(/^\[(.+)\](?::\d+)?$/);
	if (bracketMatch?.[1]) return `[${bracketMatch[1].toLowerCase()}]`;

	const separatorIndex = host.lastIndexOf(":");
	const withoutPort = separatorIndex === -1 ? host : host.slice(0, separatorIndex);
	return withoutPort.toLowerCase();
};

/** Determines whether `host` matches the allow pattern `pattern`. */
const matchesPattern = (host: string, pattern: string): boolean => {
	if (pattern.startsWith(".")) {
		const bareDomain = pattern.slice(1);
		return host === bareDomain || host.endsWith(pattern);
	}
	return host === pattern;
};

/** Validates the request's Host header against an allow list, rejecting unmatched requests. */
export class TrustedHost<E extends Env = Env> {
	private readonly hosts: string[];

	constructor(hosts: string[]) {
		if (hosts.length === 0) {
			throw new Error(
				"TrustedHost requires at least one host (an empty array is a misconfiguration that rejects every request)",
			);
		}
		this.hosts = hosts.map((host) => host.toLowerCase());
	}

	/** An arrow-function class field so it can be passed by reference, e.g. `app.use(trustedHost.verify)`. */
	readonly verify: MiddlewareHandler<E> = async (c: Context<E>, next: Next) => {
		const rawHost = c.req.header("Host");
		if (!rawHost) {
			throw new HTTPException(400, { message: "Missing Host header" });
		}

		const host = stripPortAndLowercase(rawHost);
		const isTrusted = this.hosts.some((pattern) => matchesPattern(host, pattern));
		if (!isTrusted) {
			throw new HTTPException(400, { message: "Host not allowed" });
		}

		await next();
	};
}
