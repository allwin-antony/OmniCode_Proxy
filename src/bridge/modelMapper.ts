import * as vscode from 'vscode';
import * as https from 'https';
import { LanguageServerHarvester, HarvesterDetails } from './harvester.js';

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
        enumName?: string;
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

    // Harvester states
    private harvestedDetails: HarvesterDetails | null = null;
    private isAntigravityConnectMode = false;

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
     * Get active harvested server details if running in Antigravity mode.
     */
    public getHarvesterDetails(): HarvesterDetails | null {
        return this.harvestedDetails;
    }

    /**
     * Check if the bridge is currently using the direct Antigravity Connect RPC pipeline.
     */
    public isConnectMode(): boolean {
        return this.isAntigravityConnectMode;
    }

    /**
     * Initialize the model cache. Call during activation.
     */
    async initialize(): Promise<void> {
        this.logDiag('[Info] Initializing model discovery...');
        await this.refresh();

        // Progressive startup retries to capture slow-loading model providers (like SecureCoder)
        const retries = [2000, 5000, 10000, 18000];
        for (const delay of retries) {
            setTimeout(async () => {
                this.logDiag(`[Startup Timer] Running auto-refresh (after ${delay}ms delay)...`);
                await this.refresh();
            }, delay);
        }

        // Keep models list refreshed every 15s in the background to capture server restarts or late startups
        const backgroundInterval = setInterval(async () => {
            await this.refresh();
        }, 15000);
        this.disposables.push(new vscode.Disposable(() => clearInterval(backgroundInterval)));
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

            // Try standard vscode.lm selectChatModels first
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

            this.models.clear();

            if (chatModels.length > 0) {
                this.isAntigravityConnectMode = false;
                this.harvestedDetails = null;

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
            } else {
                // Connect RPC pipeline (Antigravity Mode)
                this.logDiag('[Info] 0 models found via vscode.lm. Initiating Antigravity Connect RPC harvest sequence...');
                try {
                    const details = await LanguageServerHarvester.getDetails(true);
                    this.harvestedDetails = details;
                    this.logDiag(`[Harvester] Discovered running LS PID: ${details.pid} | Token: ${details.csrfToken.substring(0, 8)}... | Dynamic Connect Port: ${details.connectPort}`);

                    // Fetch models list from Connect RPC endpoint GetCascadeModelConfigs
                    const configs = await this.queryConnectModelConfigs(details);
                    if (configs && configs.length > 0) {
                        this.isAntigravityConnectMode = true;
                        for (const config of configs) {
                            const family = config.family || 'gemini';
                            const modelId = config.modelName || family;
                            
                            // Check supportsThinking or recommended for token sizes
                            const maxTokens = config.maxTokens || 32768;

                             const openAIModel: OpenAIModel = {
                                id: modelId,
                                object: 'model',
                                created: Math.floor(Date.now() / 1000),
                                owned_by: config.modelProvider || 'google',
                                _meta: {
                                    family: family,
                                    version: config.displayName || '1.0',
                                    maxInputTokens: maxTokens,
                                    enumName: config.model || modelId
                                },
                             };

                            // Reference is dummy as we bypass vscode.lm during chat inference
                            this.models.set(modelId, { chatModel: {} as any, openAIModel });
                            this.logDiag(`[Discovered Connect Model] "${modelId}" (${config.displayName})`);
                        }
                    } else {
                        this.logDiag('[Warning] Direct Connect RPC returned empty model configs. Falling back to sandbox.');
                    }
                } catch (harvestErr: any) {
                    this.logDiag(`[Harvester Error] Resilient harvest failed: ${harvestErr.message}`);
                    this.isAntigravityConnectMode = false;
                    this.harvestedDetails = null;
                }
            }

            this._onDidChangeModels.fire(this.listModels());
        } catch (err: any) {
            this.logDiag(`[Critical Error] Failed to refresh models: ${err?.stack || err?.message || err}`);
            console.error('[LM Bridge] Failed to refresh models:', err);
        }
    }

    /**
     * Helper to query available model configurations from the Connect server endpoint.
     */
    private queryConnectModelConfigs(details: HarvesterDetails): Promise<any[]> {
        return new Promise(async (resolve) => {
            const configs: any[] = [];

            // Helper to make a Connect POST request
            const makeRequest = (path: string): Promise<any> => {
                return new Promise((resResolve) => {
                    const options = {
                        hostname: '127.0.0.1',
                        port: details.connectPort,
                        path: path,
                        method: 'POST',
                        rejectUnauthorized: false,
                        headers: {
                            'Content-Type': 'application/json',
                            'x-codeium-csrf-token': details.csrfToken,
                            'connect-protocol-version': '1'
                        }
                    };

                    const req = https.request(options, (res) => {
                        let body = '';
                        res.on('data', (chunk) => body += chunk);
                        res.on('end', () => {
                            if (res.statusCode === 200) {
                                try {
                                    resResolve(JSON.parse(body));
                                } catch (e) {
                                    resResolve(null);
                                }
                            } else {
                                resResolve(null);
                            }
                        });
                    });

                    req.on('error', () => {
                        resResolve(null);
                    });

                    req.write(JSON.stringify({}));
                    req.end();
                });
            };

            // Query both endpoints in parallel for maximum resilience
            const [cascadeRes, availableRes] = await Promise.all([
                makeRequest('/exa.language_server_pb.LanguageServerService/GetCascadeModelConfigs'),
                makeRequest('/exa.language_server_pb.LanguageServerService/GetAvailableModels')
            ]);

            // 1. Process GetCascadeModelConfigs response
            if (cascadeRes) {
                if (Array.isArray(cascadeRes.clientModelConfigs)) {
                    configs.push(...cascadeRes.clientModelConfigs);
                }
                if (cascadeRes.defaultOverrideModelConfig) {
                    configs.push(cascadeRes.defaultOverrideModelConfig);
                }
            }

            // 2. Process GetAvailableModels response
            if (availableRes) {
                // GetAvailableModels returns: { response: { models: { "modelId": { ... } } } }
                const modelsMap = (availableRes.response && availableRes.response.models) || availableRes.clientModelConfigs;
                if (modelsMap && typeof modelsMap === 'object') {
                    if (Array.isArray(modelsMap)) {
                        configs.push(...modelsMap);
                    } else {
                        // Map/Object format
                        for (const [modelName, cfg] of Object.entries(modelsMap)) {
                            if (cfg && typeof cfg === 'object') {
                                configs.push({
                                    modelName: modelName,
                                    ...(cfg as any)
                                });
                            }
                        }
                    }
                }
            }

            // Filter unique configs by modelName, normalizing casing
            const seen = new Set<string>();
            const uniqueConfigs = configs.filter(c => {
                if (!c.modelName) return false;
                const key = c.modelName.toLowerCase();
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            });

            this.logDiag(`[Success] Direct Connect RPC model discovery harvested ${uniqueConfigs.length} unique model configs.`);
            resolve(uniqueConfigs);
        });
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
