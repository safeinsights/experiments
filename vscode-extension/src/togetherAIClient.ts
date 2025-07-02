import * as vscode from 'vscode';
import axios from 'axios';

export class TogetherAIClient {
    private apiKey: string;
    private model: string;
    private baseURL = 'https://api.together.xyz/v1';

    constructor() {
        const config = vscode.workspace.getConfiguration('safeinsights-ai-companion');
        this.apiKey = config.get('apiKey') || '';
        this.model = config.get('model') || 'meta-llama/Llama-3-70b-chat-hf';
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