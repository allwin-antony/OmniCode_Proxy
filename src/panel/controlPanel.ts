import * as vscode from 'vscode';
import { HTTPServer } from '../server/httpServer.js';
import { TokenManager, StoredToken } from '../auth/tokenManager.js';
import { ModelMapper } from '../bridge/modelMapper.js';
import { RequestLogger, LogEntry } from '../logger.js';

/**
 * ControlPanel — Webview-based dashboard for managing the Omni Bridge server.
 * 
 * Features:
 * - Server status & controls (start/stop/restart)
 * - Configuration editing
 * - API token management (generate/revoke/copy)
 * - Available model listing
 * - Quick-start guide with copyable curl commands
 * - Live request log
 */

export class ControlPanel {
    private panel: vscode.WebviewPanel | undefined;
    private disposables: vscode.Disposable[] = [];

    constructor(
        private readonly server: HTTPServer,
        private readonly tokenManager: TokenManager,
        private readonly modelMapper: ModelMapper,
        private readonly logger: RequestLogger,
        private readonly extensionUri: vscode.Uri
    ) {}

    /**
     * Open or reveal the Control Panel webview.
     */
    open(): void {
        if (this.panel) {
            this.panel.reveal(vscode.ViewColumn.One);
            this.sendFullState();
            return;
        }

        this.panel = vscode.window.createWebviewPanel(
            'omniBridgeControlPanel',
            'Omni Bridge — Control Panel',
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [this.extensionUri],
            }
        );

