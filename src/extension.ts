import * as vscode from 'vscode';
import { TerminalTracker, UsageTracker } from './core';
import { createProvider } from './providers';
import { TerminalTreeProvider, TerminalItem, SettingsSidebarProvider } from './views';

let tracker: TerminalTracker | undefined;
let terminalTreeProvider: TerminalTreeProvider | undefined;
let usageTracker: UsageTracker | undefined;
let settingsSidebarProvider: SettingsSidebarProvider | undefined;
let extensionContext: vscode.ExtensionContext | undefined;

/** globalState key: provider|endpoint fingerprint bound at consent time */
const CONSENT_DESTINATION_KEY = 'commandHistoryConsentDestination';

export function activate(context: vscode.ExtensionContext) {
  console.log('=== Terminal AI Namer 正在激活 ===');

  try {
    extensionContext = context;

    // 初始化使用量追踪器
    usageTracker = new UsageTracker(context);

    // 初始化终端追踪器
    tracker = new TerminalTracker(async (terminal, commands) => {
      const renamed = await renameTerminalWithAI(terminal, commands, { interactive: false });
      terminalTreeProvider?.refresh();
      return renamed;
    });

    // 初始化侧边栏 - 终端列表
    terminalTreeProvider = new TerminalTreeProvider(tracker);
    vscode.window.registerTreeDataProvider('terminalAiNamer.terminalList', terminalTreeProvider);

    // 初始化侧边栏 - 设置面板
    settingsSidebarProvider = new SettingsSidebarProvider(context.extensionUri, usageTracker);
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(
        SettingsSidebarProvider.viewType,
        settingsSidebarProvider
      )
    );

    // 设置统计更新回调
    usageTracker.setOnStatsUpdated(() => {
      settingsSidebarProvider?.updateStats();
    });

    // 监听终端变化，刷新侧边栏
    context.subscriptions.push(
      vscode.window.onDidOpenTerminal(() => terminalTreeProvider?.refresh()),
      vscode.window.onDidCloseTerminal(() => terminalTreeProvider?.refresh()),
      vscode.window.onDidChangeActiveTerminal(() => terminalTreeProvider?.refresh())
    );

    // 注册命令：打开设置面板（打开 VSCode 设置）
    const openSettingsCmd = vscode.commands.registerCommand(
      'terminalAiNamer.openSettings',
      () => {
        vscode.commands.executeCommand('workbench.action.openSettings', 'terminalAiNamer');
      }
    );

    // 注册命令：显示使用统计详情
    const showUsageCmd = vscode.commands.registerCommand(
      'terminalAiNamer.showUsageDetails',
      () => {
        if (usageTracker) {
          const stats = usageTracker.formatStatsMarkdown();
          vscode.window.showInformationMessage(
            `今日: ${usageTracker.getTodayStats().totalTokens} tokens, $${usageTracker.getTodayStats().totalCost.toFixed(6)}`,
            '查看详情'
          ).then(selection => {
            if (selection === '查看详情') {
              // 创建一个输出通道显示详细统计
              const channel = vscode.window.createOutputChannel('Terminal AI Namer 使用统计');
              channel.clear();
              channel.appendLine(stats);
              channel.show();
            }
          });
        }
      }
    );

    // 注册命令：重置统计
    const resetStatsCmd = vscode.commands.registerCommand(
      'terminalAiNamer.resetStats',
      async () => {
        const confirm = await vscode.window.showWarningMessage(
          '确定要重置所有使用统计吗？',
          '确定', '取消'
        );
        if (confirm === '确定') {
          usageTracker?.resetStats();
          vscode.window.showInformationMessage('统计已重置');
        }
      }
    );

    // 注册命令：刷新终端列表
    const refreshCmd = vscode.commands.registerCommand(
      'terminalAiNamer.refreshTerminalList',
      () => {
        terminalTreeProvider?.refresh();
      }
    );

    // 注册命令：重命名当前终端
    const renameCurrentCmd = vscode.commands.registerCommand(
      'terminalAiNamer.renameTerminal',
      async () => {
        const terminal = vscode.window.activeTerminal;
        if (!terminal) {
          vscode.window.showWarningMessage('没有活动的终端');
          return;
        }

        const commands = tracker?.getCommands(terminal) || [];
        if (commands.length === 0) {
          vscode.window.showWarningMessage('当前终端没有命令历史，请先执行一些命令');
          return;
        }

        await renameTerminalWithAI(terminal, commands);
      }
    );

    // 注册命令：重命名选中的终端（从侧边栏）
    const renameSelectedCmd = vscode.commands.registerCommand(
      'terminalAiNamer.renameSelectedTerminal',
      async (item: TerminalItem) => {
        if (!item || !item.terminal) {
          return;
        }

        const commands = tracker?.getCommands(item.terminal) || [];
        if (commands.length === 0) {
          vscode.window.showWarningMessage('该终端没有命令历史');
          return;
        }

        await renameTerminalWithAI(item.terminal, commands);
      }
    );

    // 注册命令：切换到指定终端
    const focusTerminalCmd = vscode.commands.registerCommand(
      'terminalAiNamer.focusTerminal',
      (item: TerminalItem) => {
        if (item && item.terminal) {
          item.terminal.show();
        }
      }
    );

    // 注册命令：重命名所有终端
    const renameAllCmd = vscode.commands.registerCommand(
      'terminalAiNamer.renameAllTerminals',
      async () => {
        const terminals = vscode.window.terminals;
        if (terminals.length === 0) {
          vscode.window.showWarningMessage('没有打开的终端');
          return;
        }

        let renamedCount = 0;
        let attempted = 0;
        for (const terminal of terminals) {
          const commands = tracker?.getCommands(terminal) || [];
          if (commands.length > 0) {
            attempted++;
            const renamed = await renameTerminalWithAI(terminal, commands);
            if (renamed) {
              renamedCount++;
            }
          }
        }

        if (attempted === 0) {
          vscode.window.showWarningMessage('所有终端都没有命令历史');
        } else if (renamedCount === 0) {
          vscode.window.showWarningMessage('没有终端被重命名（可能未同意发送命令历史）');
        } else {
          vscode.window.showInformationMessage(`已重命名 ${renamedCount} 个终端`);
        }

        terminalTreeProvider?.refresh();
      }
    );

    context.subscriptions.push(
      openSettingsCmd,
      showUsageCmd,
      resetStatsCmd,
      refreshCmd,
      renameCurrentCmd,
      renameSelectedCmd,
      focusTerminalCmd,
      renameAllCmd,
      { dispose: () => tracker?.dispose() }
    );

    console.log('=== Terminal AI Namer 激活成功 ===');
  } catch (error) {
    console.error('=== Terminal AI Namer 激活失败 ===', error);
    vscode.window.showErrorMessage(`Terminal AI Namer 激活失败: ${error}`);
  }
}

