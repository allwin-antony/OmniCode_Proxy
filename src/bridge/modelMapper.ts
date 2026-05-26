import * as vscode from 'vscode';

/**
 * ModelMapper — Discovers, caches, and maps internal IDE language models
 * to the OpenAI `/v1/models` response format.
 *
 * Listens for model availability changes and keeps the cache fresh.
 */

export interface OpenAIModel {
    id: string;
    object: 'model';
    created: number;
    owned_by: string;
    // Extra metadata not in OpenAI spec but useful
    _meta: {
        family: string;
        version: string;
        maxInputTokens: number;
    };
}

export interface InternalModelRef {
    chatModel: vscode.LanguageModelChat;
    openAIModel: OpenAIModel;
}

export class ModelMapper {
    private models: Map<string, InternalModelRef> = new Map();
    private readonly _onDidChangeModels = new vscode.EventEmitter<OpenAIModel[]>();
    public readonly onDidChangeModels = this._onDidChangeModels.event;

    private disposables: vscode.Disposable[] = [];

    private readonly diagnosticsChannel = vscode.window.createOutputChannel('LM Bridge Diagnostics');

    constructor() {
        // Listen for model changes and refresh cache
        this.disposables.push(
            vscode.lm.onDidChangeChatModels(async () => {
                this.logDiag('[Event] onDidChangeChatModels fired, refreshing models...');
                await this.refresh();
            })
        );
        this.logDiag(`[Info] ModelMapper constructed. IDE Version: ${vscode.version}`);
    }

    private logDiag(msg: string): void {
        const time = new Date().toLocaleTimeString();
        this.diagnosticsChannel.appendLine(`[${time}] ${msg}`);
    }

    /**
     * Initialize the model cache. Call during activation.
     */
    async initialize(): Promise<void> {
        this.logDiag('[Info] Initializing model discovery...');
        await this.refresh();
        this.diagnosticsChannel.show(true); // Proactively show diagnostics on startup to help troubleshoot

        // Progressive startup retries to capture slow-loading model providers (like SecureCoder)
        const retries = [2000, 5000, 10000, 18000];
        for (const delay of retries) {
            setTimeout(async () => {
                this.logDiag(`[Startup Timer] Running auto-refresh (after ${delay}ms delay)...`);
                await this.refresh();
            }, delay);
        }
    }


    /**
     * Refresh the model cache by querying all available models.
     */
    async refresh(): Promise<void> {
        try {
            this.logDiag('[Info] Querying available chat models...');
            
            if (!vscode.lm) {
                this.logDiag('[Error] vscode.lm namespace is NOT defined! The Language Model API is not supported in this version/environment.');
                return;
            }

            // Try with no arguments first
            this.logDiag('[Info] Calling vscode.lm.selectChatModels() with undefined selector...');
            let chatModels: vscode.LanguageModelChat[] = [];
            try {
                chatModels = await vscode.lm.selectChatModels();
                this.logDiag(`[Success] selectChatModels() returned ${chatModels.length} models.`);
            } catch (err: any) {
                this.logDiag(`[Error] selectChatModels() failed: ${err?.message || err}`);
            }

            // Fallback: If empty, try with empty selector object {}
            if (chatModels.length === 0) {
                this.logDiag('[Info] Calling vscode.lm.selectChatModels({}) with empty selector object...');
                try {
                    chatModels = await vscode.lm.selectChatModels({});
                    this.logDiag(`[Success] selectChatModels({}) returned ${chatModels.length} models.`);
                } catch (err: any) {
                    this.logDiag(`[Error] selectChatModels({}) failed: ${err?.message || err}`);
                }
            }

            // Introspect vscode namespace for any hidden or custom model APIs
            this.logDiag('[Info] Scanning vscode namespace for other AI/chat/model APIs...');
            try {
                const keys = Object.keys(vscode);
                const relevantKeys = keys.filter(k => {
                    const kl = k.toLowerCase();
                    return kl.includes('lm') || kl.includes('chat') || kl.includes('ai') || kl.includes('model') || kl.includes('gemini');
                });
                this.logDiag(`[Introspect] Found relevant keys in vscode namespace: ${JSON.stringify(relevantKeys)}`);
                
                // If there's an active chat or ai namespace, let's log its properties
                for (const key of relevantKeys) {
                    const ns = (vscode as any)[key];
                    if (ns && typeof ns === 'object') {
                        const subkeys = Object.keys(ns);
                        this.logDiag(`[Introspect] vscode.${key} has properties: ${JSON.stringify(subkeys)}`);
                    }
                }

                // Check out the custom model proxy functions on vscode.lm
                const lm: any = vscode.lm;
                if (lm) {
                    this.logDiag(`[Introspect] typeof lm.isModelProxyAvailable: ${typeof lm.isModelProxyAvailable}`);
                    this.logDiag(`[Introspect] typeof lm.getModelProxy: ${typeof lm.getModelProxy}`);

                    if (typeof lm.isModelProxyAvailable === 'function') {
                        const available = lm.isModelProxyAvailable();
                        this.logDiag(`[Introspect] lm.isModelProxyAvailable() returned: ${available}`);
                    } else if (typeof lm.isModelProxyAvailable === 'boolean') {
                        this.logDiag(`[Introspect] lm.isModelProxyAvailable value: ${lm.isModelProxyAvailable}`);
                    }

                    if (typeof lm.getModelProxy === 'function') {
                        try {
                            const proxy = await lm.getModelProxy();
                            this.logDiag(`[Introspect] lm.getModelProxy() returned typeof: ${typeof proxy}`);
                            if (proxy && typeof proxy === 'object') {
                                this.logDiag(`[Introspect] lm.getModelProxy() keys: ${JSON.stringify(Object.keys(proxy))}`);
                                // If it has functions, print their names and types
                                for (const pk of Object.keys(proxy)) {
                                    this.logDiag(`[Introspect] proxy.${pk} typeof: ${typeof proxy[pk]}`);
                                }
                            }
                        } catch (proxyErr: any) {
                            this.logDiag(`[Introspect Error] lm.getModelProxy() rejected: ${proxyErr?.message || proxyErr}`);
                        }
                    }

                }
            } catch (e: any) {
                this.logDiag(`[Introspect Error] Failed to scan namespace: ${e.message}`);
            }



            this.models.clear();

            if (chatModels.length === 0) {
                this.logDiag('[Warning] 0 language models were discovered. Check if an AI provider extension is installed and signed in.');
            }

            for (const cm of chatModels) {
                const modelId = this.buildModelId(cm);
                this.logDiag(`[Discovered] Model ID: "${modelId}" | Vendor: "${cm.vendor}" | Family: "${cm.family}" | Version: "${cm.version}" | MaxInputTokens: ${cm.maxInputTokens}`);
                
                const openAIModel: OpenAIModel = {
                    id: modelId,
                    object: 'model',
                    created: Math.floor(Date.now() / 1000),
                    owned_by: cm.vendor || 'unknown',
                    _meta: {
                        family: cm.family,
                        version: cm.version,
                        maxInputTokens: cm.maxInputTokens,
                    },
                };

                this.models.set(modelId, { chatModel: cm, openAIModel });
            }

            this._onDidChangeModels.fire(this.listModels());
        } catch (err: any) {
            this.logDiag(`[Critical Error] Failed to refresh models: ${err?.stack || err?.message || err}`);
            console.error('[LM Bridge] Failed to refresh models:', err);
        }
    }


