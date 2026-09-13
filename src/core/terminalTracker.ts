import * as vscode from 'vscode';

interface TerminalData {
  commands: string[];
  named: boolean;
  namingInProgress: boolean;
  /** Permanent provider/config failure — do not re-arm auto-rename per command. */
  autoRenameBlocked: boolean;
}

/** Auto-rename callback result: success, focus skip, or permanent failure. */
export type AutoRenameResult =
  | boolean
  | 'renamed'
  | 'skipped'
  | 'failed'
  | void;

/**
 * 终端命令追踪器
 */
export class TerminalTracker {
  private terminalDataMap = new Map<vscode.Terminal, TerminalData>();
  private disposables: vscode.Disposable[] = [];
  private onCommandThresholdReached: (
    terminal: vscode.Terminal,
    commands: string[]
  ) => AutoRenameResult | Promise<AutoRenameResult>;
  private commandThreshold: number;

  constructor(
    onCommandThresholdReached: (
      terminal: vscode.Terminal,
      commands: string[]
    ) => AutoRenameResult | Promise<AutoRenameResult>
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
        this.terminalDataMap.set(terminal, {
          commands: [],
          named: false,
          namingInProgress: false,
          autoRenameBlocked: false
        });
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
        this.terminalDataMap.set(terminal, {
          commands: [],
          named: false,
          namingInProgress: false,
          autoRenameBlocked: false
        });
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
      data = {
        commands: [],
        named: false,
        namingInProgress: false,
        autoRenameBlocked: false
      };
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

    if (
      autoRename &&
      !data.named &&
      !data.namingInProgress &&
      !data.autoRenameBlocked &&
      data.commands.length >= this.commandThreshold
    ) {
      // Hold a rename lock until the async callback reports success/failure.
      // Do not mark named=true before rename completes — a skipped rename must
      // remain eligible for a later auto-rename attempt.
      data.namingInProgress = true;
      const commandsSnapshot = data.commands.slice(0, this.commandThreshold);
      void Promise.resolve(this.onCommandThresholdReached(terminal, commandsSnapshot))
        .then((result) => {
          // Only promote to named on explicit success. On focus skip, leave
          // an already-true named flag intact so a concurrent successful manual
          // rename (markAsNamed) is not overwritten back to false.
          // Provider/config failures block further auto-rename retries.
          if (result === true || result === 'renamed') {
            data!.named = true;
          } else if (result === 'failed') {
            data!.autoRenameBlocked = true;
          }
        })
        .catch(() => {
          // Unexpected callback throw: treat like a permanent failure so we do
          // not spam provider attempts on every subsequent shell command.
          data!.autoRenameBlocked = true;
        })
        .finally(() => {
          data!.namingInProgress = false;
        });
    }
  }

  /**
   * 手动添加命令（用于不支持 Shell Integration 的情况）
   */
  addCommand(terminal: vscode.Terminal, command: string) {
    let data = this.terminalDataMap.get(terminal);
    if (!data) {
      data = {
        commands: [],
        named: false,
        namingInProgress: false,
        autoRenameBlocked: false
      };
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
      data.autoRenameBlocked = false;
    }
  }

  /**
   * 标记终端为已命名
   */
  markAsNamed(terminal: vscode.Terminal) {
    const data = this.terminalDataMap.get(terminal);
    if (data) {
      data.named = true;
      data.autoRenameBlocked = false;
    }
  }

  dispose() {
    this.disposables.forEach((d) => d.dispose());
    this.terminalDataMap.clear();
  }
}