/**
 * 获取终端当前目录名（只是最后一级）
 */
function getTerminalCwd(terminal: vscode.Terminal): string | undefined {
  try {
    // VSCode 1.93+ Shell Integration API
    const cwd = terminal.shellIntegration?.cwd;
    if (cwd) {
      // 只取最后一级目录名
      const parts = cwd.fsPath.split(/[/\\]/);
      const dirName = parts[parts.length - 1];
      // 过滤掉用户目录名或无意义的名称
      if (dirName && !['~', 'home', 'Users', 'user'].includes(dirName)) {
        return dirName;
      }
    }
  } catch {
    // Shell Integration 不可用
  }
  return undefined;
}

/**
 * Effective upload destination fingerprint (provider + ollama endpoint when relevant).
 * Consent is bound to this so a workspace cannot silently redirect history after approval.
 */
function getHistoryDestinationFingerprint(): string {
  const config = vscode.workspace.getConfiguration('terminalAiNamer');
  const provider = config.get<string>('provider', 'openrouter');
  if (provider === 'ollama') {
    const endpoint = config.get<string>('ollamaEndpoint', 'http://localhost:11434');
    return `ollama|${endpoint}`;
  }
  return provider;
}

/**
 * Privacy mode must come from user/application settings only — workspace
 * cannot silently loosen argv0 → sanitized.
 */
function getUserPrivacyMode(): 'sanitized' | 'argv0' {
  const config = vscode.workspace.getConfiguration('terminalAiNamer');
  const inspected = config.inspect<'sanitized' | 'argv0'>('commandPrivacyMode');
  return inspected?.globalValue ?? inspected?.defaultValue ?? 'sanitized';
}

/**
 * Consent must come from user/application settings only — workspace
 * `.vscode/settings.json` must not be able to self-grant upload permission.
 * Consent is also bound to the provider/endpoint fingerprint recorded at grant time.
 */
