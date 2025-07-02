import * as vscode from 'vscode';
import { ChatViewProvider } from './chatViewProvider';

export function activate(context: vscode.ExtensionContext) {
    console.log('SafeInsights AI Companion is now active!');

    // Create and register the webview provider
    const provider = new ChatViewProvider(context.extensionUri);
    
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            ChatViewProvider.viewType,
            provider
        )
    );

    // Register command to open chat
    context.subscriptions.push(
        vscode.commands.registerCommand('safeinsightsaicompanion.openChat', () => {
            provider.show();
        })
    );

    // Register command to apply code changes
    context.subscriptions.push(
        vscode.commands.registerCommand('safeinsightsaicompanion.applyCode', async (code: string, range?: vscode.Range) => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showErrorMessage('No active editor found');
                return;
            }

            await editor.edit(editBuilder => {
                if (range) {
                    editBuilder.replace(range, code);
                } else {
                    // Replace entire document if no range specified
                    const fullRange = new vscode.Range(
                        editor.document.positionAt(0),
                        editor.document.positionAt(editor.document.getText().length)
                    );
                    editBuilder.replace(fullRange, code);
                }
            });

            vscode.window.showInformationMessage('Code applied successfully!');
        })
    );
}

export function deactivate() {}