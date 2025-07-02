import * as vscode from 'vscode';
import axios from 'axios';

export interface LLMClient {
    sendMessage(message: string): Promise<string>;
}

export class TogetherAIClient implements LLMClient {
    private apiKey: string;
    private model: string;
    private baseURL = 'https://api.together.xyz/v1';

    constructor(apiKey: string, model: string) {
        this.apiKey = apiKey;
        this.model = model;
    }

    async sendMessage(message: string): Promise<string> {
        if (!this.apiKey) {
            throw new Error('Please set your Together.ai API key in the extension settings');
        }

        try {
            const response = await axios.post(
                `${this.baseURL}/chat/completions`,
                {
                    model: this.model,
                    messages: [
                        {
                            role: 'system',
                            content: 'You are a helpful coding assistant. When providing code suggestions, always wrap them in triple backticks with the appropriate language identifier. Be concise and focus on solving the user\'s problem.'
                        },
                        {
                            role: 'user',
                            content: message
                        }
                    ],
                    max_tokens: 2048,
                    temperature: 0.7,
                    top_p: 0.9,
                    stop: ['<|eot_id|>']
                },
                {
                    headers: {
                        'Authorization': `Bearer ${this.apiKey}`,
                        'Content-Type': 'application/json'
                    }
                }
            );

            if (response.data.choices && response.data.choices.length > 0) {
                return response.data.choices[0].message.content;
            } else {
                throw new Error('No response from Together.ai');
            }
        } catch (error) {
            if (axios.isAxiosError(error)) {
                if (error.response?.status === 401) {
                    throw new Error('Invalid API key. Please check your Together.ai API key in settings.');
                } else if (error.response?.data?.error) {
                    throw new Error(`Together.ai error: ${error.response.data.error.message}`);
                }
            }
            throw error;
        }
    }
}

export class OllamaClient implements LLMClient {
    private model: string;
    private baseURL: string;

    constructor(baseURL: string, model: string) {
        this.baseURL = baseURL;
        this.model = model;
    }

    async sendMessage(message: string): Promise<string> {
        try {
            // First, check if Ollama is running and the model is available
            await this.ensureModelAvailable();

            const response = await axios.post(
                `${this.baseURL}/api/generate`,
                {
                    model: this.model,
                    prompt: `You are a helpful coding assistant. When providing code suggestions, always wrap them in triple backticks with the appropriate language identifier. Be concise and focus on solving the user's problem.\n\nUser: ${message}\n\nAssistant:`,
                    stream: false
                },
                {
                    headers: {
                        'Content-Type': 'application/json'
                    }
                }
            );

            if (response.data.response) {
                return response.data.response;
            } else {
                throw new Error('No response from Ollama');
            }
        } catch (error) {
            if (axios.isAxiosError(error)) {
                if (error.code === 'ECONNREFUSED') {
                    throw new Error('Cannot connect to Ollama. Make sure Ollama is running on ' + this.baseURL);
                } else if (error.response?.status === 404) {
                    throw new Error(`Model '${this.model}' not found. Run 'ollama pull ${this.model}' to download it.`);
                }
            }
            throw error;
        }
    }

    private async ensureModelAvailable(): Promise<void> {
        try {
            // Check if Ollama is running
            const response = await axios.get(`${this.baseURL}/api/tags`);
            const models = response.data.models || [];
            const modelExists = models.some((m: any) => m.name === this.model || m.name === `${this.model}:latest`);
            
            if (!modelExists) {
                throw new Error(`Model '${this.model}' is not available. Run 'ollama pull ${this.model}' to download it.`);
            }
        } catch (error) {
            if (axios.isAxiosError(error) && error.code === 'ECONNREFUSED') {
                throw new Error('Cannot connect to Ollama. Make sure Ollama is running.');
            }
            throw error;
        }
    }
}

export class LLMClientFactory {
    static create(config: vscode.WorkspaceConfiguration): LLMClient {
        const provider = config.get<string>('provider') || 'ollama';
        const model = config.get<string>('model') || 'llama3';

        if (provider === 'together') {
            const apiKey = config.get<string>('apiKey') || '';
            return new TogetherAIClient(apiKey, model);
        } else {
            const ollamaUrl = config.get<string>('ollamaUrl') || 'http://localhost:11434';
            return new OllamaClient(ollamaUrl, model);
        }
    }
}