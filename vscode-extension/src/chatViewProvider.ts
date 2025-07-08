import * as vscode from 'vscode';
import { LLMClient, LLMClientFactory } from './llmClients';
import { PROMPT_CONTEXT, getFileTypeContext } from './promptContext';

export class ChatViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'safeinsights-ai-companion.chatView';
    private _view?: vscode.WebviewView;
    private _client: LLMClient;

    constructor(private readonly _extensionUri: vscode.Uri) {
        const config = vscode.workspace.getConfiguration('safeinsights-ai-companion');
        this._client = LLMClientFactory.create(config);
        
        // Update client when configuration changes
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('safeinsights-ai-companion')) {
                const newConfig = vscode.workspace.getConfiguration('safeinsights-ai-companion');
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

        // Send initial context
        this._updateContext();

        // Listen for editor changes
        vscode.window.onDidChangeActiveTextEditor(() => {
            this._updateContext();
        });

        vscode.window.onDidChangeTextEditorSelection(() => {
            this._updateContext();
        });

        // Handle messages from the webview
        webviewView.webview.onDidReceiveMessage(async data => {
            console.log('Received message from webview:', data);
            switch (data.type) {
                case 'sendMessage':
                    console.log('Handling sendMessage:', data.message);
                    await this._handleUserMessage(data.message);
                    break;
                case 'applyCode':
                    vscode.commands.executeCommand('safeinsights-ai-companion.applyCode', data.code);
                    break;
                case 'applyCodeToFile':
                    await this._applyCodeToFile(data.code);
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
            // Build the complete message with predefined context
            let fullMessage = PROMPT_CONTEXT;
            
            // Get current editor context
            const editor = vscode.window.activeTextEditor;
            
            if (editor) {
                const fileName = editor.document.fileName.split('/').pop() || 'unknown';
                const selection = editor.selection;
                const language = editor.document.languageId;
                
                // Add language-specific context
                fullMessage += getFileTypeContext(language);
                
                // Add file context
                if (!selection.isEmpty) {
                    const selectedText = editor.document.getText(selection);
                    const lineStart = selection.start.line + 1;
                    const lineEnd = selection.end.line + 1;
                    fullMessage += `\n\nCurrent context: Working with ${fileName} (${language}), lines ${lineStart}-${lineEnd}:\n\`\`\`${language}\n${selectedText}\n\`\`\``;
                } else {
                    const fullText = editor.document.getText();
                    if (fullText.length > 2000) {
                        // Truncate large files
                        fullMessage += `\n\nCurrent context: Working with ${fileName} (${language}) - showing first 2000 characters:\n\`\`\`${language}\n${fullText.substring(0, 2000)}...\n\`\`\``;
                    } else {
                        fullMessage += `\n\nCurrent context: Working with ${fileName} (${language}):\n\`\`\`${language}\n${fullText}\n\`\`\``;
                    }
                }
            }
            
            // Add the user's message
            fullMessage += `\n\nUser request: ${message}`;

            // Send complete message to AI
            const response = await this._client.sendMessage(fullMessage);

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

    private _updateContext() {
        if (!this._view) return;

        const editor = vscode.window.activeTextEditor;
        if (editor) {
            const fileName = editor.document.fileName.split('/').pop() || 'Unknown file';
            const selection = editor.selection;
            
            this._view.webview.postMessage({
                type: 'updateContext',
                fileName: fileName,
                selection: selection.isEmpty ? null : {
                    start: selection.start.line,
                    end: selection.end.line
                }
            });
        } else {
            this._view.webview.postMessage({
                type: 'updateContext',
                fileName: null,
                selection: null
            });
        }
    }

    private async _applyCodeToFile(code: string) {
        if (!this._view) return;

        try {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showErrorMessage('No active editor found. Please open a file first.');
                return;
            }

            const selection = editor.selection;
            const edit = new vscode.WorkspaceEdit();
            
            if (selection.isEmpty) {
                // If no selection, insert at cursor position
                edit.insert(editor.document.uri, selection.start, code);
            } else {
                // Replace selected text
                edit.replace(editor.document.uri, selection, code);
            }

            const success = await vscode.workspace.applyEdit(edit);
            
            if (success) {
                // Move cursor to end of inserted code
                const lines = code.split('\n');
                const lastLineLength = lines[lines.length - 1].length;
                const newPosition = new vscode.Position(
                    selection.start.line + lines.length - 1,
                    lines.length === 1 ? selection.start.character + lastLineLength : lastLineLength
                );
                editor.selection = new vscode.Selection(newPosition, newPosition);
                
                vscode.window.showInformationMessage('Code inserted successfully!');
            } else {
                vscode.window.showErrorMessage('Failed to apply code changes.');
            }
            
        } catch (error) {
            vscode.window.showErrorMessage(`Error applying code: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }

    private _getHtmlForWebview(webview: vscode.Webview) {
        const logoUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'logo.png'));
        return [
            '<!DOCTYPE html>',
            '<html lang="en">',
            '<head>',
            '    <meta charset="UTF-8">',
            '    <meta name="viewport" content="width=device-width, initial-scale=1.0">',
            '    <title>SafeInsights AI Chat</title>',
            '    <style>',
            '        body { margin: 0; padding: 10px; font-family: Helvetica, Arial, sans-serif; font-size: var(--vscode-font-size); color: var(--vscode-foreground); background-color: var(--vscode-editor-background); }',
            '        #chat-container { display: flex; flex-direction: column; height: calc(100vh - 20px); }',
            '        #messages { flex: 1; overflow-y: auto; padding: 10px; border: 1px solid var(--vscode-panel-border); border-radius: 4px; margin-bottom: 10px; }',
            '        .message { margin-bottom: 15px; padding: 8px 12px; border-radius: 4px; }',
            '        .user-message { background-color: #00CCCC; color: #000000; margin-left: 20%; }',
            '        .ai-message { background-color: #00205B; color: #FFFFFF; margin-right: 20%; }',
            '        .error-message { background-color: var(--vscode-inputValidation-errorBackground); color: var(--vscode-inputValidation-errorForeground); }',
            '        #input-container { display: flex; gap: 5px; align-items: flex-end; }',
            '        #message-input { flex: 1; padding: 8px; background-color: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 4px; min-height: 20px; max-height: 120px; resize: vertical; font-family: inherit; font-size: inherit; }',
            '        button { background-color: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 8px 15px; border-radius: 4px; cursor: pointer; }',
            '        button:hover { background-color: var(--vscode-button-hoverBackground); }',
            '        .loading { text-align: center; color: var(--vscode-descriptionForeground); font-style: italic; }',
            '        .header { display: flex; align-items: center; padding: 10px 0; border-bottom: 1px solid var(--vscode-panel-border); margin-bottom: 10px; }',
            '        .header img { width: 24px; height: 24px; margin-right: 8px; }',
            '        .header h3 { margin: 0; font-size: 16px; color: var(--vscode-foreground); }',
            '        .context-display { background-color: var(--vscode-editor-inactiveSelectionBackground); border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 8px; margin-bottom: 10px; font-size: 12px; color: var(--vscode-descriptionForeground); display: none; }',
            '        .context-display.visible { display: block; }',
            '        .context-file { font-weight: bold; color: var(--vscode-foreground); }',
            '        .context-lines { margin-top: 4px; }',
            '        .code-block { background-color: #F8F8F8; border: 2px solid #E0E0E0; border-radius: 4px; margin: 10px 0; overflow: hidden; }',
            '        .code-header { display: flex; justify-content: space-between; align-items: center; padding: 8px 12px; background-color: #EEEEEE; border-bottom: 2px solid #E0E0E0; }',
            '        .code-lang { font-size: 12px; color: #333333; font-weight: bold; }',
            '        .code-block pre { margin: 0; padding: 12px; overflow-x: auto; background: #F8F8F8; color: #333333; }',
            '        .code-block code { font-family: "Consolas", "Monaco", "Courier New", monospace; font-size: 13px; color: #333333; line-height: 1.4; }',
            '        .apply-button { background-color: #0066CC; color: #FFFFFF; border: none; padding: 6px 12px; border-radius: 3px; cursor: pointer; font-size: 12px; font-weight: bold; }',
            '        .apply-button:hover { background-color: #0052A3; }',
            '        .apply-button:focus { outline: 2px solid #0066CC; outline-offset: 2px; }',
            '        .inline-code { background-color: #F0F0F0; color: #333333; padding: 2px 4px; border-radius: 2px; font-family: "Consolas", "Monaco", "Courier New", monospace; font-size: 0.9em; border: 1px solid #D0D0D0; }',
            '    </style>',
            '</head>',
            '<body>',
            '    <div id="chat-container">',
            '        <div class="header">',
            '            <img src="' + logoUri + '" alt="SafeInsights Logo" />',
            '            <h3>SafeInsights AI Chat</h3>',
            '        </div>',
            '        <div id="messages"></div>',
            '        <div id="loading" class="loading" style="display: none;">AI is thinking...</div>',
            '        <div id="context-display" class="context-display">',
            '            <div class="context-file" id="context-file"></div>',
            '            <div class="context-lines" id="context-lines"></div>',
            '        </div>',
            '        <div id="input-container">',
            '            <textarea id="message-input" placeholder="Ask about your code or request changes..." rows="1"></textarea>',
            '            <button onclick="sendMessage()">Send</button>',
            '            <button onclick="getSelectedCode()">Get Selection</button>',
            '        </div>',
            '    </div>',
            '    <script>',
            '        const vscode = acquireVsCodeApi();',
            '        const messagesContainer = document.getElementById("messages");',
            '        const messageInput = document.getElementById("message-input");',
            '        const loadingIndicator = document.getElementById("loading");',
            '        const contextDisplay = document.getElementById("context-display");',
            '        const contextFile = document.getElementById("context-file");',
            '        const contextLines = document.getElementById("context-lines");',
            '        function sendMessage() {',
            '            const message = messageInput.value.trim();',
            '            console.log("Send button clicked, message:", message);',
            '            if (message) {',
            '                vscode.postMessage({ type: "sendMessage", message: message });',
            '                messageInput.value = "";',
            '            } else {',
            '                console.log("No message to send");',
            '            }',
            '        }',
            '        function getSelectedCode() {',
            '            vscode.postMessage({ type: "getSelectedCode" });',
            '        }',
            '        function applyCode(code) {',
            '            vscode.postMessage({ type: "applyCode", code: code });',
            '        }',
            '        function applyCodeToFile(blockId) {',
            '            const code = codeBlocks[blockId];',
            '            if (code) {',
            '                vscode.postMessage({ type: "applyCodeToFile", code: code });',
            '            } else {',
            '                console.error("Code block not found:", blockId);',
            '            }',
            '        }',
            '        let codeBlockCounter = 0;',
            '        const codeBlocks = {};',
            '        function formatMessage(text) {',
            '            return text',
            '                .replace(/```([\\w]*)?\\n([\\s\\S]*?)```/g, function(match, lang, code) {',
            '                    const blockId = "code_block_" + (++codeBlockCounter);',
            '                    codeBlocks[blockId] = code;',
            '                    return "<div class=\\"code-block\\">" +',
            '                        "<div class=\\"code-header\\">" +',
            '                            "<span class=\\"code-lang\\">" + (lang || "code") + "</span>" +',
            '                            "<button class=\\"apply-button\\" onclick=\\"applyCodeToFile(\'" + blockId + "\')\\">" +',
            '                                "Insert at Cursor" +',
            '                            "</button>" +',
            '                        "</div>" +',
            '                        "<pre><code>" + code + "</code></pre>" +',
            '                    "</div>";',
            '                })',
            '                .replace(/`([^`]+)`/g, "<code class=\\"inline-code\\">$1</code>")',
            '                .replace(/\\n/g, "<br>");',
            '        }',
            '        function updateContext(fileName, selection) {',
            '            if (fileName) {',
            '                contextFile.textContent = fileName;',
            '                if (selection && selection.start !== selection.end) {',
            '                    contextLines.textContent = "Lines " + (selection.start + 1) + "-" + (selection.end + 1) + " selected";',
            '                } else if (selection && selection.start === selection.end) {',
            '                    contextLines.textContent = "Line " + (selection.start + 1);',
            '                } else {',
            '                    contextLines.textContent = "Entire file";',
            '                }',
            '                contextDisplay.classList.add("visible");',
            '            } else {',
            '                contextDisplay.classList.remove("visible");',
            '            }',
            '        }',
            '        function autoResize() {',
            '            messageInput.style.height = "auto";',
            '            messageInput.style.height = messageInput.scrollHeight + "px";',
            '        }',
            '        messageInput.addEventListener("input", autoResize);',
            '        messageInput.addEventListener("keypress", function(e) {',
            '            if (e.key === "Enter" && !e.shiftKey) {',
            '                e.preventDefault();',
            '                sendMessage();',
            '            }',
            '        });',
            '        window.addEventListener("message", function(event) {',
            '            const message = event.data;',
            '            switch (message.type) {',
            '                case "addMessage":',
            '                    const messageEl = document.createElement("div");',
            '                    messageEl.className = "message " + message.sender + "-message";',
            '                    messageEl.innerHTML = formatMessage(message.message);',
            '                    messagesContainer.appendChild(messageEl);',
            '                    messagesContainer.scrollTop = messagesContainer.scrollHeight;',
            '                    break;',
            '                case "showLoading":',
            '                    loadingIndicator.style.display = message.show ? "block" : "none";',
            '                    break;',
            '                case "selectedCode":',
            '                    messageInput.value = "Can you help me with this code: " + message.code;',
            '                    break;',
            '                case "updateContext":',
            '                    updateContext(message.fileName, message.selection);',
            '                    break;',
            '            }',
            '        });',
            '    </script>',
            '</body>',
            '</html>'
        ].join('\n');
    }
}