import * as vscode from 'vscode';

interface TerminalData {
  commands: string[];
  named: boolean;
}

/**
 * 终端命令追踪器
 */
export class TerminalTracker {
  private terminalDataMap = new Map<vscode.Terminal, TerminalData>();
  private disposables: vscode.Disposable[] = [];
  private onCommandThresholdReached: (terminal: vscode.Terminal, commands: string[]) => void;
  private commandThreshold: number;

  constructor(
    onCommandThresholdReached: (terminal: vscode.Terminal, commands: string[]) => void
  ) {
    this.onCommandThresholdReached = onCommandThresholdReached;
    this.commandThreshold = this.getCommandThreshold();

    this.init();
  }

  private getCommandThreshold(): number {
    const config = vscode.workspace.getConfiguration('terminalAiNamer');
    return config.get<number>('commandThreshold', 3);
  }

  private init() {
    // 监听终端创建
    this.disposables.push(
      vscode.window.onDidOpenTerminal((terminal) => {
        this.terminalDataMap.set(terminal, { commands: [], named: false });
      })
    );

    // 监听终端关闭
    this.disposables.push(
      vscode.window.onDidCloseTerminal((terminal) => {
        this.terminalDataMap.delete(terminal);
      })
    );

    // 尝试使用 Shell Integration API（VSCode 1.93+）
    // 如果不可用则静默失败，用户可以手动触发命名
    try {
      if (typeof vscode.window.onDidEndTerminalShellExecution === 'function') {
        this.disposables.push(
          vscode.window.onDidEndTerminalShellExecution((event) => {
            this.handleCommandExecution(event);
          })
        );
      }
    } catch {
      // Shell Integration API 不可用，忽略
      console.log('Terminal AI Namer: Shell Integration API 不可用，自动命名功能已禁用');
    }

    // 初始化已存在的终端
    vscode.window.terminals.forEach((terminal) => {
      if (!this.terminalDataMap.has(terminal)) {
        this.terminalDataMap.set(terminal, { commands: [], named: false });
      }
    });

    // 监听配置变化
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('terminalAiNamer.commandThreshold')) {
          this.commandThreshold = this.getCommandThreshold();
        }
      })
    );
  }

  private handleCommandExecution(event: vscode.TerminalShellExecutionEndEvent) {
    const terminal = event.terminal;
    const execution = event.execution;
    const commandLine = execution.commandLine;

    if (!commandLine || !commandLine.value) {
      return;
    }

    const command = commandLine.value.trim();
    if (!command) {
      return;
    }

    let data = this.terminalDataMap.get(terminal);
    if (!data) {
      data = { commands: [], named: false };
      this.terminalDataMap.set(terminal, data);
    }

    // 添加命令到历史
    data.commands.push(command);

    // 只保留最近的命令
    if (data.commands.length > 10) {
      data.commands = data.commands.slice(-10);
    }

    // 检查是否达到阈值且未命名
    const config = vscode.workspace.getConfiguration('terminalAiNamer');
    const autoRename = config.get<boolean>('autoRename', true);

    if (autoRename && !data.named && data.commands.length >= this.commandThreshold) {
      // 触发命名回调
      this.onCommandThresholdReached(terminal, data.commands.slice(0, this.commandThreshold));
      data.named = true;
    }
  }

  /**
   * 手动添加命令（用于不支持 Shell Integration 的情况）
   */
  addCommand(terminal: vscode.Terminal, command: string) {
    let data = this.terminalDataMap.get(terminal);
    if (!data) {
      data = { commands: [], named: false };
      this.terminalDataMap.set(terminal, data);
    }

    data.commands.push(command);

    if (data.commands.length > 10) {
      data.commands = data.commands.slice(-10);
    }
  }

  /**
   * 获取终端的命令历史
   */
  getCommands(terminal: vscode.Terminal): string[] {
    return this.terminalDataMap.get(terminal)?.commands || [];
  }

  /**
   * 重置终端的命名状态
   */
  resetNamed(terminal: vscode.Terminal) {
    const data = this.terminalDataMap.get(terminal);
    if (data) {
      data.named = false;
    }
  }

  /**
   * 标记终端为已命名
   */
  markAsNamed(terminal: vscode.Terminal) {
    const data = this.terminalDataMap.get(terminal);
    if (data) {
      data.named = true;
    }
  }

  dispose() {
    this.disposables.forEach((d) => d.dispose());
    this.terminalDataMap.clear();
  }
}
