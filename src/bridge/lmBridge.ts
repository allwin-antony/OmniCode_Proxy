import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { ModelMapper, InternalModelRef } from './modelMapper.js';

/**
 * LMBridge — Core adapter that translates OpenAI Chat Completions API requests
 * into vscode.lm Language Model API calls and streams responses back.
 */

// ─── OpenAI-compatible request/response types ───

export interface ChatCompletionRequest {
    model: string;
    messages: Array<{
        role: 'system' | 'user' | 'assistant';
        content: string;
    }>;
    stream?: boolean;
    temperature?: number;
    max_tokens?: number;
    top_p?: number;
    stop?: string | string[];
}

export interface ChatCompletionResponse {
    id: string;
    object: 'chat.completion';
    created: number;
    model: string;
    choices: Array<{
        index: number;
        message: {
            role: 'assistant';
            content: string;
        };
        finish_reason: 'stop' | 'length' | null;
    }>;
    usage: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
    };
}

export interface ChatCompletionChunk {
    id: string;
    object: 'chat.completion.chunk';
    created: number;
    model: string;
    choices: Array<{
        index: number;
        delta: {
            role?: 'assistant';
            content?: string;
        };
        finish_reason: 'stop' | 'length' | null;
    }>;
}

export interface StreamCallbacks {
    onChunk: (chunk: ChatCompletionChunk) => void;
    onDone: () => void;
    onError: (error: Error) => void;
}

export class LMBridge {
    constructor(private readonly modelMapper: ModelMapper) {}

    /**
     * Handle a non-streaming chat completion request.
     * Collects all response chunks and returns a single response object.
     */
    async chatCompletion(
        request: ChatCompletionRequest,
        defaultModel?: string
    ): Promise<ChatCompletionResponse> {
        const modelRef = this.modelMapper.resolveModel(request.model, defaultModel);
        if (!modelRef) {
            throw new LMBridgeError(
                404,
                `Model "${request.model}" not found. Available models: ${this.modelMapper.listModels().map(m => m.id).join(', ')}`
            );
        }

        if (modelRef.openAIModel.id === 'mock-gemini-sandbox') {
            return this.handleMockChatCompletion(request, modelRef.openAIModel.id);
        }


        const messages = this.convertMessages(request.messages);
        const options = this.buildOptions(request);
        const completionId = this.generateCompletionId();
        const created = Math.floor(Date.now() / 1000);

        try {
            const cts = new vscode.CancellationTokenSource();
            // Set timeout
            const timeout = vscode.workspace.getConfiguration('lmBridge').get<number>('requestTimeout', 120000);
            const timer = setTimeout(() => cts.cancel(), timeout);

            const response = await modelRef.chatModel.sendRequest(
                messages,
                options,
                cts.token
            );

            let fullContent = '';
            for await (const chunk of response.text) {
                fullContent += chunk;
            }

            clearTimeout(timer);
            cts.dispose();

            return {
                id: completionId,
                object: 'chat.completion',
                created,
                model: this.getModelId(modelRef),
                choices: [{
                    index: 0,
                    message: {
                        role: 'assistant',
                        content: fullContent,
                    },
                    finish_reason: 'stop',
                }],
                usage: {
                    prompt_tokens: -1,  // vscode.lm doesn't expose token counts
                    completion_tokens: -1,
                    total_tokens: -1,
                },
            };
        } catch (err) {
            throw this.wrapError(err);
        }
    }

