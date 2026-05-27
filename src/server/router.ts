import * as http from 'http';
import * as vscode from 'vscode';
import { LMBridge, ChatCompletionRequest, LMBridgeError } from '../bridge/omniBridge.js';
import { ModelMapper } from '../bridge/modelMapper.js';
import { RequestLogger } from '../logger.js';

/**
 * Router — Handles all HTTP route dispatching for the OpenAI-compatible API.
 *
 * Endpoints:
 *   GET  /v1/models          — List available models
 *   GET  /v1/models/:id      — Get specific model
 *   POST /v1/chat/completions — Chat completion (streaming & non-streaming)
 *   GET  /health              — Server health check
 *   POST /api/chat            — Ollama-compatible chat endpoint
 *   GET  /api/tags            — Ollama-compatible model list
 */

export class Router {
    private activeRequests = 0;
    private maxConcurrent: number;
    private readonly startTime = Date.now();

    constructor(
        private readonly omniBridge: LMBridge,
        private readonly modelMapper: ModelMapper,
        private readonly logger: RequestLogger
    ) {
        this.maxConcurrent = vscode.workspace.getConfiguration('omniBridge')
            .get<number>('maxConcurrentRequests', 5);
    }

    /**
     * Main request handler. Dispatches to the appropriate route handler.
     */
    async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        const startMs = Date.now();
        const method = req.method?.toUpperCase() || 'GET';
        const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
        const path = url.pathname;

        // CORS headers
        this.setCorsHeaders(res);

        // Handle preflight
        if (method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return;
        }

        this.logger.requestStarted();

        try {
            // ─── Route matching ───
            if (method === 'GET' && path === '/health') {
                await this.handleHealth(req, res);
            } else if (method === 'GET' && path === '/v1/models') {
                await this.handleListModels(req, res);
            } else if (method === 'GET' && path.startsWith('/v1/models/')) {
                const modelId = decodeURIComponent(path.substring('/v1/models/'.length));
                await this.handleGetModel(req, res, modelId);
            } else if (method === 'POST' && path === '/v1/chat/completions') {
                await this.handleChatCompletions(req, res);
            } else if (method === 'POST' && path === '/api/chat') {
                await this.handleOllamaChat(req, res);
            } else if (method === 'GET' && path === '/api/tags') {
                await this.handleOllamaTags(req, res);
            } else {
                this.sendJSON(res, 404, {
                    error: {
                        message: `Unknown endpoint: ${method} ${path}`,
                        type: 'not_found_error',
                        code: 404,
                    },
                });
            }
        } catch (err) {
            const lmErr = err instanceof LMBridgeError ? err : new LMBridgeError(500, String(err));
            this.sendJSON(res, lmErr.statusCode, lmErr.toJSON());
            this.logger.log({
                method, path,
                statusCode: lmErr.statusCode,
                responseTimeMs: Date.now() - startMs,
                error: lmErr.message,
            });
            return;
        }

