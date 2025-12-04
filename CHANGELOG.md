# Changelog

All notable changes to this project will be documented in this file.

## [0.1.0] - 2024-12-04

### Added
- Initial release
- AI-powered terminal naming based on executed commands
- Support for multiple AI providers:
  - OpenRouter (recommended)
  - OpenAI
  - Claude (Anthropic)
  - Ollama (local)
- Sidebar panel with terminal list and quick settings
- Usage statistics tracking (tokens and costs)
- Status bar showing today's usage
- Auto-rename after configurable command threshold
- Manual rename commands
- Chinese and English naming support
- LiteLLM-compatible pricing for cost calculation

### Supported Models
- Google Gemini 2.0 Flash (default, recommended)
- Google Gemini 2.5 Pro
- Anthropic Claude 3 Haiku
- Anthropic Claude 3.5 Sonnet
- OpenAI GPT-4o Mini
- OpenAI GPT-4o
- Meta Llama 3.1 8B (via OpenRouter)
- Local models via Ollama
