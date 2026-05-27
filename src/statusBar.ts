import * as vscode from 'vscode';

/**
 * StatusBarManager — Manages the persistent status bar item
 * showing server state, port, and request stats.
 */

export type ServerState = 'stopped' | 'starting' | 'running' | 'error';

export class StatusBarManager {
    private readonly item: vscode.StatusBarItem;
    private state: ServerState = 'stopped';
    private port: number = 0;
    private startTime: number = 0;
    private requestCount: number = 0;

    constructor() {
        this.item = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Right,
            50
        );
        this.item.command = 'omniBridge.openControlPanel';
        this.item.name = 'Omni Bridge';
        this.update('stopped');
        this.item.show();
    }

    /**
     * Update the status bar state.
     */
    update(state: ServerState, port?: number): void {
        this.state = state;
        if (port !== undefined) {
            this.port = port;
        }

        switch (state) {
            case 'stopped':
                this.item.text = '$(circle-slash) Omni Bridge: Off';
                this.item.tooltip = 'Omni Bridge — Server is stopped. Click to open Control Panel.';
                this.item.backgroundColor = undefined;
                this.startTime = 0;
                this.requestCount = 0;
                break;

            case 'starting':
                this.item.text = '$(loading~spin) Omni Bridge: Starting...';
                this.item.tooltip = 'Omni Bridge — Server is starting...';
                this.item.backgroundColor = undefined;
                break;

            case 'running':
                this.startTime = Date.now();
                this.item.text = `$(broadcast) Omni Bridge: :${this.port}`;
                this.updateRunningTooltip();
                this.item.backgroundColor = undefined;
                break;

            case 'error':
                this.item.text = '$(warning) Omni Bridge: Error';
                this.item.tooltip = 'Omni Bridge — Server encountered an error. Click to open Control Panel.';
                this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
                break;
        }
    }

    /**
     * Update request count (called on each request).
     */
    incrementRequests(): void {
        this.requestCount++;
        if (this.state === 'running') {
            this.updateRunningTooltip();
        }
    }

    /**
     * Get the current server state.
     */
    getState(): ServerState {
        return this.state;
    }

    /**
     * Get uptime in seconds (0 if not running).
     */
    getUptimeSeconds(): number {
        if (this.startTime === 0) {
            return 0;
        }
        return Math.floor((Date.now() - this.startTime) / 1000);
    }

    private updateRunningTooltip(): void {
        const uptime = this.formatUptime();
        this.item.tooltip = new vscode.MarkdownString(
            `**Omni Bridge** — Running\n\n` +
            `- **Endpoint:** \`http://localhost:${this.port}/v1\`\n` +
            `- **Uptime:** ${uptime}\n` +
            `- **Requests:** ${this.requestCount}\n\n` +
            `_Click to open Control Panel_`
        );
    }

    private formatUptime(): string {
        const secs = this.getUptimeSeconds();
        if (secs < 60) { return `${secs}s`; }
        if (secs < 3600) { return `${Math.floor(secs / 60)}m ${secs % 60}s`; }
        const h = Math.floor(secs / 3600);
        const m = Math.floor((secs % 3600) / 60);
        return `${h}h ${m}m`;
    }

    dispose(): void {
        this.item.dispose();
    }
}
