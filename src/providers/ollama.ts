import { AIProvider, GenerateResult, GenerateContext, buildPrompt, cleanName } from './base';

export class OllamaProvider implements AIProvider {
  private endpoint: string;
  private model: string;

  constructor(endpoint: string, model: string) {
    this.endpoint = endpoint;
    this.model = model;
  }

  async generateName(context: GenerateContext): Promise<GenerateResult> {
    const { commands, language, cwd, privacyMode } = context;
    const prompt = buildPrompt({ commands, language, cwd, privacyMode });

    const response = await fetch(`${this.endpoint}/api/generate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: this.model,
        system: prompt.system,
        prompt: prompt.user,
        stream: false,
        options: {
          num_predict: 15,
          temperature: 0.1
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

    const rawName = data.response || '';
    const name = cleanName(rawName, language, cwd);

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