        this.panel.webview.html = this.getHtml();
        this.panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'resources', 'icon.png');

        // Handle messages from the webview
        this.panel.webview.onDidReceiveMessage(
            (msg) => this.handleMessage(msg),
            undefined,
            this.disposables
        );

        // Cleanup on close
        this.panel.onDidDispose(() => {
            this.panel = undefined;
            this.disposables.forEach(d => d.dispose());
            this.disposables = [];
        });

        // Wire up live updates
        this.disposables.push(
            this.logger.onDidLog((entry) => {
                this.postMessage({ type: 'logEntry', data: entry });
            }),
            this.server.onStateChange((state) => {
                this.postMessage({
                    type: 'serverState',
                    data: { state, ...this.server.getServerInfo(), stats: this.logger.getStats() },
                });
            }),
            this.tokenManager.onDidChangeTokens(() => {
                this.postMessage({
                    type: 'tokens',
                    data: this.tokenManager.getMaskedTokens(),
                });
            }),
            this.modelMapper.onDidChangeModels((models) => {
                this.postMessage({ type: 'models', data: models });
            })
        );

        // Send initial state
        setTimeout(() => this.sendFullState(), 100);
    }

    /**
     * Send full current state to the webview.
     */
    private sendFullState(): void {
        const config = vscode.workspace.getConfiguration('omniBridge');
        this.postMessage({
            type: 'fullState',
            data: {
                server: {
                    ...this.server.getServerInfo(),
                    state: this.server.isRunning() ? 'running' : 'stopped',
                    stats: this.logger.getStats(),
                },
                tokens: this.tokenManager.getMaskedTokens(),
                models: this.modelMapper.listModels(),
                logs: this.logger.getRecentLogs(50),
                config: {
                    port: config.get<number>('port', 11434),
                    host: config.get<string>('host', '127.0.0.1'),
                    autoStart: config.get<boolean>('autoStart', false),
                    authEnabled: config.get<boolean>('authEnabled', true),
                    defaultModel: config.get<string>('defaultModel', ''),
                    corsOrigins: config.get<string>('corsOrigins', '*'),
                    logLevel: config.get<string>('logLevel', 'info'),
                    maxConcurrentRequests: config.get<number>('maxConcurrentRequests', 5),
                    requestTimeout: config.get<number>('requestTimeout', 120000),
                },
            },
        });
    }

    /**
     * Handle messages from the webview.
     */
    private async handleMessage(msg: any): Promise<void> {
        switch (msg.type) {
            case 'getFullState':
                await this.modelMapper.refresh();
                this.sendFullState();
                break;

            case 'startServer':
                try {
                    await this.server.start();
                } catch (err) {
                    // Error already shown via notification
                }
                break;

            case 'stopServer':
                await this.server.stop();
                break;

            case 'restartServer':
                await this.server.restart();
                break;

            case 'generateToken': {
                const token = await this.tokenManager.generateToken(msg.label);
                this.postMessage({
                    type: 'tokenGenerated',
                    data: { id: token.id, token: token.token, label: token.label },
                });
                break;
            }

            case 'copyToken': {
                const value = this.tokenManager.getTokenValue(msg.tokenId);
                if (value) {
                    await vscode.env.clipboard.writeText(value);
                    vscode.window.showInformationMessage('API token copied to clipboard.');
                }
                break;
            }

            case 'revokeToken':
                await this.tokenManager.revokeToken(msg.tokenId);
                break;

            case 'revokeAllTokens': {
                const choice = await vscode.window.showWarningMessage(
                    'Are you sure you want to revoke all API tokens? This cannot be undone and will disconnect any active clients.',
                    { modal: true },
                    'Revoke All'
                );
                if (choice === 'Revoke All') {
                    await this.tokenManager.revokeAll();
                    vscode.window.showInformationMessage('All API tokens have been successfully revoked.');
                }
                break;
            }

            case 'copyEndpoint': {
                const url = this.server.getEndpointUrl();
                await vscode.env.clipboard.writeText(url);
                vscode.window.showInformationMessage(`Endpoint copied: ${url}`);
                break;
            }

            case 'copyCurl': {
                await vscode.env.clipboard.writeText(msg.command);
                vscode.window.showInformationMessage('curl command copied to clipboard.');
                break;
            }

            case 'saveConfig': {
                const config = vscode.workspace.getConfiguration('omniBridge');
                const settings = msg.data;
                const updates: Thenable<void>[] = [];

                if (settings.port !== undefined) {
                    updates.push(config.update('port', Number(settings.port), vscode.ConfigurationTarget.Global));
                }
                if (settings.host !== undefined) {
                    updates.push(config.update('host', settings.host, vscode.ConfigurationTarget.Global));
                }
                if (settings.autoStart !== undefined) {
                    updates.push(config.update('autoStart', settings.autoStart, vscode.ConfigurationTarget.Global));
                }
                if (settings.authEnabled !== undefined) {
                    updates.push(config.update('authEnabled', settings.authEnabled, vscode.ConfigurationTarget.Global));
                }
                if (settings.defaultModel !== undefined) {
                    updates.push(config.update('defaultModel', settings.defaultModel, vscode.ConfigurationTarget.Global));
                }
                if (settings.corsOrigins !== undefined) {
                    updates.push(config.update('corsOrigins', settings.corsOrigins, vscode.ConfigurationTarget.Global));
                }
                if (settings.logLevel !== undefined) {
                    updates.push(config.update('logLevel', settings.logLevel, vscode.ConfigurationTarget.Global));
                }
                if (settings.maxConcurrentRequests !== undefined) {
                    updates.push(config.update('maxConcurrentRequests', Number(settings.maxConcurrentRequests), vscode.ConfigurationTarget.Global));
                }

                await Promise.all(updates);
                vscode.window.showInformationMessage('Omni Bridge settings saved.');

                // If server is running, offer restart
                if (this.server.isRunning()) {
                    const choice = await vscode.window.showInformationMessage(
                        'Settings changed. Restart the server to apply?',
                        'Restart', 'Later'
                    );
                    if (choice === 'Restart') {
                        await this.server.restart();
                    }
                }

                this.sendFullState();
                break;
            }

            case 'openOutputChannel':
                this.logger.show();
                break;

            case 'clearLogs':
                this.logger.reset();
                this.sendFullState();
                break;

            case 'refreshModels':
                await this.modelMapper.refresh();
                break;
        }
    }

    private postMessage(msg: any): void {
        this.panel?.webview.postMessage(msg);
    }

    /**
     * Generate the complete HTML for the Control Panel webview.
     */
    private getHtml(): string {
        const webview = this.panel!.webview;
        const toolkitUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.extensionUri, 'resources', 'toolkit.min.js')
        );

        return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Omni Bridge — Control Panel</title>
    <script type="module" src="${toolkitUri}"></script>
    <style>
        /* ─── Reset & Base ─── */
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

        :root {
            --bg: var(--vscode-editor-background, #1e1e1e);
            --fg: var(--vscode-editor-foreground, #cccccc);
            --bg-secondary: var(--vscode-sideBar-background, #252526);
            --border: var(--vscode-panel-border, #333333);
            --font: var(--vscode-font-family, 'Segoe UI', system-ui, sans-serif);
            --font-mono: var(--vscode-editor-font-family, 'Cascadia Code', 'Fira Code', monospace);
            --radius: 8px;
            --success: #4ec9b0;
            --danger: var(--vscode-errorForeground, #f44747);
            --warning: #cca700;
            --muted: var(--vscode-descriptionForeground, #888888);
        }

        body {
            font-family: var(--font);
            font-size: 13px;
            color: var(--fg);
            background: var(--bg);
            line-height: 1.5;
            padding: 0;
            overflow-x: hidden;
        }

        /* ─── Layout ─── */
        .app {
            max-width: 960px;
            margin: 0 auto;
            padding: 24px 20px 40px;
        }

        .header {
            display: flex;
            align-items: center;
            gap: 12px;
            margin-bottom: 28px;
            padding-bottom: 16px;
            border-bottom: 1px solid var(--border);
        }

        .header-icon {
            font-size: 20px;
            width: 36px;
            height: 36px;
            display: flex;
            align-items: center;
            justify-content: center;
            background: var(--vscode-button-background, #0e639c);
            border-radius: 8px;
            color: var(--vscode-button-foreground, #ffffff);
        }

        .header h1 {
            font-size: 18px;
            font-weight: 600;
            letter-spacing: -0.3px;
        }

        /* ─── Cards ─── */
        .card {
            background: var(--bg-secondary);
            border: 1px solid var(--border);
            border-radius: var(--radius);
            margin-bottom: 20px;
            overflow: hidden;
        }

        .card-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 12px 16px;
            border-bottom: 1px solid var(--border);
            font-weight: 600;
            font-size: 11px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            color: var(--muted);
        }

        .card-body { padding: 16px; }

        /* ─── Server Status ─── */
        .status-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
            gap: 12px;
            margin-bottom: 16px;
        }

        .stat-box {
            background: var(--bg);
            border: 1px solid var(--border);
            border-radius: 6px;
            padding: 12px;
            text-align: center;
        }

        .stat-box .label {
            font-size: 10px;
            color: var(--muted);
            text-transform: uppercase;
            letter-spacing: 0.5px;
            margin-bottom: 4px;
        }

        .stat-box .value {
            font-size: 20px;
            font-weight: 700;
            font-family: var(--font-mono);
        }

        .stat-box .value.status-running { color: var(--success); }
        .stat-box .value.status-stopped { color: var(--danger); }
        .stat-box .value.status-starting { color: var(--warning); }
        .stat-box .value.status-error { color: var(--danger); }

        .server-actions {
            display: flex;
            gap: 10px;
            flex-wrap: wrap;
        }

        /* ─── Form Controls ─── */
        .form-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 16px;
        }

        .form-group {
            display: flex;
            flex-direction: column;
            gap: 6px;
        }

        .form-group label {
            font-size: 12px;
            font-weight: 500;
            color: var(--fg);
        }

        .form-group .hint {
            font-size: 10px;
            color: var(--muted);
            margin-top: -2px;
        }

        vscode-checkbox {
            margin: 4px 0;
        }

        /* ─── Token List ─── */
        .token-list { display: flex; flex-direction: column; gap: 8px; }

        .token-item {
            display: flex;
            align-items: center;
            gap: 12px;
            padding: 8px 12px;
            background: var(--bg);
            border: 1px solid var(--border);
            border-radius: 6px;
        }

        .token-value {
            font-family: var(--font-mono);
            font-size: 12px;
            color: var(--success);
            flex: 1;
            min-width: 0;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }

        .token-meta {
            font-size: 11px;
            color: var(--muted);
            white-space: nowrap;
        }

        .token-actions { display: flex; gap: 6px; }

        .new-token-display {
            background: color-mix(in srgb, var(--success) 8%, var(--bg));
            border: 1px solid var(--success);
            border-radius: 6px;
            padding: 12px;
            margin-bottom: 12px;
            animation: fadeIn 0.3s ease;
        }

        .new-token-display .token-full {
            font-family: var(--font-mono);
            font-size: 12px;
            color: var(--success);
            word-break: break-all;
            padding: 6px;
            background: var(--bg);
            border-radius: 4px;
            margin: 6px 0;
        }

        .new-token-display .warning-text {
            font-size: 10px;
            color: var(--warning);
        }

        /* ─── Model Table ─── */
        .model-table {
            width: 100%;
            border-collapse: collapse;
            font-size: 12px;
        }

        .model-table th {
            text-align: left;
            padding: 8px 12px;
            border-bottom: 2px solid var(--border);
            color: var(--muted);
            font-weight: 600;
            text-transform: uppercase;
            font-size: 10px;
            letter-spacing: 0.3px;
        }

        .model-table td {
            padding: 8px 12px;
            border-bottom: 1px solid var(--border);
            font-family: var(--font-mono);
        }

        /* ─── Quick Start ─── */
        .endpoint-box {
            display: flex;
            align-items: center;
            gap: 10px;
            padding: 10px 14px;
            background: var(--bg);
            border: 1px solid var(--border);
            border-radius: 6px;
            margin-bottom: 16px;
        }

        .endpoint-url {
            font-family: var(--font-mono);
            font-size: 13px;
            color: var(--success);
            flex: 1;
        }

        .code-block {
            background: var(--bg);
            border: 1px solid var(--border);
            border-radius: 6px;
            padding: 12px;
            font-family: var(--font-mono);
            font-size: 11px;
            line-height: 1.5;
            overflow-x: auto;
            white-space: pre;
            color: var(--fg);
        }

        /* ─── Request Log ─── */
        .log-container {
            max-height: 250px;
            overflow-y: auto;
            font-family: var(--font-mono);
            font-size: 11px;
        }

        .log-entry {
            display: flex;
            gap: 12px;
            padding: 4px 8px;
            border-bottom: 1px solid color-mix(in srgb, var(--border) 50%, transparent);
            white-space: nowrap;
        }

        .log-time { color: var(--muted); min-width: 80px; }
        .log-method { min-width: 50px; font-weight: 600; }
        .log-path { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
        .log-status-2xx { color: var(--success); }
        .log-status-4xx { color: var(--warning); }
        .log-status-5xx { color: var(--danger); }
        .log-duration { color: var(--muted); min-width: 60px; text-align: right; }

        .log-empty {
            padding: 24px;
            text-align: center;
            color: var(--muted);
            font-family: var(--font);
            font-size: 12px;
        }

        /* ─── Empty States ─── */
        .empty-state {
            text-align: center;
            padding: 20px;
            color: var(--muted);
        }
        .empty-state .emoji { font-size: 20px; margin-bottom: 6px; }

        /* ─── Responsive ─── */
        @media (max-width: 600px) {
            .form-grid { grid-template-columns: 1fr; }
            .status-grid { grid-template-columns: 1fr 1fr; }
        }
    </style>
</head>
<body>
    <div class="app">
        <!-- Header -->
        <div class="header">
            <div class="header-icon">⚡</div>
            <div style="flex: 1">
                <h1>Omni Bridge</h1>
                <div style="font-size:11px; color:var(--muted)">Local AI Server — OpenAI & Ollama Compatible</div>
            </div>
            <vscode-tag class="version">v1.1.1</vscode-tag>
        </div>

        <!-- Server Status Card -->
        <div class="card" id="server-card">
            <div class="card-header">
                <span>📡 Server Status</span>
                <vscode-tag id="server-state-badge" style="display:none"></vscode-tag>
            </div>
            <div class="card-body">
                <div class="status-grid">
                    <div class="stat-box">
                        <div class="label">Status</div>
                        <div class="value" id="stat-status">● Stopped</div>
                    </div>
                    <div class="stat-box">
                        <div class="label">Port</div>
                        <div class="value" id="stat-port">—</div>
                    </div>
                    <div class="stat-box">
                        <div class="label">Uptime</div>
                        <div class="value" id="stat-uptime">—</div>
                    </div>
                    <div class="stat-box">
                        <div class="label">Requests</div>
                        <div class="value" id="stat-requests">0</div>
                    </div>
                </div>
                <div class="server-actions">
                    <vscode-button id="btn-start" onclick="sendMsg('startServer')">▶ Start Server</vscode-button>
                    <vscode-button id="btn-stop" appearance="secondary" onclick="sendMsg('stopServer')" style="display:none">■ Stop Server</vscode-button>
                    <vscode-button id="btn-restart" appearance="secondary" onclick="sendMsg('restartServer')" style="display:none">↻ Restart Server</vscode-button>
                </div>
            </div>
        </div>

        <!-- Configuration Card -->
        <div class="card">
            <div class="card-header">
                <span>⚙️ Configuration</span>
                <vscode-button appearance="icon" onclick="resetConfig()" title="Reset to Defaults">Reset Defaults</vscode-button>
            </div>
            <div class="card-body">
                <div class="form-grid" id="config-form">
                    <div class="form-group">
                        <label for="cfg-port">Port</label>
                        <vscode-text-field id="cfg-port" type="number" min="1024" max="65535" value="11434"></vscode-text-field>
                        <span class="hint">Port range: 1024–65535</span>
                    </div>
                    <div class="form-group">
                        <label for="cfg-host">Bind Address</label>
                        <vscode-dropdown id="cfg-host">
                            <vscode-option value="127.0.0.1">127.0.0.1 (localhost only)</vscode-option>
                            <vscode-option value="0.0.0.0">0.0.0.0 (all interfaces)</vscode-option>
                        </vscode-dropdown>
                    </div>
                    <div class="form-group">
                        <label for="cfg-defaultModel">Default Model</label>
                        <vscode-dropdown id="cfg-defaultModel">
                            <vscode-option value="">(require explicit model)</vscode-option>
                        </vscode-dropdown>
                    </div>
                    <div class="form-group">
                        <label for="cfg-maxConcurrent">Max Concurrent Requests</label>
                        <vscode-text-field id="cfg-maxConcurrent" type="number" min="1" max="20" value="5"></vscode-text-field>
                    </div>
                    <div class="form-group">
                        <label for="cfg-corsOrigins">CORS Origins</label>
                        <vscode-text-field id="cfg-corsOrigins" value="*"></vscode-text-field>
                        <span class="hint">Comma-separated or * for all</span>
                    </div>
                    <div class="form-group">
                        <label for="cfg-logLevel">Log Level</label>
                        <vscode-dropdown id="cfg-logLevel">
                            <vscode-option value="none">None</vscode-option>
                            <vscode-option value="error">Error</vscode-option>
                            <vscode-option value="info">Info</vscode-option>
                            <vscode-option value="debug">Debug</vscode-option>
                        </vscode-dropdown>
                    </div>
                    <div class="form-group">
                        <vscode-checkbox id="cfg-autoStart">Auto-start server on IDE launch</vscode-checkbox>
                    </div>
                    <div class="form-group">
                        <vscode-checkbox id="cfg-authEnabled">Require API token authentication</vscode-checkbox>
                    </div>
                </div>
                <div style="margin-top:16px; display:flex; gap:10px;">
                    <vscode-button onclick="saveConfig()">💾 Save Settings</vscode-button>
                    <vscode-button appearance="secondary" onclick="saveAndRestart()">💾 Save & Restart</vscode-button>
                </div>
            </div>
        </div>

        <!-- API Tokens Card -->
        <div class="card">
            <div class="card-header">
                <span>🔑 API Tokens</span>
                <div style="display:flex; gap:6px; align-items:center;">
                    <vscode-button onclick="generateToken()">+ Generate Token</vscode-button>
                    <vscode-button id="btn-revoke-all" appearance="secondary" onclick="revokeAll()" style="display:none">Revoke All</vscode-button>
                </div>
            </div>
            <div class="card-body">
                <div id="new-token-area"></div>
                <div class="token-list" id="token-list">
                    <div class="empty-state">
                        <div class="emoji">🔐</div>
                        <div>No API tokens yet. Generate one to secure your server.</div>
                    </div>
                </div>
            </div>
        </div>

        <!-- Available Models Card -->
        <div class="card">
            <div class="card-header">
                <span>🤖 Available Models</span>
                <vscode-button appearance="secondary" onclick="sendMsg('refreshModels')">↻ Refresh</vscode-button>
            </div>
            <div class="card-body">
                <div id="model-list">
                    <div class="empty-state">
                        <div class="emoji">⏳</div>
                        <div>Loading models...</div>
                    </div>
                </div>
            </div>
        </div>

        <!-- API Endpoints Card -->
        <div class="card">
            <div class="card-header">
                <span>📡 API Endpoints Reference</span>
            </div>
            <div class="card-body" style="padding: 0;">
                <table class="model-table">
                    <thead>
                        <tr>
                            <th style="width: 80px;">Method</th>
                            <th>Path</th>
                            <th>Description</th>
                            <th>API Format</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr>
                            <td style="color: var(--success); font-weight: bold; padding: 10px 12px;">GET</td>
                            <td style="font-family: var(--font-mono); font-size: 11px;">/v1/models</td>
                            <td>Lists all discovered active language models</td>
                            <td><vscode-tag>OpenAI</vscode-tag></td>
                        </tr>
                        <tr>
                            <td style="color: var(--success); font-weight: bold; padding: 10px 12px;">POST</td>
                            <td style="font-family: var(--font-mono); font-size: 11px;">/v1/chat/completions</td>
                            <td>OpenAI-compatible chat completion (supports streaming)</td>
                            <td><vscode-tag>OpenAI</vscode-tag></td>
                        </tr>
                        <tr>
                            <td style="color: var(--success); font-weight: bold; padding: 10px 12px;">POST</td>
                            <td style="font-family: var(--font-mono); font-size: 11px;">/api/chat</td>
                            <td>Ollama-compatible chat completion</td>
                            <td><vscode-tag>Ollama</vscode-tag></td>
                        </tr>
                        <tr>
                            <td style="color: var(--success); font-weight: bold; padding: 10px 12px;">GET</td>
                            <td style="font-family: var(--font-mono); font-size: 11px;">/api/tags</td>
                            <td>Ollama-compatible models tags list</td>
                            <td><vscode-tag>Ollama</vscode-tag></td>
                        </tr>
                        <tr>
                            <td style="color: var(--success); font-weight: bold; padding: 10px 12px;">GET</td>
                            <td style="font-family: var(--font-mono); font-size: 11px;">/health</td>
                            <td>Server health check and statistics</td>
                            <td><vscode-tag>System</vscode-tag></td>
                        </tr>
                    </tbody>
                </table>
            </div>
        </div>

        <!-- Quick Start Card -->
        <div class="card">
            <div class="card-header">
                <span>🚀 Quick Start</span>
            </div>
            <div class="card-body" style="padding: 12px 16px;">
                <div class="endpoint-box">
                    <span style="color:var(--muted)">Endpoint:</span>
                    <span class="endpoint-url" id="endpoint-url">http://localhost:11434/v1</span>
                    <vscode-button appearance="secondary" onclick="sendMsg('copyEndpoint')">📋 Copy</vscode-button>
                </div>

                <vscode-panels>
                    <vscode-panel-tab id="tab-curl">CURL</vscode-panel-tab>
                    <vscode-panel-tab id="tab-python">PYTHON</vscode-panel-tab>
                    <vscode-panel-tab id="tab-node">NODE.JS</vscode-panel-tab>
                    <vscode-panel-tab id="tab-ollama">OLLAMA</vscode-panel-tab>
                    
                    <vscode-panel-view id="view-curl">
                        <div style="width: 100%">
                            <div class="code-block" id="curl-example">curl <span class="url-base">http://localhost:11434/v1</span>/chat/completions \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer YOUR_TOKEN" \\
  -d '{
    "model": "gemini-3.5-flash",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'</div>
                            <vscode-button appearance="secondary" style="margin-top:8px" onclick="copyCurl('curl')">📋 Copy command</vscode-button>
                        </div>
                    </vscode-panel-view>
                    <vscode-panel-view id="view-python">
                        <div style="width: 100%">
                            <div class="code-block" id="python-example">from openai import OpenAI

client = OpenAI(
    base_url="<span class="url-base">http://localhost:11434/v1</span>",
    api_key="YOUR_TOKEN"
)

response = client.chat.completions.create(
    model="gemini-3.5-flash",
    messages=[{"role": "user", "content": "Hello!"}]
)
print(response.choices[0].message.content)</div>
                            <vscode-button appearance="secondary" style="margin-top:8px" onclick="copyCurl('python')">📋 Copy code</vscode-button>
                        </div>
                    </vscode-panel-view>
                    <vscode-panel-view id="view-node">
                        <div style="width: 100%">
                            <div class="code-block" id="node-example">import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "<span class="url-base">http://localhost:11434/v1</span>",
  apiKey: "YOUR_TOKEN",
});

const response = await client.chat.completions.create({
  model: "gemini-3.5-flash",
  messages: [{ role: "user", content: "Hello!" }],
});
console.log(response.choices[0].message.content);</div>
                            <vscode-button appearance="secondary" style="margin-top:8px" onclick="copyCurl('node')">📋 Copy code</vscode-button>
                        </div>
                    </vscode-panel-view>
                    <vscode-panel-view id="view-ollama">
                        <div style="width: 100%">
                            <div class="code-block" id="ollama-example">curl <span class="url-ollama-base">http://localhost:11434</span>/api/chat \\
  -d '{
    "model": "gemini-3.5-flash",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": false
  }'

# List models (Ollama format)
curl <span class="url-ollama-base">http://localhost:11434</span>/api/tags</div>
                            <vscode-button appearance="secondary" style="margin-top:8px" onclick="copyCurl('ollama')">📋 Copy command</vscode-button>
                        </div>
                    </vscode-panel-view>
                </vscode-panels>
            </div>
        </div>

        <!-- Request Log Card -->
        <div class="card">
            <div class="card-header">
                <span>📋 Request Log</span>
                <div style="display:flex; gap:6px;">
                    <vscode-button appearance="secondary" onclick="sendMsg('openOutputChannel')">Open Full Log</vscode-button>
                    <vscode-button appearance="secondary" onclick="sendMsg('clearLogs')">Clear</vscode-button>
                </div>
            </div>
            <div class="card-body" style="padding:0;">
                <div class="log-container" id="log-container">
                    <div class="log-empty">No requests yet. Start the server and send a request!</div>
                </div>
            </div>
        </div>
    </div>

    <script>
        // ─── VS Code API ───
        const vscode = acquireVsCodeApi();
        let currentState = {};

        function sendMsg(type, data) {
            vscode.postMessage({ type, ...data });
        }

        // ─── State Management ───
        window.addEventListener('message', (event) => {
            const msg = event.data;
            switch (msg.type) {
                case 'fullState':
                    currentState = msg.data;
                    renderAll(msg.data);
                    break;
                case 'serverState':
                    currentState.server = msg.data;
                    renderServerStatus(msg.data);
                    break;
                case 'tokens':
                    currentState.tokens = msg.data;
                    renderTokens(msg.data);
                    break;
                case 'models':
                    currentState.models = msg.data;
                    renderModels(msg.data);
                    break;
                case 'logEntry':
                    appendLogEntry(msg.data);
                    break;
                case 'tokenGenerated':
                    showNewToken(msg.data);
                    break;
            }
        });

        // Request initial state
        sendMsg('getFullState');

        // ─── Renderers ───
        function renderAll(state) {
            renderServerStatus(state.server);
            renderTokens(state.tokens);
            renderModels(state.models);
            renderConfig(state.config);
            renderLogs(state.logs);
            updateEndpoint(state.server);
        }

        function renderServerStatus(server) {
            const statusEl = document.getElementById('stat-status');
            const stateMap = {
                running: { text: '● Running', cls: 'status-running' },
                stopped: { text: '● Stopped', cls: 'status-stopped' },
                starting: { text: '◌ Starting', cls: 'status-starting' },
                error: { text: '● Error', cls: 'status-error' },
            };

            const s = stateMap[server.state] || stateMap.stopped;
            statusEl.textContent = s.text;
            statusEl.className = 'value ' + s.cls;

            document.getElementById('stat-port').textContent = server.running ? server.port : '—';
            document.getElementById('stat-uptime').textContent = server.running ? formatUptime(server.uptimeSeconds) : '—';
            document.getElementById('stat-requests').textContent = server.stats?.total || 0;

            // Toggle buttons
            document.getElementById('btn-start').style.display = server.running ? 'none' : '';
            document.getElementById('btn-stop').style.display = server.running ? '' : 'none';
            document.getElementById('btn-restart').style.display = server.running ? '' : 'none';

            updateEndpoint(server);
        }

        function renderTokens(tokens) {
            const container = document.getElementById('token-list');
            const revokeAllBtn = document.getElementById('btn-revoke-all');

            if (!tokens || tokens.length === 0) {
                container.innerHTML = '<div class="empty-state"><div class="emoji">🔐</div><div>No API tokens yet. Generate one to secure your server.</div></div>';
                revokeAllBtn.style.display = 'none';
                return;
            }

            revokeAllBtn.style.display = '';
            container.innerHTML = tokens.map(t => {
                const age = formatAge(t.createdAt);
                const lastUsed = t.lastUsedAt ? formatAge(t.lastUsedAt) + ' ago' : 'never';
                return \`<div class="token-item">
                    <div class="token-value">\${t.maskedToken}</div>
                    <div class="token-meta">\${t.label} · \${age} ago · used: \${t.usageCount}x</div>
                    <div class="token-actions">
                        <vscode-button appearance="secondary" onclick="sendMsg('copyToken',{tokenId:'\${t.id}'})">📋</vscode-button>
                        <vscode-button appearance="secondary" onclick="sendMsg('revokeToken',{tokenId:'\${t.id}'})">✕</vscode-button>
                    </div>
                </div>\`;
            }).join('');
        }

        function renderModels(models) {
            const container = document.getElementById('model-list');
            const modelSelect = document.getElementById('cfg-defaultModel');

             if (!models || models.length === 0) {
                container.innerHTML = \`<div class="empty-state">
                    <div class="emoji">🤖</div>
                    <div style="font-weight: 600; margin-bottom: 8px; color: var(--fg);">No Language Models Available</div>
                    <div style="max-width: 500px; margin: 0 auto; text-align: left; font-size: 12px; line-height: 1.6; color: var(--muted); background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: 14px;">
                        The <code>vscode.lm</code> API requires an active Language Model provider extension (such as <strong>GitHub Copilot</strong> or <strong>Gemini Code Assist</strong>) to be installed and authenticated.
                        <br/><br/>
                        <strong>If you are running in the Extension Development Host:</strong>
                        <ol style="margin-left: 20px; margin-top: 8px; display: flex; flex-direction: column; gap: 6px;">
                            <li>Ensure that an AI companion extension is installed in your primary IDE.</li>
                            <li>In this <em>Extension Development Host</em> window, check the <strong>Accounts</strong> icon (in the bottom-left corner of the status bar) and make sure you are <strong>signed in</strong> to your account (e.g. GitHub or Google).</li>
                            <li>Once signed in, click the <strong>Refresh</strong> button above to re-discover models.</li>
                        </ol>
                    </div>
                </div>\`;
                return;
            }

            container.innerHTML = \`<table class="model-table">
                <thead><tr><th>Model ID</th><th>Family</th><th>Vendor</th><th>Max Tokens</th></tr></thead>
                <tbody>\${models.map(m => \`<tr>
                    <td>\${m.id}</td>
                    <td>\${m._meta?.family || '—'}</td>
                    <td>\${m.owned_by || '—'}</td>
                    <td>\${m._meta?.maxInputTokens?.toLocaleString() || '—'}</td>
                </tr>\`).join('')}</tbody>
            </table>\`;

            // Update default model dropdown
            const currentDefault = modelSelect.value || (currentState.config && currentState.config.defaultModel) || '';
            modelSelect.innerHTML = '<vscode-option value="">(require explicit model)</vscode-option>' +
                models.map(m => \`<vscode-option value="\${m.id}" \${m.id === currentDefault ? 'selected' : ''}>\text-content: \${m.id}</vscode-option>\`).join('');
        }

        function renderConfig(config) {
            if (!config) return;
            document.getElementById('cfg-port').value = config.port;
            document.getElementById('cfg-host').value = config.host;
            document.getElementById('cfg-autoStart').checked = config.autoStart;
            document.getElementById('cfg-authEnabled').checked = config.authEnabled;
            document.getElementById('cfg-corsOrigins').value = config.corsOrigins;
            document.getElementById('cfg-logLevel').value = config.logLevel;
            document.getElementById('cfg-maxConcurrent').value = config.maxConcurrentRequests;

            const modelSelect = document.getElementById('cfg-defaultModel');
            if (modelSelect) {
                modelSelect.value = config.defaultModel || '';
            }
        }

        function renderLogs(logs) {
            const container = document.getElementById('log-container');
            if (!logs || logs.length === 0) {
                container.innerHTML = '<div class="log-empty">No requests yet. Start the server and send a request!</div>';
                return;
            }
            container.innerHTML = logs.map(buildLogEntryHtml).join('');
            container.scrollTop = container.scrollHeight;
        }

        function appendLogEntry(entry) {
            const container = document.getElementById('log-container');
            const empty = container.querySelector('.log-empty');
            if (empty) empty.remove();
            container.insertAdjacentHTML('beforeend', buildLogEntryHtml(entry));
            container.scrollTop = container.scrollHeight;
        }

        function buildLogEntryHtml(entry) {
            const time = new Date(entry.timestamp).toLocaleTimeString();
            const statusCls = entry.statusCode < 300 ? 'log-status-2xx'
                : entry.statusCode < 500 ? 'log-status-4xx'
                : 'log-status-5xx';
            return \`<div class="log-entry">
                <span class="log-time">\${time}</span>
                <span class="log-method">\${entry.method}</span>
                <span class="log-path">\${entry.path}</span>
                <span class="\text-cls: \${statusCls}">\${entry.statusCode}</span>
                <span class="log-duration">\${entry.responseTimeMs}ms</span>
            </div>\`;
        }

        function updateEndpoint(server) {
            if (server) {
                let baseUrl = 'http://localhost:11434/v1';
                if (server.endpoint) {
                    baseUrl = server.endpoint;
                    document.getElementById('endpoint-url').textContent = server.endpoint;
                } else if (server.port) {
                    const host = server.host === '0.0.0.0' ? 'localhost' : (server.host || 'localhost');
                    baseUrl = 'http://' + host + ':' + server.port + '/v1';
                }
                const ollamaBaseUrl = baseUrl.replace('/v1', '');

                document.querySelectorAll('.url-base').forEach(el => {
                    el.textContent = baseUrl;
                });
                document.querySelectorAll('.url-ollama-base').forEach(el => {
                    el.textContent = ollamaBaseUrl;
                });
            }
        }

        // ─── Actions ───
        function generateToken() {
            sendMsg('generateToken', { label: 'Token ' + (Date.now() % 1000) });
        }

        function showNewToken(data) {
            const area = document.getElementById('new-token-area');
            area.innerHTML = \`<div class="new-token-display">
                <div style="font-weight:600; margin-bottom:4px;">✅ New Token Generated</div>
                <div class="token-full">\${data.token}</div>
                <div style="display:flex; gap:8px; align-items:center;">
                    <vscode-button onclick="sendMsg('copyToken',{tokenId:'\${data.id}'})">📋 Copy Token</vscode-button>
                    <span class="warning-text">⚠ Save this token now — you won't see the full value again.</span>
                </div>
            </div>\`;

            // Auto-dismiss after 30 seconds
            setTimeout(() => { area.innerHTML = ''; }, 30000);
        }

        function revokeAll() {
            sendMsg('revokeAllTokens');
        }

        function saveConfig() {
            sendMsg('saveConfig', { data: getConfigValues() });
        }

        function saveAndRestart() {
            sendMsg('saveConfig', { data: getConfigValues() });
            setTimeout(() => sendMsg('restartServer'), 500);
        }

        function resetConfig() {
            document.getElementById('cfg-port').value = 11434;
            document.getElementById('cfg-host').value = '127.0.0.1';
            document.getElementById('cfg-autoStart').checked = false;
            document.getElementById('cfg-authEnabled').checked = true;
            document.getElementById('cfg-corsOrigins').value = '*';
            document.getElementById('cfg-logLevel').value = 'info';
            document.getElementById('cfg-maxConcurrent').value = 5;
            document.getElementById('cfg-defaultModel').value = '';
        }

        function getConfigValues() {
            return {
                port: parseInt(document.getElementById('cfg-port').value),
                host: document.getElementById('cfg-host').value,
                autoStart: document.getElementById('cfg-autoStart').checked,
                authEnabled: document.getElementById('cfg-authEnabled').checked,
                corsOrigins: document.getElementById('cfg-corsOrigins').value,
                logLevel: document.getElementById('cfg-logLevel').value,
                maxConcurrentRequests: parseInt(document.getElementById('cfg-maxConcurrent').value),
                defaultModel: document.getElementById('cfg-defaultModel').value,
            };
        }

        function copyCurl(type) {
            const blocks = {
                curl: document.getElementById('curl-example'),
                python: document.getElementById('python-example'),
                node: document.getElementById('node-example'),
                ollama: document.getElementById('ollama-example'),
            };
            sendMsg('copyCurl', { command: blocks[type]?.textContent || '' });
        }

        // ─── Utilities ───
        function formatUptime(seconds) {
            if (!seconds) return '—';
            if (seconds < 60) return seconds + 's';
            if (seconds < 3600) return Math.floor(seconds / 60) + 'm ' + (seconds % 60) + 's';
            const h = Math.floor(seconds / 3600);
            const m = Math.floor((seconds % 3600) / 60);
            return h + 'h ' + m + 'm';
        }

        function formatAge(timestamp) {
            const diff = Math.floor((Date.now() - timestamp) / 1000);
            if (diff < 60) return diff + 's';
            if (diff < 3600) return Math.floor(diff / 60) + 'm';
            if (diff < 86400) return Math.floor(diff / 3600) + 'h';
            return Math.floor(diff / 86400) + 'd';
        }

        // ─── Periodic uptime refresh ───
        setInterval(() => {
            if (currentState.server?.running && currentState.server?.uptimeSeconds !== undefined) {
                currentState.server.uptimeSeconds++;
                document.getElementById('stat-uptime').textContent = formatUptime(currentState.server.uptimeSeconds);
            }
        }, 1000);
    </script>
</body>
</html>`;
    }

    dispose(): void {
        this.panel?.dispose();
        this.disposables.forEach(d => d.dispose());
    }
}