    /**
     * Handle a streaming chat completion request.
     * Calls back with SSE-compatible chunks as they arrive.
     */
    async chatCompletionStream(
        request: ChatCompletionRequest,
        callbacks: StreamCallbacks,
        defaultModel?: string
    ): Promise<void> {
        const modelRef = this.modelMapper.resolveModel(request.model, defaultModel);
        if (!modelRef) {
            callbacks.onError(new LMBridgeError(
                404,
                `Model "${request.model}" not found.`
            ));
            return;
        }

        if (modelRef.openAIModel.id === 'mock-gemini-sandbox') {
            return this.handleMockChatCompletionStream(request, callbacks, modelRef.openAIModel.id);
        }


        const messages = this.convertMessages(request.messages);
        const options = this.buildOptions(request);
        const completionId = this.generateCompletionId();
        const created = Math.floor(Date.now() / 1000);
        const modelId = this.getModelId(modelRef);

        try {
            const cts = new vscode.CancellationTokenSource();
            const timeout = vscode.workspace.getConfiguration('lmBridge').get<number>('requestTimeout', 120000);
            const timer = setTimeout(() => cts.cancel(), timeout);

            const response = await modelRef.chatModel.sendRequest(
                messages,
                options,
                cts.token
            );

            // Send initial chunk with role
            callbacks.onChunk({
                id: completionId,
                object: 'chat.completion.chunk',
                created,
                model: modelId,
                choices: [{
                    index: 0,
                    delta: { role: 'assistant' },
                    finish_reason: null,
                }],
            });

            // Stream content chunks
            for await (const text of response.text) {
                callbacks.onChunk({
                    id: completionId,
                    object: 'chat.completion.chunk',
                    created,
                    model: modelId,
                    choices: [{
                        index: 0,
                        delta: { content: text },
                        finish_reason: null,
                    }],
                });
            }

            clearTimeout(timer);
            cts.dispose();

            // Send final chunk with finish_reason
            callbacks.onChunk({
                id: completionId,
                object: 'chat.completion.chunk',
                created,
                model: modelId,
                choices: [{
                    index: 0,
                    delta: {},
                    finish_reason: 'stop',
                }],
            });

            callbacks.onDone();
        } catch (err) {
            callbacks.onError(this.wrapError(err));
        }
    }

    /**
     * Convert OpenAI message format to vscode.lm message format.
     */
    private convertMessages(
        messages: ChatCompletionRequest['messages']
    ): vscode.LanguageModelChatMessage[] {
        return messages.map(msg => {
            switch (msg.role) {
                case 'system':
                    // vscode.lm treats system as User with a system-like prefix
                    return vscode.LanguageModelChatMessage.User(
                        `[System Instruction]\n${msg.content}`
                    );
                case 'user':
                    return vscode.LanguageModelChatMessage.User(msg.content);
                case 'assistant':
                    return vscode.LanguageModelChatMessage.Assistant(msg.content);
                default:
                    return vscode.LanguageModelChatMessage.User(msg.content);
            }
        });
    }

    /**
     * Build vscode.lm request options from OpenAI parameters.
     */
    private buildOptions(request: ChatCompletionRequest): vscode.LanguageModelChatRequestOptions {
        const options: vscode.LanguageModelChatRequestOptions = {};

        // Note: vscode.lm has limited option support compared to OpenAI.
        // We pass what we can and ignore the rest gracefully.
        if (request.model) {
            options.modelOptions = {};
            if (request.temperature !== undefined) {
                (options.modelOptions as Record<string, unknown>)['temperature'] = request.temperature;
            }
            if (request.max_tokens !== undefined) {
                (options.modelOptions as Record<string, unknown>)['maxTokens'] = request.max_tokens;
            }
            if (request.top_p !== undefined) {
                (options.modelOptions as Record<string, unknown>)['topP'] = request.top_p;
            }
        }

        return options;
    }

    private getModelId(ref: InternalModelRef): string {
        return ref.openAIModel.id;
    }

    private generateCompletionId(): string {
        return `chatcmpl-${crypto.randomUUID().replace(/-/g, '').substring(0, 24)}`;
    }

