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
import { extractBearerToken } from './headers.js';

export interface AuthenticatedUser {
  email: string;
  sub: string;
  scope?: string;
  expiresIn?: number;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
      accessToken?: string;
    }
  }
}

export interface AuthMiddlewareOptions {
  allowedDomains?: string[];
  requireAuth?: boolean;
  expectedAudience?: string;
}

/**
 * Server-side token authentication and domain verification middleware.
 * Enforces Mitigation #2 from the Admin Migration Report.
 */
export function createTokenAuthMiddleware(options: AuthMiddlewareOptions = {}) {
  const allowedDomains = (options.allowedDomains || process.env.ALLOWED_AUTH_DOMAINS?.split(',') || []).map(d =>
    d.trim().toLowerCase().replace(/^@/, '')
  );
  const expectedAudience = options.expectedAudience || process.env.EXPECTED_OAUTH_CLIENT_ID || process.env.OAUTH_CLIENT_ID;

  return async (req: Request, res: Response, next: NextFunction) => {
    // Prohibit passing access tokens in request body
    if (req.body && req.body.accessToken) {
      return res.status(400).json({
        error: 'InsecureTokenTransport',
        message: 'Security Policy Violation: Access tokens must be passed exclusively in the Authorization header.'
      });
    }

    const token = extractBearerToken(req.headers.authorization);

    if (!token) {
      if (options.requireAuth !== false) {
        return res.status(401).json({
          error: 'Unauthorized',
          message: 'Missing or malformed Authorization header with Bearer token.'
        });
      }
      return next();
    }

    try {
      const tokenInfoRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(token)}`);
      
      if (!tokenInfoRes.ok) {
        return res.status(401).json({
          error: 'InvalidToken',
          message: 'Supplied OAuth Bearer token failed verification with Google Identity Provider.'
        });
      }

      const tokenData: any = await tokenInfoRes.json();
      const userEmail = (tokenData.email || '').toLowerCase();

      // Check expected audience if configured (Mitigation for token misuse across apps)
      if (expectedAudience) {
        const tokenAud = tokenData.aud || tokenData.audience;
        if (!tokenAud || tokenAud !== expectedAudience) {
          return res.status(403).json({
            error: 'InvalidAudience',
            message: `OAuth token audience does not match configured expected audience.`
          });
        }
      }

      // Check allowed domain if configured
      if (allowedDomains.length > 0) {
        const userDomain = userEmail.split('@')[1];
        const isAllowed = allowedDomains.some(domain => userDomain === domain || domain === '*');

        if (!isAllowed) {
          return res.status(403).json({
            error: 'ForbiddenDomain',
            message: `User identity domain "${userDomain}" is not authorized to execute admin migration workflows.`
          });
        }
      }

      req.user = {
        email: userEmail,
        sub: tokenData.sub || tokenData.user_id,
        scope: tokenData.scope,
        expiresIn: Number(tokenData.expires_in)
      };
      req.accessToken = token;

      next();
    } catch (err: any) {
      return res.status(500).json({
        error: 'AuthenticationVerificationFailed',
        message: `Token verification request failed: ${err.message}`
      });
    }
  };
}
