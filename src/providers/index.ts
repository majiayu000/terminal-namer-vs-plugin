import * as vscode from 'vscode';
import { AIProvider } from './base';
import { OpenAIProvider } from './openai';
import { ClaudeProvider } from './claude';
import { OllamaProvider } from './ollama';
import { OpenRouterProvider } from './openrouter';
import { getApiKey } from '../secrets/apiKeys';

export type ProviderType = 'openai' | 'claude' | 'ollama' | 'openrouter';

/**
 * 根据配置创建 AI Provider（API Key 来自 SecretStorage）
 * @param resource Optional URI (e.g. terminal cwd) to resolve folder-scoped keys.
 */
export async function createProvider(
  secrets: vscode.SecretStorage,
  resource?: vscode.Uri
): Promise<AIProvider> {
  const config = vscode.workspace.getConfiguration('terminalAiNamer');
  const provider = config.get<ProviderType>('provider', 'openrouter');

  switch (provider) {
    case 'openai': {
      const apiKey = await getApiKey(secrets, 'openai', resource);
      if (!apiKey) {
        throw new Error(
          '请先在侧边栏「快捷设置」中配置 OpenAI API Key（SecretStorage）'
        );
      }
      return new OpenAIProvider(apiKey);
    }

    case 'claude': {
      const apiKey = await getApiKey(secrets, 'claude', resource);
      if (!apiKey) {
        throw new Error(
          '请先在侧边栏「快捷设置」中配置 Claude API Key（SecretStorage）'
        );
      }
      return new ClaudeProvider(apiKey);
    }

    case 'ollama': {
      const endpoint = config.get<string>('ollamaEndpoint', 'http://localhost:11434');
      const model = config.get<string>('ollamaModel', 'llama3.2');
      return new OllamaProvider(endpoint, model);
    }

    case 'openrouter': {
      const apiKey = await getApiKey(secrets, 'openrouter', resource);
      if (!apiKey) {
        throw new Error(
          '请先在侧边栏「快捷设置」中配置 OpenRouter API Key（SecretStorage）'
        );
      }
      const model = config.get<string>('openrouterModel', 'google/gemini-2.5-flash');
      return new OpenRouterProvider(apiKey, model);
    }

    default:
      throw new Error(`不支持的 AI 提供商: ${provider}`);
  }
}

export { AIProvider } from './base';
