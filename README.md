# Terminal AI Namer

智能终端命名工具 - 使用 AI 根据终端执行的命令自动生成有意义的终端名称。

[![VS Code Marketplace](https://img.shields.io/visual-studio-marketplace/v/zhuanz.terminal-ai-namer)](https://marketplace.visualstudio.com/items?itemName=zhuanz.terminal-ai-namer)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## 功能特性

- **智能命名**: 基于终端执行的命令，AI 自动生成简洁有意义的名称
- **多 AI 支持**: 支持 OpenRouter、OpenAI、Claude、Ollama 多种 AI 服务
- **使用统计**: 实时追踪 Token 用量和费用
- **侧边栏面板**: 快速查看和管理所有终端
- **自动/手动**: 可配置自动命名或手动触发

## 演示

执行命令后，终端自动获得有意义的名称：

| 命令 | 生成名称 |
|------|----------|
| `kubectl get pods` | K8s监控 |
| `npm run dev` | 前端开发 |
| `docker compose up` | Docker服务 |
| `ssh root@prod-server` | SSH生产 |
| `python train.py` | 模型训练 |

## 安装

1. 打开 VS Code
2. 按 `Ctrl+Shift+X` 打开扩展面板
3. 搜索 "Terminal AI Namer"
4. 点击安装

或通过命令行安装：

```bash
code --install-extension zhuanz.terminal-ai-namer
```

## 配置

### 1. 获取 API Key

推荐使用 [OpenRouter](https://openrouter.ai/keys)（支持多种模型，按量付费）。

也支持：
- [OpenAI](https://platform.openai.com/api-keys)
- [Claude](https://console.anthropic.com/account/keys)
- [Ollama](https://ollama.ai/)（本地免费）

### 2. 配置扩展

点击侧边栏的终端图标，在设置面板中输入 API Key。

或通过 VS Code 设置：

```json
{
  "terminalAiNamer.provider": "openrouter",
  "terminalAiNamer.openrouterApiKey": "your-api-key",
  "terminalAiNamer.openrouterModel": "google/gemini-2.5-flash",
  "terminalAiNamer.autoRename": true,
  "terminalAiNamer.commandThreshold": 3,
  "terminalAiNamer.language": "zh"
}
```

## 配置选项

| 选项 | 说明 | 默认值 |
|------|------|--------|
| `provider` | AI 服务提供商 | `openrouter` |
| `openrouterApiKey` | OpenRouter API Key | - |
| `openrouterModel` | OpenRouter 模型 | `google/gemini-2.5-flash` |
| `openaiApiKey` | OpenAI API Key | - |
| `claudeApiKey` | Claude API Key | - |
| `ollamaEndpoint` | Ollama 服务地址 | `http://localhost:11434` |
| `ollamaModel` | Ollama 模型名称 | `llama3.2` |
| `autoRename` | 自动命名终端 | `true` |
| `commandThreshold` | 触发命名的命令数 | `3` |
| `language` | 命名语言 (zh/en) | `zh` |

## 推荐模型

| 模型 | 特点 | 价格 |
|------|------|------|
| `google/gemini-2.5-flash` | 快速智能（推荐） | $0.30/1M tokens |
| `google/gemini-2.5-pro` | 最强 | $1.25/1M tokens |
| `google/gemini-2.0-flash-001` | 便宜 | $0.10/1M tokens |
| `anthropic/claude-3-haiku` | 快速稳定 | $0.25/1M tokens |
| `openai/gpt-4o-mini` | 性价比高 | $0.15/1M tokens |

## 使用方法

### 自动命名

1. 打开终端
2. 执行 3 条命令（可配置）
3. AI 自动生成名称

### 手动命名

- 命令面板: `Terminal AI Namer: 重命名当前终端`
- 侧边栏: 点击终端旁的 ✨ 图标

### 查看统计

- 状态栏显示今日 Token 用量和费用
- 侧边栏设置面板查看详细统计

## 命令

| 命令 | 说明 |
|------|------|
| `Terminal AI Namer: 重命名当前终端` | 重命名当前活动终端 |
| `Terminal AI Namer: 重命名所有终端` | 重命名所有有命令历史的终端 |
| `Terminal AI Namer: 打开设置` | 打开完整设置面板 |

## 要求

- VS Code 1.85.0 或更高版本
- 需要 AI 服务的 API Key（Ollama 本地运行除外）

## 隐私说明

- 仅发送终端命令到您配置的 AI 服务
- 不收集任何用户数据
- 所有配置存储在本地

## 问题反馈

如有问题或建议，请在 [GitHub Issues](https://github.com/majiayu000/terminal-namer-vs-plugin/issues) 提交。

## 许可证

[MIT](LICENSE)
