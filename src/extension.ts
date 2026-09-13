import * as vscode from 'vscode';
import { TerminalTracker, UsageTracker } from './core';
import { createProvider } from './providers';
import { TerminalTreeProvider, TerminalItem, SettingsSidebarProvider } from './views';

let tracker: TerminalTracker | undefined;
let terminalTreeProvider: TerminalTreeProvider | undefined;
let usageTracker: UsageTracker | undefined;
let settingsSidebarProvider: SettingsSidebarProvider | undefined;

/**
 * Serializes focus-dependent renameWithArg calls.
 * VS Code renames the *active* terminal, not a specific instance, so concurrent
 * renames (auto-rename + rename-all, or overlapping auto-renames) must not race.
 */
let renameMutex: Promise<void> = Promise.resolve();

const RENAME_FOCUS_MAX_ATTEMPTS = 3;
/** Max time to wait for onDidChangeActiveTerminal after terminal.show(). */
const RENAME_FOCUS_TIMEOUT_MS = 1500;

function withRenameLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = renameMutex.then(fn, fn);
  renameMutex = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

/**
 * Wait until `terminal` becomes the active terminal (or already is).
 * Uses onDidChangeActiveTerminal instead of fixed polling delays so remote /
 * overloaded hosts can still deliver focus after terminal.show().
 */
function waitForTerminalFocus(
  terminal: vscode.Terminal,
  timeoutMs: number
): Promise<boolean> {
  if (vscode.window.activeTerminal === terminal) {
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      disposable.dispose();
      resolve(ok);
    };

    const disposable = vscode.window.onDidChangeActiveTerminal((active) => {
      if (active === terminal) {
        finish(true);
      }
    });

    const timer = setTimeout(() => {
      finish(vscode.window.activeTerminal === terminal);
    }, timeoutMs);

    // Register the listener before show() so we do not miss a fast focus event.
    terminal.show();
  });
}

