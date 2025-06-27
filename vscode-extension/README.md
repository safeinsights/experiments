# SafeInsights AI Companion for VSCode

A VSCode extension that provides an AI-powered code assistant for safe and insightful development.

## Features

- **Interactive Chat Interface**: Chat with AI directly in VSCode
- **Code Context Awareness**: Automatically includes your current file or selection as context
- **One-Click Code Application**: Apply suggested code changes with a single click
- **AI-Powered Assistance**: Intelligent code suggestions and improvements
- **Syntax Highlighting**: Code suggestions are properly formatted and highlighted

## Setup Instructions

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure API Key

1. Obtain your AI service API key
2. Configure the key in extension settings

### 3. Configure the Extension

1. Open VSCode settings (Cmd/Ctrl + ,)
2. Search for "SafeInsights AI Companion"
3. Enter your API key in the `API Key` field
4. Optionally, change the model configuration

### 4. Build the Extension

```bash
npm run compile
```

### 5. Run in Development

1. Open this project in VSCode
2. Press `F5` to run the extension in a new Extension Development Host window
3. In the new window, open the Command Palette (Cmd/Ctrl + Shift + P)
4. Run "Open SafeInsights AI Chat"

## Usage

### Opening the Chat

- **Command Palette**: Run "Open SafeInsights AI Chat" 
- **Activity Bar**: The chat panel will appear in the sidebar

### Interacting with the AI

1. **Ask Questions**: Type your question or request in the input field
2. **Include Code Context**: 
   - The extension automatically includes your current file as context
   - Select specific code to focus the AI's attention
   - Click "Get Selection" to add selected code to your message
3. **Apply Suggestions**: Click the "Apply Code" button on any code block to apply it to your active editor

### Example Prompts

- "Can you help me refactor this function to be more efficient?"
- "Add error handling to this code"
- "Convert this callback-based code to use async/await"
- "Write unit tests for the selected function"
- "Explain what this code does"

## AI Models

The extension supports various AI models for different use cases. Configure the model in the extension settings based on your needs.

## Project Structure

```
safeinsights-ai-companion/
├── src/
│   ├── extension.ts          # Main extension entry point
│   ├── chatViewProvider.ts   # Webview provider for chat UI
│   └── togetherAIClient.ts   # AI API client
├── package.json              # Extension manifest
├── tsconfig.json            # TypeScript configuration
└── README.md               # This file
```

## Development Tips

### Debugging

- Use VSCode's built-in debugger (F5) to run in development mode
- Check the Debug Console for error messages
- Enable Developer Tools in the Extension Development Host (Help > Toggle Developer Tools)

### Testing API Calls

You can test the AI API separately using the configured endpoint and model.

## Publishing

To package the extension for distribution:

```bash
npm install -g vsce
vsce package
```

This creates a `.vsix` file that can be installed in VSCode.

## Troubleshooting

### "Invalid API Key" Error
- Verify your API key is correctly set in VSCode settings
- Check that your AI service account is active

### No Response from AI
- Check your internet connection
- Verify the model name is correct
- Check the AI service status page for any issues

### Code Not Applying
- Ensure you have an active text editor open
- Check that the code block is properly formatted

## License

MIT