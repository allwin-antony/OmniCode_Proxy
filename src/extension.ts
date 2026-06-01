import * as vscode from 'vscode';
import { TokenManager } from './auth/tokenManager.js';
import { ModelMapper } from './bridge/modelMapper.js';
import { LMBridge } from './bridge/omniBridge.js';
import { AuthMiddleware } from './server/middleware.js';
import { Router } from './server/router.js';
import { HTTPServer } from './server/httpServer.js';
import { StatusBarManager } from './statusBar.js';
import { RequestLogger } from './logger.js';
import { ControlPanel } from './panel/controlPanel.js';

/**
 * Omni Bridge Extension — Entry Point
 * 
 * Exposes internal IDE language models as a local OpenAI-compatible HTTP API.
 * Think of it as "Ollama, but powered by the models already inside your IDE."
 */

let httpServer: HTTPServer;
let statusBar: StatusBarManager;
let controlPanel: ControlPanel;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    console.log('[Omni Bridge] Activating extension...');

    // Detect if running inside Antigravity IDE on Windows/macOS and notify the user
    const isAntigravity = vscode.env.appName.toLowerCase().includes('antigravity');
    if (isAntigravity && process.platform !== 'linux') {
        vscode.window.showWarningMessage(
            `Omni Bridge: The direct Antigravity Connect RPC bypass is only supported on Linux. It will not work on ${process.platform === 'darwin' ? 'macOS' : 'Windows'}. You can still use standard VS Code models (vscode.lm) if available.`,
            'Learn More'
        ).then(choice => {
            if (choice === 'Learn More') {
                vscode.env.openExternal(vscode.Uri.parse('https://github.com/allwin-antony/OmniCode_Proxy#%EF%B8%8F-requirements--os-compatibility'));
            }
        });
    }

    // ─── 1. Initialize core services ───
    const tokenManager = new TokenManager(context.secrets);
    await tokenManager.initialize();

    const modelMapper = new ModelMapper();
    await modelMapper.initialize();

    const omniBridge = new LMBridge(modelMapper);
    const logger = new RequestLogger();
    const authMiddleware = new AuthMiddleware(tokenManager);

    statusBar = new StatusBarManager();
    const router = new Router(omniBridge, modelMapper, logger);
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
        vscode.commands.registerCommand('omniBridge.startServer', async () => {
            try {
                await httpServer.start();
            } catch {
                // Error already handled in httpServer.start()
            }
        }),

        vscode.commands.registerCommand('omniBridge.stopServer', async () => {
            await httpServer.stop();
        }),

        vscode.commands.registerCommand('omniBridge.restartServer', async () => {
            await httpServer.restart();
        }),

        vscode.commands.registerCommand('omniBridge.openControlPanel', () => {
            controlPanel.open();
        }),

        vscode.commands.registerCommand('omniBridge.generateToken', async () => {
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

        vscode.commands.registerCommand('omniBridge.copyEndpoint', async () => {
            const endpoint = httpServer.getEndpointUrl();
            await vscode.env.clipboard.writeText(endpoint);
            vscode.window.showInformationMessage(`Endpoint copied: ${endpoint}`);
        })
    );

    // ─── 3. Listen for settings changes ───
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('omniBridge')) {
                logger.readLogLevel();
                router.refreshSettings();

                // If server is running and critical settings changed, notify user
                if (httpServer.isRunning() && (
                    e.affectsConfiguration('omniBridge.port') ||
                    e.affectsConfiguration('omniBridge.host')
                )) {
                    vscode.window.showInformationMessage(
                        'Omni Bridge: Server settings changed. Restart to apply.',
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
    const autoStart = vscode.workspace.getConfiguration('omniBridge').get<boolean>('autoStart', false);
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

    console.log('[Omni Bridge] Extension activated successfully.');
    console.log(`[Omni Bridge] ${modelMapper.modelCount} model(s) available.`);
}

export function deactivate(): void {
    console.log('[Omni Bridge] Deactivating extension...');
    if (httpServer) {
        httpServer.dispose();
    }
}
