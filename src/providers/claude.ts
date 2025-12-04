import { AIProvider, GenerateResult, buildPrompt } from './base';

export class ClaudeProvider implements AIProvider {
  private apiKey: string;
  private model = 'claude-3-haiku-20240307';

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async generateName(commands: string[], language: 'zh' | 'en'): Promise<GenerateResult> {
    const prompt = buildPrompt(commands, language);

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 50,
        messages: [
          { role: 'user', content: prompt }
        ]
      })
    });

    if (!response.ok) {
      throw new Error(`Claude API error: ${response.status}`);
    }

    const data = await response.json() as {
      content: Array<{ text: string }>;
      usage?: {
        input_tokens: number;
        output_tokens: number;
      };
    };

    const name = data.content[0]?.text?.trim() || '未命名终端';

    return {
      name,
      model: this.model,
      usage: data.usage ? {
        promptTokens: data.usage.input_tokens,
        completionTokens: data.usage.output_tokens,
        totalTokens: data.usage.input_tokens + data.usage.output_tokens
      } : undefined
    };
  }
}
