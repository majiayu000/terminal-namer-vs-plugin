/**
 * 构建 AI 提示词
 *
 * 设计原则：
 * 1. 提取具体信息 - 服务名、环境、目标等，而非泛泛分类
 * 2. AI 的价值在于理解上下文，不是关键词匹配
 * 3. 名称应该有辨识度，能区分不同终端
 */
export interface PromptMessages {
  system: string;
  user: string;
}

export function buildPrompt(commands: string[], language: 'zh' | 'en'): PromptMessages {
  // 去重并限制命令数量
  const uniqueCommands = [...new Set(commands)].slice(0, 5);
  const commandStr = uniqueCommands.join('\n');

  const systemPrompt = language === 'zh'
    ? `为终端生成简短名称(2-5字)。提取命令中的具体信息(服务名/环境/目标),不要泛泛分类。只输出名称。

kubectl get pods -n payment → 支付Pod
ssh deploy@staging-api → Staging部署
npm run dev:admin → Admin开发
docker logs nginx → Nginx日志
git clone repo/user-svc → 用户服务
python train.py --model=bert → Bert训练
curl api.stripe.com → Stripe接口
cd ~/blog && npm start → Blog启动
pytest test_auth.py → 认证测试
ls, pwd, cd → 文件浏览`
    : `Generate short terminal name(1-3 words). Extract specific info(service/env/target), not generic categories. Output name only.

kubectl get pods -n payment → Payment-Pods
ssh deploy@staging-api → Staging-Deploy
npm run dev:admin → Admin-Dev
docker logs nginx → Nginx-Logs
git clone repo/user-svc → User-Service
python train.py --model=bert → Bert-Training
curl api.stripe.com → Stripe-API
cd ~/blog && npm start → Blog-Start
pytest test_auth.py → Auth-Tests
ls, pwd, cd → Files`;

  const userPrompt = `${commandStr} →`;

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
