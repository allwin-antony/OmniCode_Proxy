import * as http from 'http';
import * as vscode from 'vscode';
import { Router } from './router.js';
import { AuthMiddleware } from './middleware.js';
import { StatusBarManager, ServerState } from '../statusBar.js';
import { RequestLogger } from '../logger.js';

/**
 * HTTPServer — Manages the Node.js HTTP server lifecycle.
 * Wires together the router and auth middleware.
 */

export class HTTPServer {
    private server: http.Server | null = null;
    private port: number = 11434;
    private host: string = '127.0.0.1';

    private readonly _onStateChange = new vscode.EventEmitter<ServerState>();
    public readonly onStateChange = this._onStateChange.event;

    constructor(
        private readonly router: Router,
        private readonly authMiddleware: AuthMiddleware,
        private readonly statusBar: StatusBarManager,
        private readonly logger: RequestLogger
    ) {}

    /**
     * Start the HTTP server.
     */
    async start(): Promise<void> {
        if (this.server) {
            vscode.window.showWarningMessage('Omni Bridge server is already running.');
            return;
        }

        // Read current settings
        const config = vscode.workspace.getConfiguration('omniBridge');
        this.port = config.get<number>('port', 11434);
        this.host = config.get<string>('host', '127.0.0.1');

        this.statusBar.update('starting');
        this._onStateChange.fire('starting');

        return new Promise<void>((resolve, reject) => {
            this.server = http.createServer(async (req, res) => {
                try {
                    // ─── Auth check ───
                    const authResult = await this.authMiddleware.authenticate(req);
                    if (!authResult.authorized) {
                        this.authMiddleware.sendUnauthorized(res, authResult.error || 'Unauthorized');
                        this.logger.log({
                            method: req.method || 'UNKNOWN',
                            path: req.url || '/',
                            statusCode: 401,
                            responseTimeMs: 0,
                            tokenMasked: 'invalid',
                        });
                        return;
                    }

                    // ─── Route request ───
                    this.statusBar.incrementRequests();
                    await this.router.handle(req, res);
                } catch (err) {
                    console.error('[Omni Bridge] Unhandled request error:', err);
                    if (!res.headersSent) {
                        res.writeHead(500, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({
                            error: { message: 'Internal server error', type: 'api_error', code: 500 },
                        }));
                    }
                }
            });

            this.server.on('error', (err: NodeJS.ErrnoException) => {
                if (err.code === 'EADDRINUSE') {
                    this.statusBar.update('error');
                    this._onStateChange.fire('error');
                    vscode.window.showErrorMessage(
                        `Omni Bridge: Port ${this.port} is already in use. Change the port in settings.`,
                        'Open Settings'
                    ).then(choice => {
                        if (choice === 'Open Settings') {
                            vscode.commands.executeCommand(
                                'workbench.action.openSettings',
                                '@ext:lm-bridge.omniBridge.port'
                            );
                        }
                    });
                    this.server = null;
                    reject(err);
                } else {
                    this.statusBar.update('error');
                    this._onStateChange.fire('error');
                    vscode.window.showErrorMessage(`Omni Bridge server error: ${err.message}`);
                    this.server = null;
                    reject(err);
                }
            });

            this.server.listen(this.port, this.host, () => {
                this.statusBar.update('running', this.port);
                this._onStateChange.fire('running');
                vscode.window.showInformationMessage(
                    `Omni Bridge server started on http://${this.host}:${this.port}/v1`
                );
                resolve();
            });

            // Graceful timeout handling
            this.server.setTimeout(
                config.get<number>('requestTimeout', 120000)
            );
        });
    }

    /**
     * Stop the HTTP server gracefully.
     */
    async stop(): Promise<void> {
        return new Promise<void>((resolve) => {
            if (!this.server) {
                this.statusBar.update('stopped');
                this._onStateChange.fire('stopped');
                resolve();
                return;
            }

            this.server.close(() => {
                this.server = null;
                this.statusBar.update('stopped');
                this._onStateChange.fire('stopped');
                vscode.window.showInformationMessage('Omni Bridge server stopped.');
                resolve();
            });

            // Force close after 5 seconds if connections are hanging
            setTimeout(() => {
                if (this.server) {
                    this.server.closeAllConnections();
                }
            }, 5000);
        });
    }

    /**
     * Restart the server (stop → apply new settings → start).
     */
    async restart(): Promise<void> {
        await this.stop();
        this.router.refreshSettings();
        this.logger.readLogLevel();
        await this.start();
    }

    /**
     * Check if the server is currently running.
     */
    isRunning(): boolean {
        return this.server !== null && this.server.listening;
    }

    /**
     * Get the current server endpoint URL.
     */
    getEndpointUrl(): string {
        return `http://${this.host === '0.0.0.0' ? 'localhost' : this.host}:${this.port}/v1`;
    }

    /**
     * Get server info for the control panel.
     */
    getServerInfo(): {
        running: boolean;
        port: number;
        host: string;
        endpoint: string;
        uptimeSeconds: number;
    } {
        return {
            running: this.isRunning(),
            port: this.port,
            host: this.host,
            endpoint: this.getEndpointUrl(),
            uptimeSeconds: this.statusBar.getUptimeSeconds(),
        };
    }

    dispose(): void {
        if (this.server) {
            this.server.close();
            this.server = null;
        }
        this._onStateChange.dispose();
    }
}
