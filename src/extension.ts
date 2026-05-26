import * as vscode from 'vscode';
import { TokenManager } from './auth/tokenManager.js';
import { ModelMapper } from './bridge/modelMapper.js';
import { LMBridge } from './bridge/lmBridge.js';
import { AuthMiddleware } from './server/middleware.js';
import { Router } from './server/router.js';
import { HTTPServer } from './server/httpServer.js';
import { StatusBarManager } from './statusBar.js';
import { RequestLogger } from './logger.js';
import { ControlPanel } from './panel/controlPanel.js';

/**
 * LM Bridge Extension — Entry Point
 * 
 * Exposes internal IDE language models as a local OpenAI-compatible HTTP API.
 * Think of it as "Ollama, but powered by the models already inside your IDE."
 */

let httpServer: HTTPServer;
let statusBar: StatusBarManager;
let controlPanel: ControlPanel;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    console.log('[LM Bridge] Activating extension...');

    // ─── 1. Initialize core services ───
    const tokenManager = new TokenManager(context.secrets);
    await tokenManager.initialize();

    const modelMapper = new ModelMapper();
    await modelMapper.initialize();

    const lmBridge = new LMBridge(modelMapper);
    const logger = new RequestLogger();
    const authMiddleware = new AuthMiddleware(tokenManager);

    statusBar = new StatusBarManager();
    const router = new Router(lmBridge, modelMapper, logger);
    httpServer = new HTTPServer(router, authMiddleware, statusBar, logger);

    controlPanel = new ControlPanel(
        httpServer,
        tokenManager,
        modelMapper,
        logger,
        context.extensionUri
    );

    // ─── 2. Register commands ───
    context.subscriptions.push(
        vscode.commands.registerCommand('lmBridge.startServer', async () => {
            try {
                await httpServer.start();
            } catch {
                // Error already handled in httpServer.start()
            }
        }),

        vscode.commands.registerCommand('lmBridge.stopServer', async () => {
            await httpServer.stop();
        }),

        vscode.commands.registerCommand('lmBridge.restartServer', async () => {
            await httpServer.restart();
        }),

        vscode.commands.registerCommand('lmBridge.openControlPanel', () => {
            controlPanel.open();
        }),

        vscode.commands.registerCommand('lmBridge.generateToken', async () => {
            const token = await tokenManager.generateToken();
            const copyChoice = await vscode.window.showInformationMessage(
                `New API token generated: ${token.token.substring(0, 12)}...`,
                'Copy to Clipboard',
                'Open Control Panel'
            );
            if (copyChoice === 'Copy to Clipboard') {
                await vscode.env.clipboard.writeText(token.token);
                vscode.window.showInformationMessage('Token copied to clipboard.');
            } else if (copyChoice === 'Open Control Panel') {
                controlPanel.open();
            }
        }),

        vscode.commands.registerCommand('lmBridge.copyEndpoint', async () => {
            const endpoint = httpServer.getEndpointUrl();
            await vscode.env.clipboard.writeText(endpoint);
            vscode.window.showInformationMessage(`Endpoint copied: ${endpoint}`);
        })
    );

    // ─── 3. Listen for settings changes ───
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('lmBridge')) {
                logger.readLogLevel();
                router.refreshSettings();

                // If server is running and critical settings changed, notify user
                if (httpServer.isRunning() && (
                    e.affectsConfiguration('lmBridge.port') ||
                    e.affectsConfiguration('lmBridge.host')
                )) {
                    vscode.window.showInformationMessage(
                        'LM Bridge: Server settings changed. Restart to apply.',
                        'Restart Server'
                    ).then(choice => {
                        if (choice === 'Restart Server') {
                            httpServer.restart();
                        }
                    });
                }
            }
        })
    );

    // ─── 4. Register disposables ───
    context.subscriptions.push(
        statusBar,
        logger,
        modelMapper,
        { dispose: () => httpServer.dispose() },
        { dispose: () => controlPanel.dispose() }
    );

    // ─── 5. Auto-start if configured ───
    const autoStart = vscode.workspace.getConfiguration('lmBridge').get<boolean>('autoStart', false);
    if (autoStart) {
        // Delay slightly to let the IDE finish loading
        setTimeout(async () => {
            try {
                await httpServer.start();
            } catch {
                // Error already handled
            }
        }, 2000);
    }

    console.log('[LM Bridge] Extension activated successfully.');
    console.log(`[LM Bridge] ${modelMapper.modelCount} model(s) available.`);
}

export function deactivate(): void {
    console.log('[LM Bridge] Deactivating extension...');
    if (httpServer) {
        httpServer.dispose();
    }
}
