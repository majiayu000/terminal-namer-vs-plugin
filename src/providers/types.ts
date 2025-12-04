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
 * AI Provider 接口
 */
export interface AIProvider {
  /**
   * 根据命令列表生成终端名称
   * @param commands 最近执行的命令列表
   * @param language 输出语言
   * @returns 生成的终端名称和使用量信息
   */
  generateName(commands: string[], language: 'zh' | 'en'): Promise<GenerateResult>;
}
