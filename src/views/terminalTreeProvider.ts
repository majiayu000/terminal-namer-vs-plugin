import * as vscode from 'vscode';
import { TerminalTracker } from '../core';

/**
 * 终端列表项
 */
export class TerminalItem extends vscode.TreeItem {
  constructor(
    public readonly terminal: vscode.Terminal,
    public readonly commands: string[],
    public readonly isActive: boolean
  ) {
    super(terminal.name, vscode.TreeItemCollapsibleState.None);

    this.description = commands.length > 0
      ? `(${commands.length} 条命令)`
      : '(无命令历史)';

    if (isActive) {
      this.iconPath = new vscode.ThemeIcon('terminal', new vscode.ThemeColor('terminal.ansiGreen'));
    } else {
      this.iconPath = new vscode.ThemeIcon('terminal');
    }

    if (commands.length > 0) {
      const md = new vscode.MarkdownString();
      md.appendMarkdown(`**最近命令：**\n\n`);
      commands.slice(-5).forEach((cmd, i) => {
        md.appendMarkdown(`${i + 1}. \`${cmd}\`\n\n`);
      });
      this.tooltip = md;
    } else {
      this.tooltip = '暂无命令历史';
    }

    this.contextValue = commands.length > 0 ? 'terminalWithCommands' : 'terminal';
  }
}

/**
 * 终端列表 TreeView Provider
 */
export class TerminalTreeProvider implements vscode.TreeDataProvider<TerminalItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<TerminalItem | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private tracker: TerminalTracker) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: TerminalItem): vscode.TreeItem {
    return element;
  }

  getChildren(): TerminalItem[] {
    const activeTerminal = vscode.window.activeTerminal;
    return vscode.window.terminals.map((terminal) => {
      const commands = this.tracker.getCommands(terminal);
      const isActive = terminal === activeTerminal;
      return new TerminalItem(terminal, commands, isActive);
    });
  }
}