        // Log after successful handling (streaming handlers log themselves)
        if (!path.includes('chat/completions') && !path.includes('/api/chat')) {
            this.logger.log({
                method, path,
                statusCode: (res as any).__statusCode || 200,
                responseTimeMs: Date.now() - startMs,
            });
        }
    }

    // ─── Route Handlers ───

    private async handleHealth(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        const stats = this.logger.getStats();
        this.sendJSON(res, 200, {
            status: 'ok',
            version: '0.1.0',
            uptime_seconds: Math.floor((Date.now() - this.startTime) / 1000),
            models_available: this.modelMapper.modelCount,
            requests: {
                total: stats.total,
                active: stats.active,
                errors: stats.errors,
            },
        });
    }

    private async handleListModels(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        const models = this.modelMapper.listModels();
        this.sendJSON(res, 200, {
            object: 'list',
            data: models,
        });
    }

    private async handleGetModel(req: http.IncomingMessage, res: http.ServerResponse, modelId: string): Promise<void> {
        const ref = this.modelMapper.getModel(modelId);
        if (!ref) {
            this.sendJSON(res, 404, {
                error: { message: `Model "${modelId}" not found.`, type: 'not_found_error', code: 404 },
            });
            return;
        }
        this.sendJSON(res, 200, ref.openAIModel);
    }

    private async handleChatCompletions(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        const startMs = Date.now();

        // Concurrency check
        if (this.activeRequests >= this.maxConcurrent) {
            this.sendJSON(res, 429, {
                error: { message: 'Too many concurrent requests. Try again later.', type: 'rate_limit_error', code: 429 },
            });
            this.logger.log({ method: 'POST', path: '/v1/chat/completions', statusCode: 429, responseTimeMs: Date.now() - startMs });
            return;
        }

        const body = await this.readBody(req);
        let request: ChatCompletionRequest;
        try {
            request = JSON.parse(body);
        } catch {
            this.sendJSON(res, 400, {
                error: { message: 'Invalid JSON in request body.', type: 'invalid_request_error', code: 400 },
            });
            this.logger.log({ method: 'POST', path: '/v1/chat/completions', statusCode: 400, responseTimeMs: Date.now() - startMs });
            return;
        }

        // Validate required fields
        if (!request.messages || !Array.isArray(request.messages) || request.messages.length === 0) {
            this.sendJSON(res, 400, {
                error: { message: 'messages field is required and must be a non-empty array.', type: 'invalid_request_error', code: 400 },
            });
            this.logger.log({ method: 'POST', path: '/v1/chat/completions', statusCode: 400, responseTimeMs: Date.now() - startMs });
            return;
        }

        const defaultModel = vscode.workspace.getConfiguration('omniBridge').get<string>('defaultModel', '');
        const modelName = request.model || defaultModel;

        if (!modelName) {
            this.sendJSON(res, 400, {
                error: { message: 'model field is required. Set a default model in settings or provide one in the request.', type: 'invalid_request_error', code: 400 },
            });
            this.logger.log({ method: 'POST', path: '/v1/chat/completions', statusCode: 400, responseTimeMs: Date.now() - startMs });
            return;
        }

        request.model = modelName;
        this.activeRequests++;

        try {
            if (request.stream) {
                // ─── Streaming response ───
                res.writeHead(200, {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                    'Connection': 'keep-alive',
                    'X-Accel-Buffering': 'no',
                });

                await this.omniBridge.chatCompletionStream(request, {
                    onChunk: (chunk) => {
                        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
                    },
                    onDone: () => {
                        res.write('data: [DONE]\n\n');
                        res.end();
                        this.logger.log({
                            method: 'POST', path: '/v1/chat/completions',
                            statusCode: 200, responseTimeMs: Date.now() - startMs,
                            model: modelName,
                        });
                    },
                    onError: (err) => {
                        const lmErr = err instanceof LMBridgeError ? err : new LMBridgeError(500, err.message);
                        res.write(`data: ${JSON.stringify({ error: lmErr.toJSON().error })}\n\n`);
                        res.write('data: [DONE]\n\n');
                        res.end();
                        this.logger.log({
                            method: 'POST', path: '/v1/chat/completions',
                            statusCode: lmErr.statusCode, responseTimeMs: Date.now() - startMs,
                            model: modelName, error: lmErr.message,
                        });
                    },
                }, defaultModel);
            } else {
                // ─── Non-streaming response ───
                const result = await this.omniBridge.chatCompletion(request, defaultModel);
                this.sendJSON(res, 200, result);
                this.logger.log({
                    method: 'POST', path: '/v1/chat/completions',
                    statusCode: 200, responseTimeMs: Date.now() - startMs,
                    model: modelName,
                    responsePreview: result.choices[0]?.message?.content?.substring(0, 200),
                });
            }
        } catch (err) {
            const lmErr = err instanceof LMBridgeError ? err : new LMBridgeError(500, String(err));
            if (!res.headersSent) {
                this.sendJSON(res, lmErr.statusCode, lmErr.toJSON());
            }
            this.logger.log({
                method: 'POST', path: '/v1/chat/completions',
                statusCode: lmErr.statusCode, responseTimeMs: Date.now() - startMs,
                model: modelName, error: lmErr.message,
            });
        } finally {
            this.activeRequests--;
        }
    }

    // ─── Ollama-compatible endpoints ───

    private async handleOllamaChat(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        const startMs = Date.now();
        const body = await this.readBody(req);

        let ollamaReq: any;
        try {
            ollamaReq = JSON.parse(body);
        } catch {
            this.sendJSON(res, 400, { error: 'Invalid JSON' });
            return;
        }

        // Convert Ollama format to OpenAI format
        const openAIReq: ChatCompletionRequest = {
            model: ollamaReq.model || '',
            messages: (ollamaReq.messages || []).map((m: any) => ({
                role: m.role || 'user',
                content: m.content || '',
            })),
            stream: ollamaReq.stream !== false, // Ollama streams by default
        };

        if (!openAIReq.model) {
            const defaultModel = vscode.workspace.getConfiguration('omniBridge').get<string>('defaultModel', '');
            openAIReq.model = defaultModel;
        }

        this.activeRequests++;
        try {
            if (openAIReq.stream) {
                res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });

                await this.omniBridge.chatCompletionStream(openAIReq, {
                    onChunk: (chunk) => {
                        const content = chunk.choices[0]?.delta?.content || '';
                        if (content) {
                            res.write(JSON.stringify({
                                model: openAIReq.model,
                                created_at: new Date().toISOString(),
                                message: { role: 'assistant', content },
                                done: false,
                            }) + '\n');
                        }
                    },
                    onDone: () => {
                        res.write(JSON.stringify({
                            model: openAIReq.model,
                            created_at: new Date().toISOString(),
                            message: { role: 'assistant', content: '' },
                            done: true,
                            done_reason: 'stop',
                        }) + '\n');
                        res.end();
                        this.logger.log({
                            method: 'POST', path: '/api/chat',
                            statusCode: 200, responseTimeMs: Date.now() - startMs,
                            model: openAIReq.model,
                        });
                    },
                    onError: (err) => {
                        res.write(JSON.stringify({ error: err.message }) + '\n');
                        res.end();
                    },
                });
            } else {
                const result = await this.omniBridge.chatCompletion(openAIReq);
                this.sendJSON(res, 200, {
                    model: openAIReq.model,
                    created_at: new Date().toISOString(),
                    message: result.choices[0]?.message,
                    done: true,
                    done_reason: 'stop',
                });
                this.logger.log({
                    method: 'POST', path: '/api/chat',
                    statusCode: 200, responseTimeMs: Date.now() - startMs,
                    model: openAIReq.model,
                });
            }
        } finally {
            this.activeRequests--;
        }
    }

    private async handleOllamaTags(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        const models = this.modelMapper.listModels();
        this.sendJSON(res, 200, {
            models: models.map(m => ({
                name: m.id,
                model: m.id,
                modified_at: new Date(m.created * 1000).toISOString(),
                size: 0,
                digest: '',
                details: {
                    parent_model: '',
                    format: 'api',
                    family: m._meta.family,
                    parameter_size: 'N/A',
                    quantization_level: 'N/A',
                },
            })),
        });
    }

    // ─── Utilities ───

    private setCorsHeaders(res: http.ServerResponse): void {
        const origins = vscode.workspace.getConfiguration('omniBridge')
            .get<string>('corsOrigins', '*');
        res.setHeader('Access-Control-Allow-Origin', origins);
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        res.setHeader('Access-Control-Max-Age', '86400');
    }

    private sendJSON(res: http.ServerResponse, statusCode: number, data: any): void {
        (res as any).__statusCode = statusCode;
        res.writeHead(statusCode, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
    }

    private readBody(req: http.IncomingMessage): Promise<string> {
        return new Promise((resolve, reject) => {
            let body = '';
            req.on('data', (chunk) => { body += chunk; });
            req.on('end', () => resolve(body));
            req.on('error', reject);
        });
    }

    /**
     * Update the max concurrent requests setting.
     */
    refreshSettings(): void {
        this.maxConcurrent = vscode.workspace.getConfiguration('omniBridge')
            .get<number>('maxConcurrentRequests', 5);
    }
}
