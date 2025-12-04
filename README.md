# Terminal AI Namer

AI-powered terminal naming tool - automatically generate meaningful terminal names based on executed commands.

[![VS Code Marketplace](https://img.shields.io/visual-studio-marketplace/v/lif.terminal-ai-namer)](https://marketplace.visualstudio.com/items?itemName=lif.terminal-ai-namer)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## Features

- **Smart Naming**: AI automatically generates concise, meaningful names based on terminal commands
- **Multiple AI Providers**: Supports OpenRouter, OpenAI, Claude, and Ollama
- **Usage Statistics**: Real-time tracking of token usage and costs
- **Sidebar Panel**: Quickly view and manage all terminals
- **Auto/Manual Mode**: Configurable automatic naming or manual trigger

## Demo

After executing commands, terminals automatically get meaningful names:

| Command | Generated Name |
|---------|----------------|
| `kubectl get pods` | K8s-Monitor |
| `npm run dev` | Frontend-Dev |
| `docker compose up` | Docker-Service |
| `ssh root@prod-server` | SSH-Prod |
| `python train.py` | ML-Training |

## Installation

1. Open VS Code
2. Press `Ctrl+Shift+X` to open Extensions panel
3. Search for "Terminal AI Namer"
4. Click Install

Or install via command line:

```bash
code --install-extension lif.terminal-ai-namer
```

## Configuration

### 1. Get API Key

We recommend [OpenRouter](https://openrouter.ai/keys) (supports multiple models, pay-per-use).

Also supports:
- [OpenAI](https://platform.openai.com/api-keys)
- [Claude](https://console.anthropic.com/account/keys)
- [Ollama](https://ollama.ai/) (local, free)

### 2. Configure Extension

Click the terminal icon in the sidebar and enter your API Key in the settings panel.

Or configure via VS Code settings:

```json
{
  "terminalAiNamer.provider": "openrouter",
  "terminalAiNamer.openrouterApiKey": "your-api-key",
  "terminalAiNamer.openrouterModel": "google/gemini-2.5-flash",
  "terminalAiNamer.autoRename": true,
  "terminalAiNamer.commandThreshold": 3,
  "terminalAiNamer.language": "en"
}
```

## Configuration Options

| Option | Description | Default |
|--------|-------------|---------|
| `provider` | AI service provider | `openrouter` |
| `openrouterApiKey` | OpenRouter API Key | - |
| `openrouterModel` | OpenRouter model | `google/gemini-2.5-flash` |
| `openaiApiKey` | OpenAI API Key | - |
| `claudeApiKey` | Claude API Key | - |
| `ollamaEndpoint` | Ollama service URL | `http://localhost:11434` |
| `ollamaModel` | Ollama model name | `llama3.2` |
| `autoRename` | Auto rename terminals | `true` |
| `commandThreshold` | Commands before auto-rename | `3` |
| `language` | Naming language (zh/en) | `zh` |

## Recommended Models

| Model | Features | Price |
|-------|----------|-------|
| `google/gemini-2.5-flash` | Fast & smart (Recommended) | $0.30/1M tokens |
| `google/gemini-2.5-pro` | Most powerful | $1.25/1M tokens |
| `google/gemini-2.0-flash-001` | Budget-friendly | $0.10/1M tokens |
| `anthropic/claude-3-haiku` | Fast & stable | $0.25/1M tokens |
| `openai/gpt-4o-mini` | Cost-effective | $0.15/1M tokens |

## Usage

### Auto Naming

1. Open a terminal
2. Execute 3 commands (configurable)
3. AI automatically generates a name

### Manual Naming

- Command Palette: `Terminal AI Namer: Rename Current Terminal`
- Sidebar: Click the ✨ icon next to the terminal

### View Statistics

- Status bar shows today's token usage and cost
- Sidebar settings panel shows detailed statistics

## Commands

| Command | Description |
|---------|-------------|
| `Terminal AI Namer: Rename Current Terminal` | Rename the active terminal |
| `Terminal AI Namer: Rename All Terminals` | Rename all terminals with command history |
| `Terminal AI Namer: Open Settings` | Open full settings panel |

## Requirements

- VS Code 1.85.0 or higher
- API Key for AI service (except Ollama running locally)

## Privacy

- Only sends terminal commands to your configured AI service
- Does not collect any user data
- All settings stored locally

## Feedback

For issues or suggestions, please submit on [GitHub Issues](https://github.com/majiayu000/terminal-namer-vs-plugin/issues).

## License

[MIT](LICENSE)
