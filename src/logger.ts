import * as vscode from 'vscode';

/**
 * RequestLogger — Logs API requests to a VS Code Output Channel
 * and maintains an in-memory ring buffer for the Control Panel's live view.
 */

export interface LogEntry {
    id: string;
    timestamp: number;
    method: string;
    path: string;
    statusCode: number;
    responseTimeMs: number;
    model?: string;
    tokenMasked?: string;
    error?: string;
    requestBody?: string;
    responsePreview?: string;
}

type LogLevel = 'none' | 'error' | 'info' | 'debug';

export class RequestLogger {
    private readonly outputChannel: vscode.OutputChannel;
    private readonly ringBuffer: LogEntry[] = [];
    private readonly maxEntries = 100;
    private logLevel: LogLevel = 'info';

    private readonly _onDidLog = new vscode.EventEmitter<LogEntry>();
    public readonly onDidLog = this._onDidLog.event;

    // Stats
    private totalRequests = 0;
    private activeRequests = 0;
    private totalErrors = 0;

    constructor() {
        this.outputChannel = vscode.window.createOutputChannel('Omni Bridge', { log: true });
        this.readLogLevel();
    }

    /**
     * Re-read the log level from settings.
     */
    readLogLevel(): void {
        const config = vscode.workspace.getConfiguration('omniBridge');
        this.logLevel = config.get<LogLevel>('logLevel', 'info');
    }

    /**
     * Mark a request as started (increments active counter).
     */
    requestStarted(): void {
        this.activeRequests++;
        this.totalRequests++;
    }

    /**
     * Log a completed request.
     */
    log(entry: Omit<LogEntry, 'id' | 'timestamp'>): void {
        this.activeRequests = Math.max(0, this.activeRequests - 1);

        const fullEntry: LogEntry = {
            id: `${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
            timestamp: Date.now(),
            ...entry,
        };

        if (entry.statusCode >= 400) {
            this.totalErrors++;
        }

        // Add to ring buffer
        this.ringBuffer.push(fullEntry);
        if (this.ringBuffer.length > this.maxEntries) {
            this.ringBuffer.shift();
        }

        // Write to output channel based on log level
        this.writeToChannel(fullEntry);

        // Emit for webview live updates
        this._onDidLog.fire(fullEntry);
    }

    /**
     * Get recent log entries for the Control Panel.
     */
    getRecentLogs(count: number = 50): LogEntry[] {
        return this.ringBuffer.slice(-count);
    }

    /**
     * Get aggregate stats.
     */
    getStats(): { total: number; active: number; errors: number } {
        return {
            total: this.totalRequests,
            active: this.activeRequests,
            errors: this.totalErrors,
        };
    }

    /**
     * Reset all stats and clear the log buffer.
     */
    reset(): void {
        this.ringBuffer.length = 0;
        this.totalRequests = 0;
        this.activeRequests = 0;
        this.totalErrors = 0;
        this.outputChannel.clear();
    }

    /**
     * Show the output channel in the IDE.
     */
    show(): void {
        this.outputChannel.show(true);
    }

    private writeToChannel(entry: LogEntry): void {
        if (this.logLevel === 'none') {
            return;
        }

        const time = new Date(entry.timestamp).toISOString().substring(11, 23);
        const status = entry.statusCode;
        const duration = `${entry.responseTimeMs}ms`;

        if (this.logLevel === 'error' && status < 400) {
            return;
        }

        const line = `[${time}] ${entry.method.padEnd(6)} ${entry.path.padEnd(30)} ${status} ${duration.padStart(8)}${entry.model ? ` model=${entry.model}` : ''}`;
        
        if (status >= 500) {
            this.outputChannel.appendLine(`❌ ${line}${entry.error ? ` — ${entry.error}` : ''}`);
        } else if (status >= 400) {
            this.outputChannel.appendLine(`⚠️  ${line}`);
        } else {
            this.outputChannel.appendLine(`✅ ${line}`);
        }

        if (this.logLevel === 'debug') {
            if (entry.requestBody) {
                this.outputChannel.appendLine(`   ← ${entry.requestBody.substring(0, 500)}`);
            }
            if (entry.responsePreview) {
                this.outputChannel.appendLine(`   → ${entry.responsePreview.substring(0, 500)}`);
            }
        }
    }

    dispose(): void {
        this._onDidLog.dispose();
        this.outputChannel.dispose();
    }
}
