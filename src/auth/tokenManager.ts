import * as vscode from 'vscode';
import * as crypto from 'crypto';

/**
 * TokenManager — Securely manages API bearer tokens using VS Code's SecretStorage.
 * 
 * Supports multiple active tokens, generation with prefixes, revocation,
 * and validation. All tokens are stored encrypted via the IDE's secret storage.
 */

export interface StoredToken {
    id: string;
    token: string;
    label: string;
    createdAt: number;
    lastUsedAt: number | null;
    usageCount: number;
}

const TOKENS_STORAGE_KEY = 'lmBridge.apiTokens';

export class TokenManager {
    private tokens: StoredToken[] = [];
    private readonly _onDidChangeTokens = new vscode.EventEmitter<StoredToken[]>();
    public readonly onDidChangeTokens = this._onDidChangeTokens.event;

    constructor(private readonly secrets: vscode.SecretStorage) {}

    /**
     * Load tokens from secret storage. Must be called during activation.
     */
    async initialize(): Promise<void> {
        const raw = await this.secrets.get(TOKENS_STORAGE_KEY);
        if (raw) {
            try {
                this.tokens = JSON.parse(raw);
            } catch {
                this.tokens = [];
            }
        }
    }

    /**
     * Generate a new API token with a human-readable prefix.
     */
    async generateToken(label?: string): Promise<StoredToken> {
        const id = crypto.randomUUID();
        const randomPart = crypto.randomBytes(32).toString('base64url');
        const token = `sk-lmb-${randomPart}`;

        const stored: StoredToken = {
            id,
            token,
            label: label || `Token ${this.tokens.length + 1}`,
            createdAt: Date.now(),
            lastUsedAt: null,
            usageCount: 0,
        };

        this.tokens.push(stored);
        await this.persist();
        this._onDidChangeTokens.fire(this.tokens);
        return stored;
    }

    /**
     * Validate a token from an incoming request. Returns true if valid.
     * Also updates the lastUsedAt timestamp and usage count.
     */
    async validateToken(token: string): Promise<boolean> {
        const found = this.tokens.find(t => t.token === token);
        if (!found) {
            return false;
        }
        found.lastUsedAt = Date.now();
        found.usageCount++;
        // Persist usage stats periodically (every 10 uses to avoid excessive writes)
        if (found.usageCount % 10 === 0) {
            await this.persist();
        }
        return true;
    }

    /**
     * Revoke (delete) a specific token by its ID.
     */
    async revokeToken(tokenId: string): Promise<boolean> {
        const index = this.tokens.findIndex(t => t.id === tokenId);
        if (index === -1) {
            return false;
        }
        this.tokens.splice(index, 1);
        await this.persist();
        this._onDidChangeTokens.fire(this.tokens);
        return true;
    }

    /**
     * Revoke all tokens.
     */
    async revokeAll(): Promise<void> {
        this.tokens = [];
        await this.persist();
        this._onDidChangeTokens.fire(this.tokens);
    }

    /**
     * Get all stored tokens (with full token values for display in the control panel).
     */
    getTokens(): StoredToken[] {
        return [...this.tokens];
    }

    /**
     * Get a masked version of tokens for safe display.
     */
    getMaskedTokens(): Array<Omit<StoredToken, 'token'> & { maskedToken: string }> {
        return this.tokens.map(t => ({
            id: t.id,
            label: t.label,
            maskedToken: this.maskToken(t.token),
            createdAt: t.createdAt,
            lastUsedAt: t.lastUsedAt,
            usageCount: t.usageCount,
        }));
    }

    /**
     * Check if any tokens exist.
     */
    hasTokens(): boolean {
        return this.tokens.length > 0;
    }

    /**
     * Get the full token value by ID (for copy-to-clipboard).
     */
    getTokenValue(tokenId: string): string | undefined {
        return this.tokens.find(t => t.id === tokenId)?.token;
    }

    private maskToken(token: string): string {
        if (token.length <= 12) {
            return '****';
        }
        return token.substring(0, 8) + '...' + token.substring(token.length - 4);
    }

    private async persist(): Promise<void> {
        await this.secrets.store(TOKENS_STORAGE_KEY, JSON.stringify(this.tokens));
    }
}
