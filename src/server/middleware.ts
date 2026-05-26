import * as http from 'http';
import * as vscode from 'vscode';
import { TokenManager } from '../auth/tokenManager.js';

/**
 * AuthMiddleware — Validates Bearer tokens on incoming HTTP requests.
 * Can be enabled/disabled via settings.
 */

export interface AuthResult {
    authorized: boolean;
    maskedToken?: string;
    error?: string;
}

export class AuthMiddleware {
    constructor(private readonly tokenManager: TokenManager) {}

    /**
     * Check if authentication is enabled in settings.
     */
    isEnabled(): boolean {
        return vscode.workspace.getConfiguration('lmBridge').get<boolean>('authEnabled', true);
    }

    /**
     * Validate the incoming request's Authorization header.
     * Returns AuthResult indicating whether the request is authorized.
     */
    async authenticate(req: http.IncomingMessage): Promise<AuthResult> {
        // If auth is disabled, allow everything
        if (!this.isEnabled()) {
            return { authorized: true };
        }

        // Check if any tokens exist — if not, warn and allow (first-time setup)
        if (!this.tokenManager.hasTokens()) {
            return { authorized: true };
        }

        const authHeader = req.headers['authorization'];
        if (!authHeader) {
            return {
                authorized: false,
                error: 'Missing Authorization header. Use: Authorization: Bearer <your-token>',
            };
        }

        const parts = authHeader.split(' ');
        if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer') {
            return {
                authorized: false,
                error: 'Invalid Authorization format. Expected: Bearer <token>',
            };
        }

        const token = parts[1];
        const valid = await this.tokenManager.validateToken(token);

        if (!valid) {
            return {
                authorized: false,
                error: 'Invalid API token.',
            };
        }

        return {
            authorized: true,
            maskedToken: token.substring(0, 8) + '...',
        };
    }

    /**
     * Send a 401 Unauthorized response.
     */
    sendUnauthorized(res: http.ServerResponse, message: string): void {
        res.writeHead(401, {
            'Content-Type': 'application/json',
            'WWW-Authenticate': 'Bearer',
        });
        res.end(JSON.stringify({
            error: {
                message,
                type: 'authentication_error',
                code: 401,
            },
        }));
    }
}
