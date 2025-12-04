/**
 * 构建 AI 提示词
 */
export function buildPrompt(commands: string[], language: 'zh' | 'en'): string {
  const examples = language === 'zh'
    ? `示例：
- kubectl get pods → "K8s监控"
- npm run dev → "前端开发"
- docker compose up → "Docker服务"
- git pull && npm install → "项目更新"
- ssh root@prod-server → "SSH生产"
- python train.py → "模型训练"
- go build && ./app → "Go服务"`
    : `Examples:
- kubectl get pods → "K8s-Monitor"
- npm run dev → "Frontend-Dev"
- docker compose up → "Docker"
- git pull && npm install → "Project-Update"
- ssh root@prod-server → "SSH-Prod"
- python train.py → "ML-Training"
- go build && ./app → "Go-Service"`;

  const langInstruction = language === 'zh'
    ? '用2-6个中文字符命名'
    : 'Use 2-4 English words';

  return `根据终端命令生成简短名称。${langInstruction}。

${examples}

命令：
${commands.map(cmd => `- ${cmd}`).join('\n')}

名称：`;
}
