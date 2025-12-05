import { AIProvider, GenerateResult, buildPrompt, cleanName } from './base';

export class OpenAIProvider implements AIProvider {
  private apiKey: string;
  private baseURL?: string;
  private model = 'gpt-4o-mini';

  constructor(apiKey: string, baseURL?: string) {
    this.apiKey = apiKey;
    this.baseURL = baseURL;
  }

  async generateName(commands: string[], language: 'zh' | 'en'): Promise<GenerateResult> {
    const prompt = buildPrompt(commands, language);

    const response = await fetch(this.baseURL || 'https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: 'system', content: prompt.system },
          { role: 'user', content: prompt.user }
        ],
        max_tokens: 20,
        temperature: 0.3
      })
    });

    if (!response.ok) {
      throw new Error(`OpenAI API error: ${response.status}`);
    }

    const data = await response.json() as {
      choices: Array<{ message: { content: string } }>;
      usage?: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
      };
    };

    const rawName = data.choices[0]?.message?.content || '';
    const name = cleanName(rawName, language);

    return {
      name,
      model: this.model,
      usage: data.usage ? {
        promptTokens: data.usage.prompt_tokens,
        completionTokens: data.usage.completion_tokens,
        totalTokens: data.usage.total_tokens
      } : undefined
    };
  }
}
