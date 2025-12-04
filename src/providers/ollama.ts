import { AIProvider, GenerateResult, buildPrompt } from './base';

export class OllamaProvider implements AIProvider {
  private endpoint: string;
  private model: string;

  constructor(endpoint: string, model: string) {
    this.endpoint = endpoint;
    this.model = model;
  }

  async generateName(commands: string[], language: 'zh' | 'en'): Promise<GenerateResult> {
    const prompt = buildPrompt(commands, language);

    const response = await fetch(`${this.endpoint}/api/generate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: this.model,
        prompt: prompt,
        stream: false,
        options: {
          num_predict: 50,
          temperature: 0.7
        }
      })
    });

    if (!response.ok) {
      throw new Error(`Ollama API error: ${response.status}`);
    }

    const data = await response.json() as {
      response: string;
      prompt_eval_count?: number;
      eval_count?: number;
    };

    const name = data.response?.trim() || '未命名终端';

    return {
      name,
      model: `ollama/${this.model}`,
      usage: (data.prompt_eval_count || data.eval_count) ? {
        promptTokens: data.prompt_eval_count || 0,
        completionTokens: data.eval_count || 0,
        totalTokens: (data.prompt_eval_count || 0) + (data.eval_count || 0)
      } : undefined
    };
  }
}
