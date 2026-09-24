/**
 * Copyright 2026 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { Request, Response, NextFunction } from 'express';

/**
 * DNS rebinding protection.
 *
 * The console binds to 127.0.0.1 and treats "it's loopback" as sufficient
 * justification to skip authentication. That reasoning has a hole: a hostname an
 * attacker controls can be made to resolve to 127.0.0.1. A victim who visits the
 * attacker's page then has their own browser issue requests to this server, from
 * the attacker's origin, carrying whatever ambient authority the server grants to
 * "local" callers.
 *
 * CORS does not close this. CORS governs whether the *response* may be read; it
 * does not prevent the request from being dispatched and executing its side
 * effects. Simple requests (GET, and POST with form/text content types) are sent
 * without any preflight at all.
 *
 * The standard mitigation is to validate the `Host` header, because a rebinding
 * attack cannot forge it: the browser sets it to the attacker-controlled hostname
 * that was rebound, never to `127.0.0.1`.
 */

/** Hostnames that legitimately reach a loopback-bound server. */
const DEFAULT_ALLOWED_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export interface HostAllowlistOptions {
  /** Extra hostnames to permit, e.g. when deliberately bound to a LAN address. */
  additionalHostnames?: string[];
  /** The host the server is bound to; always permitted. */
  boundHost?: string;
}

/**
 * Strips the port from a Host header value, handling bracketed IPv6 literals.
 * Returns the bare hostname, lowercased.
 */
export function parseHostname(hostHeader: string | undefined): string | undefined {
  if (!hostHeader) return undefined;
  const value = hostHeader.trim().toLowerCase();
  if (!value) return undefined;

  // Bracketed IPv6, e.g. "[::1]:8080" or "[::1]".
  if (value.startsWith('[')) {
    const closing = value.indexOf(']');
    if (closing === -1) return undefined; // Malformed.
    return value.slice(0, closing + 1);
  }

  // A bare IPv6 literal contains multiple colons and carries no port.
  const firstColon = value.indexOf(':');
  if (firstColon === -1) return value;
  if (value.indexOf(':', firstColon + 1) !== -1) return value;

  return value.slice(0, firstColon);
}

export function createHostAllowlistMiddleware(options: HostAllowlistOptions = {}) {
  const allowed = new Set(DEFAULT_ALLOWED_HOSTNAMES);

  for (const extra of options.additionalHostnames || []) {
    const normalized = extra.trim().toLowerCase();
    if (normalized) allowed.add(normalized);
  }

  const boundHost = options.boundHost?.trim().toLowerCase();
  if (boundHost && boundHost !== '0.0.0.0' && boundHost !== '::') {
    allowed.add(boundHost);
  }

  return (req: Request, res: Response, next: NextFunction) => {
    const hostname = parseHostname(req.headers.host);

    // A missing Host header is an HTTP/1.1 protocol violation. Reject rather than
    // guess, since "no Host" would otherwise bypass the check entirely.
    if (!hostname) {
      return res.status(403).json({
        error: 'ForbiddenHost',
        message: 'Request rejected: missing or malformed Host header.'
      });
    }

    const isCloudShellHost = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.cloudshell\.dev$/i.test(hostname);
    if (!allowed.has(hostname) && !isCloudShellHost) {
      return res.status(403).json({
        error: 'ForbiddenHost',
        message:
          `Request rejected: Host header "${hostname}" is not an allowed hostname for this console. ` +
          'This protects against DNS rebinding. Set MIGRATION_ALLOWED_HOSTNAMES if you are ' +
          'intentionally reaching this server via another name.'
      });
    }

    return next();
  };
}
