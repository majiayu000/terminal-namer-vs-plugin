/**
 * 构建 AI 提示词
 */
export interface PromptMessages {
  system: string;
  user: string;
}

export function buildPrompt(commands: string[], language: 'zh' | 'en'): PromptMessages {
  const systemPrompt = language === 'zh'
    ? `根据终端命令输出一个简短名称（2-5个字）。直接输出名称，禁止任何解释。

kubectl get pods → K8s监控
npm run dev → 前端开发
docker compose up → Docker
git pull → Git更新
ls → 文件浏览
claude → Claude
python app.py → Python`
    : `Output a short name (1-3 words) for terminal commands. Output ONLY the name, no explanation.

kubectl get pods → K8s-Monitor
npm run dev → Frontend-Dev
docker compose up → Docker
git pull → Git-Pull
ls → Files
claude → Claude
python app.py → Python`;

  const userPrompt = commands.join(', ');

  return { system: systemPrompt, user: userPrompt };
}

/**
 * 清理 AI 返回的名称
 */
export function cleanName(rawName: string, language: 'zh' | 'en'): string {
  let name = rawName.trim();

  // 尝试提取箭头后的名称 (如 "命令 → 名称")
  const arrowMatch = name.match(/[→\->]\s*["']?([^"'\n]+)["']?/);
  if (arrowMatch) {
    name = arrowMatch[1].trim();
  }

  // 移除引号
  name = name.replace(/^["'「」『』""]+|["'「」『』""]+$/g, '');

  // 如果包含多行，只取第一行
  name = name.split('\n')[0].trim();

  // 移除常见的解释性前缀
  name = name.replace(/^(名称[：:]\s*|name[：:]\s*|建议[：:]\s*|推荐[：:]\s*)/i, '');

  // 移除编号前缀如 "1. " 或 "1、"
  name = name.replace(/^\d+[\.、\)]\s*/, '');

  // 移除命令名前缀如 "claude → "
  name = name.replace(/^[\w\-]+\s*[→\->]\s*/, '');

  // 再次移除引号（清理后可能还有）
  name = name.replace(/^["'「」『』""]+|["'「」『』""]+$/g, '');

  // 限制长度
  if (language === 'zh') {
    if (name.length > 10) {
      name = name.slice(0, 10);
    }
  } else {
    if (name.length > 25) {
      name = name.slice(0, 25);
    }
  }

  return name || (language === 'zh' ? '终端' : 'Terminal');
}
