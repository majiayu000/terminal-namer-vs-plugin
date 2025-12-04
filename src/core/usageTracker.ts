import * as vscode from 'vscode';

/**
 * 模型价格表（每 token，美元）
 * 数据来源：https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json
 * 使用 LiteLLM 标准定价格式：input_cost_per_token, output_cost_per_token
 */
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  // OpenRouter - Gemini (via LiteLLM openrouter/ prefix)
  'google/gemini-2.0-flash-001': { input: 1e-7, output: 4e-7 },
  'google/gemini-2.5-pro-preview': { input: 1.25e-6, output: 1e-5 },
  'google/gemini-2.5-flash': { input: 3e-7, output: 1e-6 },
  'google/gemini-flash-1.5': { input: 7.5e-8, output: 3e-7 },
  'google/gemini-pro-1.5': { input: 2.5e-6, output: 7.5e-6 },

  // OpenRouter - Claude (via LiteLLM openrouter/ prefix)
  'anthropic/claude-3-haiku': { input: 2.5e-7, output: 1.25e-6 },
  'anthropic/claude-3.5-sonnet': { input: 3e-6, output: 1.5e-5 },
  'anthropic/claude-3-5-haiku': { input: 1e-6, output: 5e-6 },
  'anthropic/claude-3.7-sonnet': { input: 3e-6, output: 1.5e-5 },

  // OpenRouter - OpenAI (via LiteLLM openrouter/ prefix)
  'openai/gpt-4o-mini': { input: 1.5e-7, output: 6e-7 },
  'openai/gpt-4o': { input: 2.5e-6, output: 1e-5 },
  'openai/gpt-4.1': { input: 2e-6, output: 8e-6 },
  'openai/gpt-4.1-mini': { input: 4e-7, output: 1.6e-6 },
  'openai/gpt-4.1-nano': { input: 1e-7, output: 4e-7 },

  // Direct OpenAI API
  'gpt-4o-mini': { input: 1.5e-7, output: 6e-7 },
  'gpt-4o': { input: 2.5e-6, output: 1e-5 },

  // Direct Claude API
  'claude-3-haiku-20240307': { input: 2.5e-7, output: 1.25e-6 },
  'claude-3-5-sonnet-20241022': { input: 3e-6, output: 1.5e-5 },

  // Meta Llama (OpenRouter)
  'meta-llama/llama-3.1-8b-instruct': { input: 5.5e-8, output: 5.5e-8 },
  'meta-llama/llama-3.1-70b-instruct': { input: 3.5e-7, output: 4e-7 },
};

export interface UsageRecord {
  timestamp: number;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cost: number;
}

export interface UsageStats {
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
  totalCost: number;
  requestCount: number;
}

/**
 * 使用量追踪器
 */
export class UsageTracker {
  private records: UsageRecord[] = [];
  private statusBarItem: vscode.StatusBarItem;
  private context: vscode.ExtensionContext;
  private onStatsUpdated: (() => void) | undefined;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;

    // 从存储中恢复历史记录
    this.records = context.globalState.get<UsageRecord[]>('usageRecords', []);

    // 创建状态栏项
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100
    );
    this.statusBarItem.command = 'terminalAiNamer.showUsageDetails';
    this.statusBarItem.tooltip = '点击查看详细使用统计';

    this.updateStatusBar();
    this.statusBarItem.show();

    context.subscriptions.push(this.statusBarItem);
  }

  /**
   * 设置统计更新回调
   */
  setOnStatsUpdated(callback: () => void) {
    this.onStatsUpdated = callback;
  }

  /**
   * 记录一次 API 调用
   */
  recordUsage(model: string, promptTokens: number, completionTokens: number) {
    const cost = this.calculateCost(model, promptTokens, completionTokens);

    const record: UsageRecord = {
      timestamp: Date.now(),
      model,
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      cost
    };

    this.records.push(record);

    // 只保留最近 1000 条记录
    if (this.records.length > 1000) {
      this.records = this.records.slice(-1000);
    }

    // 保存到存储
    this.context.globalState.update('usageRecords', this.records);

    // 更新显示
    this.updateStatusBar();
    this.onStatsUpdated?.();
  }

  /**
   * 计算费用（使用 LiteLLM 标准：cost_per_token）
   */
  private calculateCost(model: string, promptTokens: number, completionTokens: number): number {
    // 默认使用 Gemini 2.0 Flash 的价格
    const defaultPricing = { input: 1e-7, output: 4e-7 };
    const pricing = MODEL_PRICING[model] || defaultPricing;

    // LiteLLM 格式：价格已经是每 token
    const inputCost = promptTokens * pricing.input;
    const outputCost = completionTokens * pricing.output;

    return inputCost + outputCost;
  }

  /**
   * 获取统计数据
   */
  getStats(): UsageStats {
    return this.records.reduce(
      (acc, record) => ({
        totalPromptTokens: acc.totalPromptTokens + record.promptTokens,
        totalCompletionTokens: acc.totalCompletionTokens + record.completionTokens,
        totalTokens: acc.totalTokens + record.totalTokens,
        totalCost: acc.totalCost + record.cost,
        requestCount: acc.requestCount + 1
      }),
      {
        totalPromptTokens: 0,
        totalCompletionTokens: 0,
        totalTokens: 0,
        totalCost: 0,
        requestCount: 0
      }
    );
  }

  /**
   * 获取今日统计
   */
  getTodayStats(): UsageStats {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayTimestamp = today.getTime();

    return this.records
      .filter(r => r.timestamp >= todayTimestamp)
      .reduce(
        (acc, record) => ({
          totalPromptTokens: acc.totalPromptTokens + record.promptTokens,
          totalCompletionTokens: acc.totalCompletionTokens + record.completionTokens,
          totalTokens: acc.totalTokens + record.totalTokens,
          totalCost: acc.totalCost + record.cost,
          requestCount: acc.requestCount + 1
        }),
        {
          totalPromptTokens: 0,
          totalCompletionTokens: 0,
          totalTokens: 0,
          totalCost: 0,
          requestCount: 0
        }
      );
  }

  /**
   * 更新状态栏显示
   */
  private updateStatusBar() {
    const stats = this.getTodayStats();

    if (stats.requestCount === 0) {
      this.statusBarItem.text = '$(terminal) AI Namer: $0.00';
    } else {
      const costStr = stats.totalCost < 0.01
        ? `$${(stats.totalCost * 100).toFixed(2)}¢`
        : `$${stats.totalCost.toFixed(4)}`;
      this.statusBarItem.text = `$(terminal) ${stats.totalTokens} tokens | ${costStr}`;
    }
  }

  /**
   * 重置统计
   */
  resetStats() {
    this.records = [];
    this.context.globalState.update('usageRecords', []);
    this.updateStatusBar();
    this.onStatsUpdated?.();
  }

  /**
   * 格式化统计信息为 Markdown
   */
  formatStatsMarkdown(): string {
    const today = this.getTodayStats();
    const total = this.getStats();

    return `## 使用统计

### 今日
- 请求次数: ${today.requestCount}
- 输入 Tokens: ${today.totalPromptTokens.toLocaleString()}
- 输出 Tokens: ${today.totalCompletionTokens.toLocaleString()}
- 总 Tokens: ${today.totalTokens.toLocaleString()}
- 费用: $${today.totalCost.toFixed(6)}

### 累计
- 请求次数: ${total.requestCount}
- 总 Tokens: ${total.totalTokens.toLocaleString()}
- 总费用: $${total.totalCost.toFixed(6)}`;
  }
}
