/**
 * 构建 AI 提示词
 *
 * 设计原则：
 * 1. 融合目录名 - 目录名是重要上下文，AI 应智能融入命名
 * 2. 提取具体信息 - 服务名、环境、目标等，而非泛泛分类
 * 3. 简洁有辨识度 - 能区分不同终端
 */
export interface PromptMessages {
  system: string;
  user: string;
}

export interface PromptContext {
  commands: string[];
  cwd?: string;  // 当前目录名（只是最后一级，如 "blog"）
  language: 'zh' | 'en';
}

export function buildPrompt(context: PromptContext): PromptMessages {
  const { commands, cwd, language } = context;

  // 去重并限制命令数量
  const uniqueCommands = [...new Set(commands)].slice(0, 5);
  const commandStr = uniqueCommands.join(', ');

  const systemPrompt = language === 'zh'
    ? `为终端生成简短名称(2-5字)。结合目录名和命令,提取具体信息。只输出名称。

@blog: npm run dev → Blog开发
@api-service: docker up → API容器
@ml-project: python train.py → ML训练
@payment: kubectl logs → 支付日志
@admin: npm run build → Admin构建
@backend: go run main.go → 后端服务
@: ls, cd → 文件浏览
@: ssh root@prod → SSH生产`
    : `Generate short terminal name(2-4 words). Combine directory and commands. Output name only.

@blog: npm run dev → Blog-Dev
@api-service: docker up → API-Docker
@ml-project: python train.py → ML-Training
@payment: kubectl logs → Payment-Logs
@admin: npm run build → Admin-Build
@backend: go run main.go → Backend-Server
@: ls, cd → Files
@: ssh root@prod → SSH-Prod`;

  // 用户消息格式: @目录名: 命令 →
  const cwdPart = cwd ? `@${cwd}` : '@';
  const userPrompt = `${cwdPart}: ${commandStr} →`;

  return { system: systemPrompt, user: userPrompt };
}

/**
 * 清理 AI 返回的名称
 */
export function cleanName(rawName: string, language: 'zh' | 'en'): string {
  let name = rawName.trim();

  // 移除 markdown 格式
  name = name.replace(/\*\*/g, '');
  name = name.replace(/\*/g, '');
  name = name.replace(/`/g, '');

  // 如果包含箭头，取箭头后的部分
  if (name.includes('→') || name.includes('->')) {
    const parts = name.split(/[→]|->/).filter(Boolean);
    name = parts[parts.length - 1].trim();
  }

  // 如果包含等号，取等号后的部分
  if (name.includes('=')) {
    const parts = name.split('=');
    name = parts[parts.length - 1].trim();
  }

  // 移除引号
  name = name.replace(/^["'「」『』""]+|["'「」『』""]+$/g, '');

  // 只取第一行
  name = name.split('\n')[0].trim();

  // 只取第一个逗号/分号前的内容
  name = name.split(/[,;，；]/)[0].trim();

  // 移除编号前缀
  name = name.replace(/^\d+[\.、\)\-]\s*/, '');

  // 移除常见前缀
  name = name.replace(/^(名称|name|建议|推荐|答案|output)[：:\s]*/i, '');

  // 再次移除引号
  name = name.replace(/^["'「」『』""]+|["'「」『』""]+$/g, '');

  // 移除括号及其内容（如果名称主体在括号外）
  const withoutParens = name.replace(/[（(][^）)]*[）)]/g, '').trim();
  if (withoutParens.length >= 2) {
    name = withoutParens;
  }

  // 限制长度
  const maxLen = language === 'zh' ? 10 : 25;
  if (name.length > maxLen) {
    name = name.slice(0, maxLen);
  }

  // 默认名称
  if (!name || name.length < 1) {
    return language === 'zh' ? '终端' : 'Terminal';
  }

  return name;
}

// 兼容旧接口
export function buildPromptLegacy(commands: string[], language: 'zh' | 'en'): PromptMessages {
  return buildPrompt({ commands, language });
}
