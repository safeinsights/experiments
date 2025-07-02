# Together AI / Ollama Code Assistant for VSCode

A VSCode extension that provides an interactive chat interface with LLMs to help modify and improve your code. Supports both local development with Ollama and production deployment with Together.ai.

## Features

- **Interactive Chat Interface**: Chat with powerful LLMs directly in VSCode
- **Dual Provider Support**: Use Ollama locally for free testing, Together.ai for production
- **Code Context Awareness**: Automatically includes your current file or selection as context
- **One-Click Code Application**: Apply suggested code changes with a single click
- **Multiple Model Support**: Configure which model to use for each provider
- **Syntax Highlighting**: Code suggestions are properly formatted and highlighted

## Setup Instructions

### 1. Install Dependencies

```bash
npm install
```

### 2. Choose Your Provider

#### Option A: Local Testing with Ollama (Free)

1. Install Ollama from [ollama.ai](https://ollama.ai)
2. Pull a model (e.g., Llama 3):
   ```bash
   ollama pull llama3
   ```
3. Make sure Ollama is running:
   ```bash
   ollama serve
   ```

#### Option B: Production with Together.ai

1. Sign up at [Together.ai](https://together.ai)
2. Navigate to your API keys section
3. Create a new API key

### 3. Configure the Extension

1. Open VSCode settings (Cmd/Ctrl + ,)
2. Search for "Together AI Assistant"
3. Configure based on your provider:

   **For Ollama (Local Testing):**
   - Provider: `ollama`
   - Model: `llama3` (or any model you've pulled)
   - Ollama URL: `http://localhost:11434` (default)

   **For Together.ai (Production):**
   - Provider: `together`
   - API Key: Your Together.ai API key
   - Model: `meta-llama/Llama-3-70b-chat-hf` (or another Together.ai model)

### 4. Build the Extension

```bash
npm run compile
```

### 5. Run in Development

1. Open this project in VSCode
2. Press `F5` to run the extension in a new Extension Development Host window
3. In the new window, open the Command Palette (Cmd/Ctrl + Shift + P)
4. Run "Open Together AI Chat"

## Usage

### Opening the Chat

- **Command Palette**: Run "Open Together AI Chat" 
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

## Available Models

### Ollama Models (Local)
- `llama3` - Meta's Llama 3 8B
- `codellama` - Specialized for code
- `mistral` - Mistral 7B
- `mixtral` - Mixtral 8x7B
- Any model from [Ollama's library](https://ollama.ai/library)

### Together.ai Models (Production)
- `meta-llama/Llama-3-70b-chat-hf` (recommended)
- `meta-llama/Llama-3-8b-chat-hf`
- `mistralai/Mixtral-8x7B-Instruct-v0.1`
- `NousResearch/Nous-Hermes-2-Mixtral-8x7B-DPO`
- Check Together.ai's documentation for the full list

## Project Structure

```
together-ai-code-assistant/
├── src/
│   ├── extension.ts          # Main extension entry point
│   ├── chatViewProvider.ts   # Webview provider for chat UI
│   └── llmClient.ts          # LLM client implementations
├── package.json              # Extension manifest
├── tsconfig.json            # TypeScript configuration
└── README.md               # This file
```

## Development Tips

### Switching Between Providers

You can quickly switch between Ollama and Together.ai in your settings:

```json
{
  // For local development
  "together-ai-assistant.provider": "ollama",
  "together-ai-assistant.model": "llama3",
  
  // For production
  "together-ai-assistant.provider": "together",
  "together-ai-assistant.model": "meta-llama/Llama-3-70b-chat-hf",
  "together-ai-assistant.apiKey": "your-api-key"
}
```

### Debugging

- Use VSCode's built-in debugger (F5) to run in development mode
- Check the Debug Console for error messages
- Enable Developer Tools in the Extension Development Host (Help > Toggle Developer Tools)

### Testing with Ollama

Test if Ollama is working correctly:

```bash
# Check if Ollama is running
curl http://localhost:11434/api/tags

# Test generation
curl http://localhost:11434/api/generate -d '{
  "model": "llama3",
  "prompt": "Hello!"
}'
```

## Publishing

To package the extension for distribution:

```bash
npm install -g vsce
vsce package
```

This creates a `.vsix` file that can be installed in VSCode.

## Troubleshooting

### Ollama Issues

#### "Cannot connect to Ollama"
- Make sure Ollama is running: `ollama serve`
- Check if it's accessible: `curl http://localhost:11434/api/tags`
- Verify the URL in settings matches your Ollama instance

#### "Model not found"
- Pull the model first: `ollama pull llama3`
- Check available models: `ollama list`
- Make sure the model name in settings matches exactly

### Together.ai Issues

#### "Invalid API Key"
- Verify your API key is correctly set in VSCode settings
- Check that your Together.ai account is active

### General Issues

#### No Response from AI
- Check your internet connection (for Together.ai)
- Verify the model name is correct
- Check the Output panel in VSCode for detailed error logs

#### Code Not Applying
- Ensure you have an active text editor open
- Check that the code block is properly formatted

## License

MIT