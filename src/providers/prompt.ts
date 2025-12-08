/**
 * 构建 AI 提示词
 *
 * 设计原则：
 * 1. 名称必须包含目录名 - 方便区分不同路径的终端
 * 2. 格式：目录名-动作 或 目录名:动作
 * 3. 简洁有辨识度
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
    ? `为终端生成名称。格式必须是"目录-动作"(共3-6字)。只输出名称。

@blog: npm run dev → blog-开发
@api: docker up → api-容器
@ml: python train.py → ml-训练
@pay: kubectl logs → pay-日志
@admin: npm build → admin-构建
@src: go run → src-运行
@: ls, cd → 文件浏览
@: ssh prod → SSH生产`
    : `Generate terminal name. Format must be "dir-action"(3-6 words). Output name only.

@blog: npm run dev → blog-dev
@api: docker up → api-docker
@ml: python train.py → ml-train
@pay: kubectl logs → pay-logs
@admin: npm build → admin-build
@src: go run → src-run
@: ls, cd → files
@: ssh prod → ssh-prod`;

  // 用户消息格式: @目录名: 命令 →
  const cwdPart = cwd ? `@${cwd}` : '@';
  const userPrompt = `${cwdPart}: ${commandStr} →`;

  return { system: systemPrompt, user: userPrompt };
}

/**
 * 清理 AI 返回的名称，确保包含目录名
 */
export function cleanName(rawName: string, language: 'zh' | 'en', cwd?: string): string {
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

  // 移除引号
  name = name.replace(/^["'「」『』""]+|["'「」『』""]+$/g, '');

  // 只取第一行
  name = name.split('\n')[0].trim();

  // 只取第一个逗号/分号前的内容
  name = name.split(/[,;，；]/)[0].trim();

  // 移除编号前缀
  name = name.replace(/^\d+[\.、\)\-]\s*/, '');

  // 再次移除引号
  name = name.replace(/^["'「」『』""]+|["'「」『』""]+$/g, '');

  // 限制长度
  const maxLen = language === 'zh' ? 12 : 30;
  if (name.length > maxLen) {
    name = name.slice(0, maxLen);
  }

  // 如果有目录名但名称中没有，添加目录前缀
  if (cwd && name && !name.toLowerCase().includes(cwd.toLowerCase())) {
    const shortCwd = cwd.length > 8 ? cwd.slice(0, 8) : cwd;
    name = `${shortCwd}-${name}`;
  }

  // 默认名称
  if (!name || name.length < 1) {
    return cwd ? `${cwd}-终端` : (language === 'zh' ? '终端' : 'Terminal');
  }

  return name;
}