    /**
     * List all available models in OpenAI format.
     */
    listModels(): OpenAIModel[] {
        const list = Array.from(this.models.values()).map(m => m.openAIModel);
        if (list.length === 0) {
            list.push({
                id: 'mock-gemini-sandbox',
                object: 'model',
                created: Math.floor(Date.now() / 1000),
                owned_by: 'lm-bridge-sandbox',
                _meta: {
                    family: 'gemini-sandbox',
                    version: '1.0',
                    maxInputTokens: 8192,
                }
            });
        }
        return list;
    }

    /**
     * Get a specific model by its ID.
     */
    getModel(modelId: string): InternalModelRef | undefined {
        if (this.models.size === 0 && modelId === 'mock-gemini-sandbox') {
            return this.getMockModelRef();
        }
        return this.models.get(modelId);
    }

    /**
     * Resolve a model from a request. Tries exact match first, then family match,
     * then falls back to the default model if configured.
     */
    resolveModel(requestedModel: string, defaultModel?: string): InternalModelRef | undefined {
        // If there are no real models discovered, fall back immediately to the virtual sandbox model
        if (this.models.size === 0) {
            return this.getMockModelRef();
        }

        // 1. Exact ID match
        const exact = this.models.get(requestedModel);
        if (exact) {
            return exact;
        }

        // 2. Family match (e.g., "gemini-2.5-flash" matches any model in that family)
        for (const [, ref] of this.models) {
            if (ref.openAIModel._meta.family === requestedModel) {
                return ref;
            }
        }

        // 3. Partial/fuzzy match (model ID contains the requested string)
        for (const [id, ref] of this.models) {
            if (id.toLowerCase().includes(requestedModel.toLowerCase())) {
                return ref;
            }
        }

        // 4. Default model fallback
        if (defaultModel && defaultModel !== requestedModel) {
            return this.resolveModel(defaultModel);
        }

        // 5. Return the first available model as last resort
        const first = this.models.values().next();
        return first.done ? undefined : first.value;
    }

    /**
     * Get the number of available models.
     */
    get modelCount(): number {
        return this.models.size === 0 ? 1 : this.models.size;
    }

    /**
     * Create a virtual model reference for sandbox/testing purposes when no AI extension is signed in.
     */
    private getMockModelRef(): InternalModelRef {
        return {
            chatModel: {} as any, // Dummy, intercepted during request
            openAIModel: {
                id: 'mock-gemini-sandbox',
                object: 'model',
                created: Math.floor(Date.now() / 1000),
                owned_by: 'lm-bridge-sandbox',
                _meta: {
                    family: 'gemini-sandbox',
                    version: '1.0',
                    maxInputTokens: 8192,
                }
            }
        };
    }


    /**
     * Build a unique, stable model ID from a vscode LanguageModelChat.
     * Format: "vendor:family" or just "family" if vendor is generic.
     */
    private buildModelId(cm: vscode.LanguageModelChat): string {
        if (cm.vendor && cm.vendor !== 'copilot') {
            return `${cm.vendor}/${cm.family}`;
        }
        return cm.family || cm.id;
    }

    dispose(): void {
        this.disposables.forEach(d => d.dispose());
        this._onDidChangeModels.dispose();
        this.diagnosticsChannel.dispose();
    }
}
