import * as vscode from 'vscode';
import { AIProvider } from './base';
import { OpenAIProvider } from './openai';
import { ClaudeProvider } from './claude';
import { OllamaProvider } from './ollama';
import { OpenRouterProvider } from './openrouter';
import { getApiKey } from '../secrets';

export type ProviderType = 'openai' | 'claude' | 'ollama' | 'openrouter';

/**
 * 根据配置创建 AI Provider（API Key 从 SecretStorage 读取）
 */
export async function createProvider(
  context: vscode.ExtensionContext
): Promise<AIProvider> {
  const config = vscode.workspace.getConfiguration('terminalAiNamer');
  const provider = config.get<ProviderType>('provider', 'openrouter');

  switch (provider) {
    case 'openai': {
      const apiKey = await getApiKey(context, 'openai');
      if (!apiKey) {
        throw new Error('请先配置 OpenAI API Key');
      }
      return new OpenAIProvider(apiKey);
    }

    case 'claude': {
      const apiKey = await getApiKey(context, 'claude');
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
      const apiKey = await getApiKey(context, 'openrouter');
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
