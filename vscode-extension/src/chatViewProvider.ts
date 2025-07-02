import * as vscode from 'vscode';
import { LLMClient, LLMClientFactory } from './llmClient';

export class ChatViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'together-ai-assistant.chatView';
    private _view?: vscode.WebviewView;
    private _client: LLMClient;

    constructor(private readonly _extensionUri: vscode.Uri) {
        const config = vscode.workspace.getConfiguration('together-ai-assistant');
        this._client = LLMClientFactory.create(config);
        
        // Update client when configuration changes
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('together-ai-assistant')) {
                const newConfig = vscode.workspace.getConfiguration('together-ai-assistant');
                this._client = LLMClientFactory.create(newConfig);
            }
        });
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        // Handle messages from the webview
        webviewView.webview.onDidReceiveMessage(async data => {
            switch (data.type) {
                case 'sendMessage':
                    await this._handleUserMessage(data.message);
                    break;
                case 'applyCode':
                    vscode.commands.executeCommand('together-ai-assistant.applyCode', data.code);
                    break;
                case 'getSelectedCode':
                    this._sendSelectedCode();
                    break;
            }
        });
    }

    public show() {
        if (this._view) {
            this._view.show?.(true);
        }
    }

    private async _handleUserMessage(message: string) {
        if (!this._view) return;

        // Add user message to chat
        this._view.webview.postMessage({
            type: 'addMessage',
            message: message,
            sender: 'user'
        });

        // Show loading indicator
        this._view.webview.postMessage({
            type: 'showLoading',
            show: true
        });

        try {
            // Get current editor context
            const editor = vscode.window.activeTextEditor;
            let context = '';
            
            if (editor) {
                const selection = editor.selection;
                if (!selection.isEmpty) {
                    context = `\nCurrent selection:\n\`\`\`${editor.document.languageId}\n${editor.document.getText(selection)}\n\`\`\``;
                } else {
                    context = `\nCurrent file (${editor.document.fileName}):\n\`\`\`${editor.document.languageId}\n${editor.document.getText()}\n\`\`\``;
                }
            }

            // Send message to Together AI
            const response = await this._client.sendMessage(message + context);

            // Add AI response to chat
            this._view.webview.postMessage({
                type: 'addMessage',
                message: response,
                sender: 'ai'
            });

        } catch (error) {
            this._view.webview.postMessage({
                type: 'addMessage',
                message: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
                sender: 'error'
            });
        } finally {
            this._view.webview.postMessage({
                type: 'showLoading',
                show: false
            });
        }
    }

    private _sendSelectedCode() {
        const editor = vscode.window.activeTextEditor;
        if (editor && !editor.selection.isEmpty) {
            const selectedText = editor.document.getText(editor.selection);
            this._view?.webview.postMessage({
                type: 'selectedCode',
                code: selectedText,
                language: editor.document.languageId
            });
        }
    }

    private _getHtmlForWebview(webview: vscode.Webview) {
        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Together AI Chat</title>
            <style>
                body {
                    margin: 0;
                    padding: 10px;
                    font-family: var(--vscode-font-family);
                    font-size: var(--vscode-font-size);
                    color: var(--vscode-foreground);
                    background-color: var(--vscode-editor-background);
                }
                #chat-container {
                    display: flex;
                    flex-direction: column;
                    height: calc(100vh - 20px);
                }
                #messages {
                    flex: 1;
                    overflow-y: auto;
                    padding: 10px;
                    border: 1px solid var(--vscode-panel-border);
                    border-radius: 4px;
                    margin-bottom: 10px;
                }
                .message {
                    margin-bottom: 15px;
                    padding: 8px 12px;
                    border-radius: 4px;
                }
                .user-message {
                    background-color: var(--vscode-button-background);
                    color: var(--vscode-button-foreground);
                    margin-left: 20%;
                }
                .ai-message {
                    background-color: var(--vscode-editor-inactiveSelectionBackground);
                    margin-right: 20%;
                }
                .error-message {
                    background-color: var(--vscode-inputValidation-errorBackground);
                    color: var(--vscode-inputValidation-errorForeground);
                }
                .code-block {
                    background-color: var(--vscode-textBlockQuote-background);
                    border: 1px solid var(--vscode-textBlockQuote-border);
                    border-radius: 4px;
                    padding: 10px;
                    margin: 10px 0;
                    position: relative;
                }
                .code-block pre {
                    margin: 0;
                    overflow-x: auto;
                }
                .apply-button {
                    position: absolute;
                    top: 5px;
                    right: 5px;
                    background-color: var(--vscode-button-background);
                    color: var(--vscode-button-foreground);
                    border: none;
                    padding: 4px 8px;
                    border-radius: 3px;
                    cursor: pointer;
                    font-size: 12px;
                }
                .apply-button:hover {
                    background-color: var(--vscode-button-hoverBackground);
                }
                #input-container {
                    display: flex;
                    gap: 5px;
                }
                #message-input {
                    flex: 1;
                    padding: 8px;
                    background-color: var(--vscode-input-background);
                    color: var(--vscode-input-foreground);
                    border: 1px solid var(--vscode-input-border);
                    border-radius: 4px;
                }
                button {
                    background-color: var(--vscode-button-background);
                    color: var(--vscode-button-foreground);
                    border: none;
                    padding: 8px 15px;
                    border-radius: 4px;
                    cursor: pointer;
                }
                button:hover {
                    background-color: var(--vscode-button-hoverBackground);
                }
                .loading {
                    text-align: center;
                    color: var(--vscode-descriptionForeground);
                    font-style: italic;
                }
            </style>
        </head>
        <body>
            <div id="chat-container">
                <div id="messages"></div>
                <div id="loading" class="loading" style="display: none;">AI is thinking...</div>
                <div id="input-container">
                    <input type="text" id="message-input" placeholder="Ask about your code or request changes..." />
                    <button onclick="sendMessage()">Send</button>
                    <button onclick="getSelectedCode()">Get Selection</button>
                </div>
            </div>

            <script>
                const vscode = acquireVsCodeApi();
                const messagesContainer = document.getElementById('messages');
                const messageInput = document.getElementById('message-input');
                const loadingIndicator = document.getElementById('loading');

                function sendMessage() {
                    const message = messageInput.value.trim();
                    if (message) {
                        vscode.postMessage({
                            type: 'sendMessage',
                            message: message
                        });
                        messageInput.value = '';
                    }
                }

                function getSelectedCode() {
                    vscode.postMessage({ type: 'getSelectedCode' });
                }

                function applyCode(code) {
                    vscode.postMessage({
                        type: 'applyCode',
                        code: code
                    });
                }

                function formatMessage(text) {
                    // Simple markdown-like formatting
                    return text
                        .replace(/\`\`\`(\w+)?\n([\s\S]*?)\`\`\`/g, (match, lang, code) => {
                            return \`<div class="code-block">
                                <button class="apply-button" onclick="applyCode(\\\`\${code.replace(/\`/g, '\\\\`').replace(/\$/g, '\\\\$')}\\\`)">Apply Code</button>
                                <pre><code>\${escapeHtml(code)}</code></pre>
                            </div>\`;
                        })
                        .replace(/\`([^\`]+)\`/g, '<code>$1</code>')
                        .replace(/\n/g, '<br>');
                }

                function escapeHtml(text) {
                    const div = document.createElement('div');
                    div.textContent = text;
                    return div.innerHTML;
                }

                messageInput.addEventListener('keypress', (e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        sendMessage();
                    }
                });

                window.addEventListener('message', event => {
                    const message = event.data;
                    switch (message.type) {
                        case 'addMessage':
                            const messageEl = document.createElement('div');
                            messageEl.className = \`message \${message.sender}-message\`;
                            messageEl.innerHTML = formatMessage(message.message);
                            messagesContainer.appendChild(messageEl);
                            messagesContainer.scrollTop = messagesContainer.scrollHeight;
                            break;
                        case 'showLoading':
                            loadingIndicator.style.display = message.show ? 'block' : 'none';
                            break;
                        case 'selectedCode':
                            messageInput.value = \`Can you help me with this \${message.language} code:\\n\\\`\\\`\\\`\${message.language}\\n\${message.code}\\n\\\`\\\`\\\`\`;
                            break;
                    }
                });
            </script>
        </body>
        </html>`;
    }
}