function hasUserCommandHistoryConsent(): boolean {
  const config = vscode.workspace.getConfiguration('terminalAiNamer');
  const inspected = config.inspect<boolean>('allowSendCommandHistory');
  if (inspected?.globalValue !== true) {
    return false;
  }
  const consentedFor = extensionContext?.globalState.get<string>(CONSENT_DESTINATION_KEY);
  if (!consentedFor) {
    return false;
  }
  return consentedFor === getHistoryDestinationFingerprint();
}

async function bindCommandHistoryConsent(): Promise<void> {
  const config = vscode.workspace.getConfiguration('terminalAiNamer');
  await config.update('allowSendCommandHistory', true, vscode.ConfigurationTarget.Global);
  await extensionContext?.globalState.update(
    CONSENT_DESTINATION_KEY,
    getHistoryDestinationFingerprint()
  );
}

/**
 * Ensure the user has explicitly consented to sending command history to AI.
 * Returns false if rename should abort.
 */
async function ensureCommandHistoryConsent(interactive: boolean): Promise<boolean> {
  if (hasUserCommandHistoryConsent()) {
    return true;
  }

  // Auto-rename must not spam consent dialogs — refuse until the setting is enabled
  // (and bound to the current provider/endpoint).
  if (!interactive) {
    return false;
  }

  const config = vscode.workspace.getConfiguration('terminalAiNamer');
  const inspected = config.inspect<boolean>('allowSendCommandHistory');
  const destination = getHistoryDestinationFingerprint();
  const destinationChanged =
    inspected?.globalValue === true &&
    extensionContext?.globalState.get<string>(CONSENT_DESTINATION_KEY) !== destination;

  const message = destinationChanged
    ? `AI 提供商或端点已变更（当前: ${destination}）。需要重新同意后才会将（已脱敏的）命令历史发送到新目标。`
    : 'Terminal AI Namer 需要将（已脱敏的）命令历史发送到所选 AI 提供商才能生成名称。是否同意？未同意则不会上传命令历史。';

  const choice = await vscode.window.showWarningMessage(
    message,
    { modal: true },
    '同意并继续',
    '打开设置',
    '取消'
  );

  if (choice === '同意并继续') {
    await bindCommandHistoryConsent();
    return true;
  }

  if (choice === '打开设置') {
    await vscode.commands.executeCommand('workbench.action.openSettings', 'terminalAiNamer.allowSendCommandHistory');
  }

  return false;
}

/**
 * 使用 AI 重命名终端.
 * @returns true when the terminal was renamed successfully.
 */
async function renameTerminalWithAI(
  terminal: vscode.Terminal,
  commands: string[],
  options: { interactive?: boolean } = {}
): Promise<boolean> {
  try {
    const interactive = options.interactive !== false;
    const consented = await ensureCommandHistoryConsent(interactive);
    if (!consented) {
      if (interactive) {
        vscode.window.showInformationMessage('已取消：未同意发送命令历史，不会调用 AI 命名。');
      }
      return false;
    }

    const config = vscode.workspace.getConfiguration('terminalAiNamer');
    const language = config.get<'zh' | 'en'>('language', 'zh');
    const privacyMode = getUserPrivacyMode();

    const provider = createProvider();
    const cwd = getTerminalCwd(terminal);

    let renamed = false;
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: '正在生成终端名称...',
        cancellable: false
      },
      async () => {
        const result = await provider.generateName({ commands, language, cwd, privacyMode });

        // 记录使用量
        if (result.usage && usageTracker) {
          usageTracker.recordUsage(
            result.model,
            result.usage.promptTokens,
            result.usage.completionTokens
          );
        }

        // 先切换到目标终端
        terminal.show();

        // 使用 VSCode 内置命令重命名终端
        await vscode.commands.executeCommand('workbench.action.terminal.renameWithArg', {
          name: result.name
        });

        // 标记为已命名
        tracker?.markAsNamed(terminal);
        renamed = true;

        // 刷新侧边栏
        terminalTreeProvider?.refresh();

        vscode.window.showInformationMessage(`终端已命名为: ${result.name}`);
      }
    );
    return renamed;
  } catch (error) {
    const message = error instanceof Error ? error.message : '未知错误';
    vscode.window.showErrorMessage(`命名失败: ${message}`);
    return false;
  }
}

export function deactivate() {
  tracker?.dispose();
  console.log('=== Terminal AI Namer 已停用 ===');
}
