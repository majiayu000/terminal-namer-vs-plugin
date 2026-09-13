import * as vscode from 'vscode';

interface TrackedCommand {
  value: string;
  /** Workspace folder URI when the command ran; undefined if CWD/folder was unknown. */
  folderUri?: string;
}

interface TerminalData {
  commands: TrackedCommand[];
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

  /**
   * Resolve the workspace-folder URI that owns a terminal CWD (credential scope).
   */
  private resolveFolderUri(
    terminal: vscode.Terminal,
    executionCwd?: vscode.Uri
  ): string | undefined {
    const cwd = executionCwd ?? this.getTerminalCwd(terminal);
    if (!cwd) {
      const folders = vscode.workspace.workspaceFolders;
      // Sole folder is unambiguous even without Shell Integration CWD.
      if (folders?.length === 1) {
        return folders[0].uri.toString();
      }
      return undefined;
    }
    return vscode.workspace.getWorkspaceFolder(cwd)?.uri.toString();
  }

  private getTerminalCwd(terminal: vscode.Terminal): vscode.Uri | undefined {
    try {
      return terminal.shellIntegration?.cwd;
    } catch {
      return undefined;
    }
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

    // Prefer execution cwd when available so folder scope matches the command.
    const executionCwd =
      'cwd' in execution && execution.cwd instanceof vscode.Uri
        ? execution.cwd
        : undefined;
    const folderUri = this.resolveFolderUri(terminal, executionCwd);

    // Drop history from other folders so auto-rename never mixes credential scopes.
    if (folderUri !== undefined) {
      const priorSameScope = data.commands.filter((c) => c.folderUri === folderUri);
      if (priorSameScope.length !== data.commands.length) {
        data.commands = priorSameScope;
        // Allow auto-rename again after crossing into a new folder.
        data.named = false;
      }
    }

    data.commands.push({ value: command, folderUri });

    // 只保留最近的命令
    if (data.commands.length > 10) {
      data.commands = data.commands.slice(-10);
    }

    // 检查是否达到阈值且未命名 — only same-folder commands count.
    const config = vscode.workspace.getConfiguration('terminalAiNamer');
    const autoRename = config.get<boolean>('autoRename', true);
    const scoped = this.getCommands(terminal, this.getTerminalCwd(terminal) ?? executionCwd);

    if (autoRename && !data.named && scoped.length >= this.commandThreshold) {
      this.onCommandThresholdReached(terminal, scoped.slice(0, this.commandThreshold));
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

    const folderUri = this.resolveFolderUri(terminal);
    if (folderUri !== undefined) {
      const priorSameScope = data.commands.filter((c) => c.folderUri === folderUri);
      if (priorSameScope.length !== data.commands.length) {
        data.commands = priorSameScope;
        data.named = false;
      }
    }

    data.commands.push({ value: command, folderUri });

    if (data.commands.length > 10) {
      data.commands = data.commands.slice(-10);
    }
  }

  /**
   * 获取终端的命令历史。
   * When `resource` is provided, only returns commands captured under the same
   * workspace folder (credential scope) so rename never sends folder-A history
   * through folder-B credentials.
   */
  getCommands(terminal: vscode.Terminal, resource?: vscode.Uri): string[] {
    const data = this.terminalDataMap.get(terminal);
    if (!data) {
      return [];
    }

    const targetFolder = resource
      ? vscode.workspace.getWorkspaceFolder(resource)?.uri.toString()
      : this.resolveFolderUri(terminal);

    if (targetFolder === undefined) {
      const folders = vscode.workspace.workspaceFolders;
      // Multi-root without a resolvable folder: never include folder-tagged
      // history (those belong to a specific credential scope).
      if (folders && folders.length > 1) {
        return data.commands.filter((c) => !c.folderUri).map((c) => c.value);
      }
      return data.commands.map((c) => c.value);
    }

    return data.commands
      .filter((c) => c.folderUri === targetFolder)
      .map((c) => c.value);
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