export function activate(context: vscode.ExtensionContext) {
  console.log('=== Terminal AI Namer 正在激活 ===');

  try {
    // 初始化使用量追踪器
    usageTracker = new UsageTracker(context);

    // 初始化终端追踪器
    tracker = new TerminalTracker(async (terminal, commands) => {
      const renamed = await renameTerminalWithAI(terminal, commands);
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
        let attemptedCount = 0;
        for (const terminal of terminals) {
          const commands = tracker?.getCommands(terminal) || [];
          if (commands.length > 0) {
            attemptedCount++;
            const renamed = await renameTerminalWithAI(terminal, commands);
            if (renamed) {
              renamedCount++;
            }
          }
        }

        if (attemptedCount === 0) {
          vscode.window.showWarningMessage('所有终端都没有命令历史');
        } else if (renamedCount === 0) {
          vscode.window.showWarningMessage('未能重命名任何终端（可能无法聚焦目标终端）');
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
 * One-shot renameWithArg under the rename mutex (does not re-acquire it).
 * Returns true only when `terminal.name` matches `name` after dispatch.
 */
async function dispatchRenameWithArg(
  terminal: vscode.Terminal,
  name: string
): Promise<boolean> {
  if (terminal.name === name) {
    return true;
  }

  const focused = await waitForTerminalFocus(terminal, RENAME_FOCUS_TIMEOUT_MS);
  if (!focused || vscode.window.activeTerminal !== terminal) {
    return false;
  }

  // Final pre-dispatch check — still best-effort under API limits.
  if (vscode.window.activeTerminal !== terminal) {
    return false;
  }

  await vscode.commands.executeCommand('workbench.action.terminal.renameWithArg', {
    name
  });
  return terminal.name === name;
}

/**
 * Restore a terminal title after a mid-dispatch focus steal renamed the wrong
 * instance. Must run under the rename mutex (does not re-acquire it).
 *
 * If focus drifts during this restore and a third terminal receives
 * `previousName`, undo that tertiary rename before returning failure so we
 * do not leave additional wrong titles behind.
 */
async function restoreTerminalName(
  terminal: vscode.Terminal,
  previousName: string
): Promise<boolean> {
  if (terminal.name === previousName) {
    return true;
  }

  const focused = await waitForTerminalFocus(terminal, RENAME_FOCUS_TIMEOUT_MS);
  if (!focused || vscode.window.activeTerminal !== terminal) {
    return false;
  }

  const nameByTerminal = new Map<vscode.Terminal, string>();
  for (const t of vscode.window.terminals) {
    nameByTerminal.set(t, t.name);
  }

  if (vscode.window.activeTerminal !== terminal) {
    return false;
  }

  await vscode.commands.executeCommand('workbench.action.terminal.renameWithArg', {
    name: previousName
  });

  if (terminal.name === previousName) {
    return true;
  }

  // Mid-restore focus steal: recover any tertiary terminal that now bears
  // previousName (one-shot, no nested retry) before reporting failure.
  for (const candidate of vscode.window.terminals) {
    if (candidate === terminal) {
      continue;
    }
    const prior = nameByTerminal.get(candidate);
    if (prior === undefined || prior === previousName) {
      continue;
    }
    if (candidate.name !== previousName) {
      continue;
    }
    const undone = await dispatchRenameWithArg(candidate, prior);
    if (!undone) {
      return false;
    }
  }

  // Primary restore still failed; caller must not retry the original rename.
  return false;
}

/**
 * If renameWithArg hit a different terminal because focus drifted across the
 * async dispatch boundary, put that collateral title back before retrying.
 * Returns false if any collateral restore fails — caller must abort rather
 * than retry and report success while wrong titles remain.
 */
async function restoreCollateralRenames(
  target: vscode.Terminal,
  intendedName: string,
  nameByTerminal: Map<vscode.Terminal, string>
): Promise<boolean> {
  for (const candidate of vscode.window.terminals) {
    if (candidate === target) {
      continue;
    }
    const previousName = nameByTerminal.get(candidate);
    if (previousName === undefined || previousName === intendedName) {
      continue;
    }
    if (candidate.name === intendedName) {
      const restored = await restoreTerminalName(candidate, previousName);
      if (!restored || candidate.name !== previousName) {
        return false;
      }
    }
  }
  return true;
}

/**
 * Focus the target terminal and rename via renameWithArg under the rename mutex.
 *
 * VS Code only exposes active-terminal rename (`renameWithArg`); there is no
 * public API that names a specific Terminal instance. Mitigations:
 * 1. Wait for onDidChangeActiveTerminal (not fixed polling).
 * 2. Re-check activeTerminal immediately before executeCommand.
 * 3. Verify terminal.name matches the requested name after the command.
 * 4. If focus drifted mid-dispatch, restore any collateral terminal that
 *    received the intended name, then retry.
 */
async function renameTerminalSafely(
  terminal: vscode.Terminal,
  name: string
): Promise<boolean> {
  return withRenameLock(async () => {
    // Already has the intended title — skip focus/dispatch entirely so an
    // idempotent retry cannot rename a collateral terminal mid-dispatch and
    // still observe terminal.name === name as "success".
    if (terminal.name === name) {
      return true;
    }

    for (let attempt = 1; attempt <= RENAME_FOCUS_MAX_ATTEMPTS; attempt++) {
      const focused = await waitForTerminalFocus(terminal, RENAME_FOCUS_TIMEOUT_MS);
      if (!focused || vscode.window.activeTerminal !== terminal) {
        continue;
      }

      // Snapshot titles so a mid-dispatch focus steal can be rolled back.
      const nameByTerminal = new Map<vscode.Terminal, string>();
      for (const t of vscode.window.terminals) {
        nameByTerminal.set(t, t.name);
      }

      // Re-check after snapshot: a concurrent rename may have set the title
      // while we waited for focus; still skip dispatch in that case.
      if (nameByTerminal.get(terminal) === name) {
        return true;
      }

      // Final pre-dispatch snapshot — still best-effort under API limits.
      if (vscode.window.activeTerminal !== terminal) {
        continue;
      }

      await vscode.commands.executeCommand('workbench.action.terminal.renameWithArg', {
        name
      });

      // Confirm this instance received the title. If another terminal stole
      // focus mid-dispatch, restore that collateral rename and retry only
      // when restoration fully succeeded.
      if (terminal.name === name) {
        return true;
      }

      const restored = await restoreCollateralRenames(terminal, name, nameByTerminal);
      if (!restored) {
        // Do not retry: a later successful rename of the target would hide
        // unrecovered collateral titles and report false success.
        return false;
      }
    }
    return false;
  });
}

/**
 * 使用 AI 重命名终端
 * @returns true when the terminal was renamed successfully
 */
async function renameTerminalWithAI(
  terminal: vscode.Terminal,
  commands: string[]
): Promise<boolean> {
  try {
    const config = vscode.workspace.getConfiguration('terminalAiNamer');
    const language = config.get<'zh' | 'en'>('language', 'zh');

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
        const result = await provider.generateName({ commands, language, cwd });

        // 记录使用量
        if (result.usage && usageTracker) {
          usageTracker.recordUsage(
            result.model,
            result.usage.promptTokens,
            result.usage.completionTokens
          );
        }

        // After AI generation: serialize rename + re-check focus before renameWithArg
        renamed = await renameTerminalSafely(terminal, result.name);
        if (!renamed) {
          // Do not resetNamed here: auto-rename already keys off the boolean
          // return value, and clearing named would erase a prior successful
          // manual/auto name after a failed focus-held rename attempt.
          vscode.window.showWarningMessage(
            `无法聚焦目标终端，已跳过命名（生成名称: ${result.name}）`
          );
          return;
        }

        // 标记为已命名
        tracker?.markAsNamed(terminal);

        // 刷新侧边栏
        terminalTreeProvider?.refresh();

        vscode.window.showInformationMessage(`终端已命名为: ${result.name}`);
      }
    );

    return renamed;
  } catch (error) {
    // Preserve prior named=true so a failed manual rename does not re-arm
    // auto-rename. Auto path already sets named from the returned boolean.
    const message = error instanceof Error ? error.message : '未知错误';
    vscode.window.showErrorMessage(`命名失败: ${message}`);
    return false;
  }
}

export function deactivate() {
  tracker?.dispose();
  console.log('=== Terminal AI Namer 已停用 ===');
}
