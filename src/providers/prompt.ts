/**
 * 构建 AI 提示词
 *
 * 设计原则：
 * 1. 补全式格式 - 让模型自然补全，而非生成解释
 * 2. 命令组 → 单一名称 - 明确多命令生成一个名称
 * 3. 等号结尾 - 引导模型直接输出答案
 */
export interface PromptMessages {
  system: string;
  user: string;
}

export function buildPrompt(commands: string[], language: 'zh' | 'en'): PromptMessages {
  // 去重并限制命令数量
  const uniqueCommands = [...new Set(commands)].slice(0, 5);
  const commandStr = uniqueCommands.join(', ');

  const systemPrompt = language === 'zh'
    ? `终端命名(2-5字):
kubectl get pods = K8s监控
npm run dev = 前端开发
ls, cd, pwd = 文件浏览
docker compose up = Docker
claude = Claude
git status, git add = Git操作
python train.py = 模型训练
ssh root@server = SSH连接`
    : `Terminal naming (1-3 words):
kubectl get pods = K8s-Monitor
npm run dev = Frontend-Dev
ls, cd, pwd = Files
docker compose up = Docker
claude = Claude
git status, git add = Git-Ops
python train.py = ML-Training
ssh root@server = SSH`;

  // 用户消息以等号结尾，引导模型补全
  const userPrompt = `${commandStr} =`;

  return { system: systemPrompt, user: userPrompt };
}

/**
 * 清理 AI 返回的名称
 */
export function cleanName(rawName: string, language: 'zh' | 'en'): string {
  let name = rawName.trim();

  // 移除开头的等号（如果模型重复了）
  name = name.replace(/^[=\s]+/, '');

  // 移除引号
  name = name.replace(/^["'「」『』""]+|["'「」『』""]+$/g, '');

  // 只取第一行
  name = name.split('\n')[0].trim();

  // 只取第一个逗号/分号前的内容
  name = name.split(/[,;，；]/)[0].trim();

  // 移除解释性文字（如果有冒号，取冒号后的部分）
  if (name.includes(':') || name.includes('：')) {
    const parts = name.split(/[:：]/);
    if (parts.length > 1 && parts[1].trim().length > 0) {
      name = parts[parts.length - 1].trim();
    }
  }

  // 移除编号前缀
  name = name.replace(/^\d+[\.、\)\-]\s*/, '');

  // 移除常见前缀
  name = name.replace(/^(名称|name|建议|推荐|答案|output)[：:\s]*/i, '');

  // 再次移除引号
  name = name.replace(/^["'「」『』""]+|["'「」『』""]+$/g, '');

  // 如果还包含箭头，取箭头后的部分
  if (name.includes('→') || name.includes('->')) {
    const parts = name.split(/[→\->]+/);
    name = parts[parts.length - 1].trim();
  }

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
