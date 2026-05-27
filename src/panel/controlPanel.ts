import * as vscode from 'vscode';
import { HTTPServer } from '../server/httpServer.js';
import { TokenManager, StoredToken } from '../auth/tokenManager.js';
import { ModelMapper } from '../bridge/modelMapper.js';
import { RequestLogger, LogEntry } from '../logger.js';

/**
 * ControlPanel — Webview-based dashboard for managing the LM Bridge server.
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
            'lmBridgeControlPanel',
            'LM Bridge — Control Panel',
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
        const config = vscode.workspace.getConfiguration('lmBridge');
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
                const config = vscode.workspace.getConfiguration('lmBridge');
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
                vscode.window.showInformationMessage('LM Bridge settings saved.');

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
        return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>LM Bridge — Control Panel</title>
    <style>
        /* ─── Reset & Base ─── */
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

        :root {
            --bg: var(--vscode-editor-background, #1e1e1e);
            --fg: var(--vscode-editor-foreground, #cccccc);
            --bg-secondary: var(--vscode-sideBar-background, #252526);
            --border: var(--vscode-panel-border, #333333);
            --accent: var(--vscode-button-background, #0e639c);
            --accent-hover: var(--vscode-button-hoverBackground, #1177bb);
            --accent-fg: var(--vscode-button-foreground, #ffffff);
            --danger: var(--vscode-errorForeground, #f44747);
            --success: #4ec9b0;
            --warning: #cca700;
            --muted: var(--vscode-descriptionForeground, #888888);
            --input-bg: var(--vscode-input-background, #3c3c3c);
            --input-border: var(--vscode-input-border, #555555);
            --input-fg: var(--vscode-input-foreground, #cccccc);
            --badge-bg: var(--vscode-badge-background, #4d4d4d);
            --badge-fg: var(--vscode-badge-foreground, #ffffff);
            --font: var(--vscode-font-family, 'Segoe UI', system-ui, sans-serif);
            --font-mono: var(--vscode-editor-font-family, 'Cascadia Code', 'Fira Code', monospace);
            --radius: 8px;
            --shadow: 0 2px 8px rgba(0,0,0,0.25);
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
            font-size: 28px;
            width: 40px;
            height: 40px;
            display: flex;
            align-items: center;
            justify-content: center;
            background: linear-gradient(135deg, var(--accent), #9b59b6);
            border-radius: 10px;
            color: white;
        }

        .header h1 {
            font-size: 20px;
            font-weight: 600;
            letter-spacing: -0.3px;
        }

        .header .version {
            font-size: 11px;
            color: var(--muted);
            background: var(--badge-bg);
            padding: 2px 8px;
            border-radius: 10px;
        }

        /* ─── Cards ─── */
        .card {
            background: var(--bg-secondary);
            border: 1px solid var(--border);
            border-radius: var(--radius);
            margin-bottom: 20px;
            overflow: hidden;
            transition: border-color 0.2s;
        }

        .card:hover {
            border-color: color-mix(in srgb, var(--accent) 40%, var(--border));
        }

        .card-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 14px 18px;
            border-bottom: 1px solid var(--border);
            font-weight: 600;
            font-size: 13px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            color: var(--muted);
        }

        .card-header .icon { margin-right: 8px; font-size: 14px; }
        .card-body { padding: 18px; }

        /* ─── Server Status ─── */
        .status-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
            gap: 14px;
            margin-bottom: 16px;
        }

        .stat-box {
            background: var(--bg);
            border: 1px solid var(--border);
            border-radius: 6px;
            padding: 14px;
            text-align: center;
        }

        .stat-box .label {
            font-size: 11px;
            color: var(--muted);
            text-transform: uppercase;
            letter-spacing: 0.5px;
            margin-bottom: 6px;
        }

        .stat-box .value {
            font-size: 22px;
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

        /* ─── Buttons ─── */
        button {
            font-family: var(--font);
            font-size: 12px;
            padding: 8px 16px;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            display: inline-flex;
            align-items: center;
            gap: 6px;
            transition: all 0.15s ease;
            font-weight: 500;
        }

        .btn-primary {
            background: var(--accent);
            color: var(--accent-fg);
        }
        .btn-primary:hover { background: var(--accent-hover); }
        .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }

        .btn-danger {
            background: transparent;
            color: var(--danger);
            border: 1px solid var(--danger);
        }
        .btn-danger:hover { background: color-mix(in srgb, var(--danger) 15%, transparent); }

        .btn-secondary {
            background: var(--badge-bg);
            color: var(--fg);
            border: 1px solid var(--border);
        }
        .btn-secondary:hover { background: color-mix(in srgb, var(--accent) 20%, var(--badge-bg)); }

        .btn-ghost {
            background: transparent;
            color: var(--muted);
            padding: 4px 8px;
            font-size: 11px;
        }
        .btn-ghost:hover { color: var(--fg); background: var(--badge-bg); }

        .btn-sm { padding: 4px 10px; font-size: 11px; }

        /* ─── Form Controls ─── */
        .form-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 14px;
        }

        .form-group {
            display: flex;
            flex-direction: column;
            gap: 4px;
        }

        .form-group.full-width { grid-column: 1 / -1; }

        .form-group label {
            font-size: 12px;
            font-weight: 500;
            color: var(--fg);
        }

        .form-group .hint {
            font-size: 11px;
            color: var(--muted);
        }

        input[type="text"],
        input[type="number"],
        select {
            font-family: var(--font-mono);
            font-size: 12px;
            padding: 7px 10px;
            background: var(--input-bg);
            border: 1px solid var(--input-border);
            border-radius: 4px;
            color: var(--input-fg);
            outline: none;
            transition: border-color 0.15s;
        }

        input:focus, select:focus {
            border-color: var(--accent);
        }

        .checkbox-group {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 4px 0;
        }

        input[type="checkbox"] {
            width: 16px;
            height: 16px;
            accent-color: var(--accent);
        }

        /* ─── Token List ─── */
        .token-list { display: flex; flex-direction: column; gap: 8px; }

        .token-item {
            display: flex;
            align-items: center;
            gap: 12px;
            padding: 10px 14px;
            background: var(--bg);
            border: 1px solid var(--border);
            border-radius: 6px;
            transition: border-color 0.15s;
        }
        .token-item:hover { border-color: var(--accent); }

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
            background: color-mix(in srgb, var(--success) 10%, var(--bg));
            border: 1px solid var(--success);
            border-radius: 6px;
            padding: 14px;
            margin-bottom: 12px;
            animation: fadeIn 0.3s ease;
        }

        .new-token-display .token-full {
            font-family: var(--font-mono);
            font-size: 13px;
            color: var(--success);
            word-break: break-all;
            padding: 8px;
            background: var(--bg);
            border-radius: 4px;
            margin: 8px 0;
        }

        .new-token-display .warning-text {
            font-size: 11px;
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
            font-size: 11px;
            letter-spacing: 0.3px;
        }

        .model-table td {
            padding: 8px 12px;
            border-bottom: 1px solid var(--border);
            font-family: var(--font-mono);
        }

        .model-table tr:hover td {
            background: color-mix(in srgb, var(--accent) 8%, transparent);
        }

        /* ─── Quick Start ─── */
        .endpoint-box {
            display: flex;
            align-items: center;
            gap: 10px;
            padding: 12px 16px;
            background: var(--bg);
            border: 1px solid var(--border);
            border-radius: 6px;
            margin-bottom: 16px;
        }

        .endpoint-url {
            font-family: var(--font-mono);
            font-size: 14px;
            color: var(--success);
            flex: 1;
        }

        .code-block {
            background: var(--bg);
            border: 1px solid var(--border);
            border-radius: 6px;
            padding: 14px;
            font-family: var(--font-mono);
            font-size: 12px;
            line-height: 1.6;
            overflow-x: auto;
            position: relative;
            white-space: pre;
            color: var(--fg);
        }

        .code-block .copy-overlay {
            position: absolute;
            top: 8px;
            right: 8px;
        }

        .tab-bar {
            display: flex;
            gap: 2px;
            margin-bottom: 12px;
            border-bottom: 1px solid var(--border);
        }

        .tab-btn {
            padding: 8px 14px;
            font-size: 12px;
            background: transparent;
            border: none;
            border-bottom: 2px solid transparent;
            color: var(--muted);
            cursor: pointer;
            font-family: var(--font);
            transition: all 0.15s;
        }

        .tab-btn.active {
            color: var(--accent);
            border-bottom-color: var(--accent);
        }

        .tab-btn:hover { color: var(--fg); }

        .tab-content { display: none; }
        .tab-content.active { display: block; }

        /* ─── Request Log ─── */
        .log-container {
            max-height: 300px;
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

        .log-entry:hover { background: color-mix(in srgb, var(--accent) 5%, transparent); }
        .log-time { color: var(--muted); min-width: 80px; }
        .log-method { min-width: 50px; font-weight: 600; }
        .log-path { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
        .log-status-2xx { color: var(--success); }
        .log-status-4xx { color: var(--warning); }
        .log-status-5xx { color: var(--danger); }
        .log-duration { color: var(--muted); min-width: 60px; text-align: right; }

        .log-empty {
            padding: 30px;
            text-align: center;
            color: var(--muted);
            font-family: var(--font);
            font-size: 13px;
        }

        /* ─── Animations ─── */
        @keyframes fadeIn {
            from { opacity: 0; transform: translateY(-4px); }
            to { opacity: 1; transform: translateY(0); }
        }

        @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.5; }
        }

        .pulse { animation: pulse 1.5s infinite; }

        /* ─── Empty States ─── */
        .empty-state {
            text-align: center;
            padding: 24px;
            color: var(--muted);
        }
        .empty-state .emoji { font-size: 24px; margin-bottom: 8px; }

        /* ─── Scrollbar ─── */
        ::-webkit-scrollbar { width: 8px; height: 8px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 4px; }
        ::-webkit-scrollbar-thumb:hover { background: var(--muted); }

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
            <div>
                <h1>LM Bridge</h1>
                <div style="font-size:11px; color:var(--muted)">Local AI Server — OpenAI & Ollama Compatible</div>
            </div>
            <span class="version">v0.1.0</span>
        </div>

        <!-- Server Status Card -->
        <div class="card" id="server-card">
            <div class="card-header">
                <span><span class="icon">📡</span> Server Status</span>
                <span id="server-state-badge" style="font-size:11px; text-transform:none; font-weight:400"></span>
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
                    <button class="btn-primary" id="btn-start" onclick="sendMsg('startServer')">▶ Start Server</button>
                    <button class="btn-danger btn-sm" id="btn-stop" onclick="sendMsg('stopServer')" style="display:none">■ Stop</button>
                    <button class="btn-secondary btn-sm" id="btn-restart" onclick="sendMsg('restartServer')" style="display:none">↻ Restart</button>
                </div>
            </div>
        </div>

        <!-- Configuration Card -->
        <div class="card">
            <div class="card-header">
                <span><span class="icon">⚙️</span> Configuration</span>
                <button class="btn-ghost" onclick="resetConfig()">Reset Defaults</button>
            </div>
            <div class="card-body">
                <div class="form-grid" id="config-form">
                    <div class="form-group">
                        <label for="cfg-port">Port</label>
                        <input type="number" id="cfg-port" min="1024" max="65535" value="11434" />
                        <span class="hint">1024–65535</span>
                    </div>
                    <div class="form-group">
                        <label for="cfg-host">Bind Address</label>
                        <select id="cfg-host">
                            <option value="127.0.0.1">127.0.0.1 (localhost only)</option>
                            <option value="0.0.0.0">0.0.0.0 (all interfaces)</option>
                        </select>
                    </div>
                    <div class="form-group">
                        <label for="cfg-defaultModel">Default Model</label>
                        <select id="cfg-defaultModel">
                            <option value="">(require explicit model)</option>
                        </select>
                    </div>
                    <div class="form-group">
                        <label for="cfg-maxConcurrent">Max Concurrent Requests</label>
                        <input type="number" id="cfg-maxConcurrent" min="1" max="20" value="5" />
                    </div>
                    <div class="form-group">
                        <label for="cfg-corsOrigins">CORS Origins</label>
                        <input type="text" id="cfg-corsOrigins" value="*" />
                        <span class="hint">Comma-separated or * for all</span>
                    </div>
                    <div class="form-group">
                        <label for="cfg-logLevel">Log Level</label>
                        <select id="cfg-logLevel">
                            <option value="none">None</option>
                            <option value="error">Error</option>
                            <option value="info" selected>Info</option>
                            <option value="debug">Debug</option>
                        </select>
                    </div>
                    <div class="form-group">
                        <div class="checkbox-group">
                            <input type="checkbox" id="cfg-autoStart" />
                            <label for="cfg-autoStart">Auto-start server on IDE launch</label>
                        </div>
                    </div>
                    <div class="form-group">
                        <div class="checkbox-group">
                            <input type="checkbox" id="cfg-authEnabled" checked />
                            <label for="cfg-authEnabled">Require API token authentication</label>
                        </div>
                    </div>
                </div>
                <div style="margin-top:16px; display:flex; gap:10px;">
                    <button class="btn-primary" onclick="saveConfig()">💾 Save Settings</button>
                    <button class="btn-secondary" onclick="saveAndRestart()">💾 Save & Restart</button>
                </div>
            </div>
        </div>

        <!-- API Tokens Card -->
        <div class="card">
            <div class="card-header">
                <span><span class="icon">🔑</span> API Tokens</span>
                <div style="display:flex; gap:6px;">
                    <button class="btn-primary btn-sm" onclick="generateToken()">+ Generate Token</button>
                    <button class="btn-danger btn-sm" id="btn-revoke-all" onclick="revokeAll()" style="display:none">Revoke All</button>
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
                <span><span class="icon">🤖</span> Available Models</span>
                <button class="btn-ghost" onclick="sendMsg('refreshModels')">↻ Refresh</button>
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

        <!-- Quick Start Card -->
        <div class="card">
            <div class="card-header">
                <span><span class="icon">🚀</span> Quick Start</span>
            </div>
            <div class="card-body">
                <div class="endpoint-box">
                    <span style="color:var(--muted)">Endpoint:</span>
                    <span class="endpoint-url" id="endpoint-url">http://localhost:11434/v1</span>
                    <button class="btn-secondary btn-sm" onclick="sendMsg('copyEndpoint')">📋 Copy</button>
                </div>

                <div class="tab-bar">
                    <button class="tab-btn active" onclick="switchTab(event,'tab-curl')">curl</button>
                    <button class="tab-btn" onclick="switchTab(event,'tab-python')">Python</button>
                    <button class="tab-btn" onclick="switchTab(event,'tab-node')">Node.js</button>
                    <button class="tab-btn" onclick="switchTab(event,'tab-ollama')">Ollama-compat</button>
                </div>

                <div id="tab-curl" class="tab-content active">
                    <div class="code-block" id="curl-example">curl <span class="url-base">http://localhost:11434/v1</span>/chat/completions \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer YOUR_TOKEN" \\
  -d '{
    "model": "gemini-2.5-flash",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'</div>
                    <button class="btn-ghost" style="margin-top:8px" onclick="copyCurl('curl')">📋 Copy command</button>
                </div>

                <div id="tab-python" class="tab-content">
                    <div class="code-block">from openai import OpenAI

client = OpenAI(
    base_url="<span class="url-base">http://localhost:11434/v1</span>",
    api_key="YOUR_TOKEN"
)

response = client.chat.completions.create(
    model="gemini-2.5-flash",
    messages=[{"role": "user", "content": "Hello!"}]
)
print(response.choices[0].message.content)</div>
                    <button class="btn-ghost" style="margin-top:8px" onclick="copyCurl('python')">📋 Copy code</button>
                </div>

                <div id="tab-node" class="tab-content">
                    <div class="code-block">import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "<span class="url-base">http://localhost:11434/v1</span>",
  apiKey: "YOUR_TOKEN",
});

const response = await client.chat.completions.create({
  model: "gemini-2.5-flash",
  messages: [{ role: "user", content: "Hello!" }],
});
console.log(response.choices[0].message.content);</div>
                    <button class="btn-ghost" style="margin-top:8px" onclick="copyCurl('node')">📋 Copy code</button>
                </div>

                <div id="tab-ollama" class="tab-content">
                    <div class="code-block">curl <span class="url-ollama-base">http://localhost:11434</span>/api/chat \\
  -d '{
    "model": "gemini-2.5-flash",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": false
  }'

# List models (Ollama format)
curl <span class="url-ollama-base">http://localhost:11434</span>/api/tags</div>
                    <button class="btn-ghost" style="margin-top:8px" onclick="copyCurl('ollama')">📋 Copy command</button>
                </div>
            </div>
        </div>

        <!-- Request Log Card -->
        <div class="card">
            <div class="card-header">
                <span><span class="icon">📋</span> Request Log</span>
                <div style="display:flex; gap:6px;">
                    <button class="btn-ghost" onclick="sendMsg('openOutputChannel')">Open Full Log</button>
                    <button class="btn-ghost" onclick="sendMsg('clearLogs')">Clear</button>
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
                        <button class="btn-secondary btn-sm" onclick="sendMsg('copyToken',{tokenId:'\${t.id}'})">📋</button>
                        <button class="btn-danger btn-sm" onclick="sendMsg('revokeToken',{tokenId:'\${t.id}'})">✕</button>
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
            modelSelect.innerHTML = '<option value="">(require explicit model)</option>' +
                models.map(m => \`<option value="\${m.id}" \${m.id === currentDefault ? 'selected' : ''}>\${m.id}</option>\`).join('');
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
                <span class="\${statusCls}">\${entry.statusCode}</span>
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
                    <button class="btn-primary btn-sm" onclick="sendMsg('copyToken',{tokenId:'\${data.id}'})">📋 Copy Token</button>
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

        // ─── Tabs ───
        function switchTab(event, tabId) {
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
            event.target.classList.add('active');
            document.getElementById(tabId).classList.add('active');
        }

        function copyCurl(type) {
            const blocks = {
                curl: document.querySelector('#tab-curl .code-block'),
                python: document.querySelector('#tab-python .code-block'),
                node: document.querySelector('#tab-node .code-block'),
                ollama: document.querySelector('#tab-ollama .code-block'),
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