    private wrapError(err: unknown): LMBridgeError {
        if (err instanceof LMBridgeError) {
            return err;
        }
        const message = err instanceof Error ? err.message : String(err);

        // Map known vscode.lm errors to HTTP status codes
        if (message.includes('consent') || message.includes('Consent')) {
            return new LMBridgeError(403, `Model access requires user consent in the IDE. ${message}`);
        }
        if (message.includes('rate') || message.includes('Rate')) {
            return new LMBridgeError(429, `Rate limit exceeded. ${message}`);
        }
        if (message.includes('cancel') || message.includes('Cancel')) {
            return new LMBridgeError(408, `Request timed out or was cancelled. ${message}`);
        }

        return new LMBridgeError(500, `Internal model error: ${message}`);
    }

    private generateMockReply(request: ChatCompletionRequest): string {
        const prompt = request.messages[request.messages.length - 1]?.content || '';
        const port = vscode.workspace.getConfiguration('lmBridge').get<number>('port', 11434);
        return `🤖 [LM Bridge Sandbox Mode]
This is a simulated response from your local API server.

LM Bridge is active, authenticated, and successfully listening on port ${port}.

Why am I seeing this mock model?
1. The IDE's public Language Model extension API (vscode.lm) currently reports 0 active models in this window. 
2. If you are testing in the isolated Extension Development Host (F5 debug window), make sure you have an AI companion extension installed (like GitHub Copilot or Gemini Code Assist) and that you are signed into it via the Accounts icon in the bottom-left of the status bar.

However, your local API server is 100% operational! You can continue testing CORS, API tokens, Ollama/OpenAI compatibility, and stream parsing.

Your prompt was: "${prompt}"`;
    }

    private handleMockChatCompletion(
        request: ChatCompletionRequest,
        modelId: string
    ): ChatCompletionResponse {
        const reply = this.generateMockReply(request);
        return {
            id: this.generateCompletionId(),
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: modelId,
            choices: [{
                index: 0,
                message: {
                    role: 'assistant',
                    content: reply,
                },
                finish_reason: 'stop',
            }],
            usage: {
                prompt_tokens: -1,
                completion_tokens: -1,
                total_tokens: -1,
            },
        };
    }

    private async handleMockChatCompletionStream(
        request: ChatCompletionRequest,
        callbacks: StreamCallbacks,
        modelId: string
    ): Promise<void> {
        const reply = this.generateMockReply(request);
        const completionId = this.generateCompletionId();
        const created = Math.floor(Date.now() / 1000);

        try {
            // Send initial chunk with role
            callbacks.onChunk({
                id: completionId,
                object: 'chat.completion.chunk',
                created,
                model: modelId,
                choices: [{
                    index: 0,
                    delta: { role: 'assistant' },
                    finish_reason: null,
                }],
            });

            // Stream content chunks word-by-word with a tiny delay
            const words = reply.split(/(\s+)/);
            for (const word of words) {
                if (word.length === 0) continue;
                await new Promise(resolve => setTimeout(resolve, 8)); // 8ms delay
                callbacks.onChunk({
                    id: completionId,
                    object: 'chat.completion.chunk',
                    created,
                    model: modelId,
                    choices: [{
                        index: 0,
                        delta: { content: word },
                        finish_reason: null,
                    }],
                });
            }

            // Final chunk
            callbacks.onChunk({
                id: completionId,
                object: 'chat.completion.chunk',
                created,
                model: modelId,
                choices: [{
                    index: 0,
                    delta: {},
                    finish_reason: 'stop',
                }],
            });

            callbacks.onDone();
        } catch (err: any) {
            callbacks.onError(err);
        }
    }
}


/**
 * Custom error class with HTTP status code mapping.
 */
export class LMBridgeError extends Error {
    constructor(
        public readonly statusCode: number,
        message: string
    ) {
        super(message);
        this.name = 'LMBridgeError';
    }

    toJSON() {
        return {
            error: {
                message: this.message,
                type: this.statusCode === 404 ? 'not_found_error'
                    : this.statusCode === 429 ? 'rate_limit_error'
                    : this.statusCode === 403 ? 'permission_error'
                    : this.statusCode === 408 ? 'timeout_error'
                    : 'api_error',
                code: this.statusCode,
            },
        };
    }
}
