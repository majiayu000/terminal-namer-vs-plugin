import * as vscode from 'vscode';
import { AIProvider } from './base';
import { OpenAIProvider } from './openai';
import { ClaudeProvider } from './claude';
import { OllamaProvider } from './ollama';
import { OpenRouterProvider } from './openrouter';

export type ProviderType = 'openai' | 'claude' | 'ollama' | 'openrouter';

/**
 * 根据配置创建 AI Provider
 */
export function createProvider(): AIProvider {
  const config = vscode.workspace.getConfiguration('terminalAiNamer');
  const provider = config.get<ProviderType>('provider', 'openrouter');

  switch (provider) {
    case 'openai': {
      const apiKey = config.get<string>('openaiApiKey', '');
      if (!apiKey) {
        throw new Error('请先配置 OpenAI API Key');
      }
      return new OpenAIProvider(apiKey);
    }

    case 'claude': {
      const apiKey = config.get<string>('claudeApiKey', '');
      if (!apiKey) {
        throw new Error('请先配置 Claude API Key');
      }
      return new ClaudeProvider(apiKey);
    }

    case 'ollama': {
      const endpoint = config.get<string>('ollamaEndpoint', 'http://localhost:11434');
      const model = config.get<string>('ollamaModel', 'llama3.2');
      return new OllamaProvider(endpoint, model);
    }

    case 'openrouter': {
      const apiKey = config.get<string>('openrouterApiKey', '');
      if (!apiKey) {
        throw new Error('请先配置 OpenRouter API Key');
      }
      const model = config.get<string>('openrouterModel', 'google/gemini-2.5-flash');
      return new OpenRouterProvider(apiKey, model);
    }

    default:
      throw new Error(`不支持的 AI 提供商: ${provider}`);
  }
}

export { AIProvider } from './base';
