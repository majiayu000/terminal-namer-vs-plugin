/**
 * AI 生成结果
 */
export interface GenerateResult {
  name: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  model: string;
}

/**
 * 生成名称的上下文
 */
export interface GenerateContext {
  commands: string[];
  language: 'zh' | 'en';
  cwd?: string;  // 当前目录名（只是最后一级）
}

/**
 * AI Provider 接口
 */
export interface AIProvider {
  /**
   * 根据命令列表生成终端名称
   * @param context 包含命令、语言、目录的上下文
   * @returns 生成的终端名称和使用量信息
   */
  generateName(context: GenerateContext): Promise<GenerateResult>;
}
