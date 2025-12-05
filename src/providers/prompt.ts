/**
 * 构建 AI 提示词
 */
export interface PromptMessages {
  system: string;
  user: string;
}

export function buildPrompt(commands: string[], language: 'zh' | 'en'): PromptMessages {
  const systemPrompt = language === 'zh'
    ? `你是终端命名助手。根据终端命令生成简短名称。

规则：
- 只输出名称，不要任何解释
- 2-5个中文字符
- 提取命令核心意图

示例：
kubectl get pods → K8s监控
npm run dev → 前端开发
docker compose up → Docker服务
git pull → Git拉取
ls / cd / pwd → 文件浏览
python app.py → Python服务
ssh root@server → SSH连接`
    : `You are a terminal naming assistant. Generate short names based on commands.

Rules:
- Output ONLY the name, nothing else
- 1-3 words with hyphens
- Extract core intent

Examples:
kubectl get pods → K8s-Monitor
npm run dev → Frontend-Dev
docker compose up → Docker
git pull → Git-Pull
ls / cd / pwd → Files
python app.py → Python-App
ssh root@server → SSH`;

  const userPrompt = commands.join(', ');

  return { system: systemPrompt, user: userPrompt };
}

/**
 * 清理 AI 返回的名称
 */
export function cleanName(rawName: string, language: 'zh' | 'en'): string {
  let name = rawName.trim();

  // 移除引号
  name = name.replace(/^["'「」『』]+|["'「」『』]+$/g, '');

  // 如果包含多行，只取第一行
  name = name.split('\n')[0].trim();

  // 移除常见的前缀解释
  name = name.replace(/^(名称[：:]\s*|name[：:]\s*)/i, '');

  // 移除编号前缀如 "1. "
  name = name.replace(/^\d+\.\s*/, '');

  // 限制长度
  if (language === 'zh') {
    // 中文最多10个字符
    if (name.length > 10) {
      name = name.slice(0, 10);
    }
  } else {
    // 英文最多25个字符
    if (name.length > 25) {
      name = name.slice(0, 25);
    }
  }

  return name || (language === 'zh' ? '终端' : 'Terminal');
}
