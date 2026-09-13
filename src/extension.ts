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
/**
 * How many renameWithArg dispatches (including nested collateral undoes) one
 * safe-rename attempt may perform. At depth 0 we refuse to dispatch so we never
 * issue an unprotected final rename that cannot roll back further collateral.
 */
const RENAME_COLLATERAL_UNDO_DEPTH = 4;

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
      const outcome = await renameTerminalWithAI(terminal, commands);
      terminalTreeProvider?.refresh();
      // Propagate tri-state so focus skips stay retryable while provider/
      // configuration failures suppress further auto-rename attempts.
      return outcome;
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
            const outcome = await renameTerminalWithAI(terminal, commands);
            if (outcome === 'renamed') {
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
 *
 * If focus drifts mid-dispatch and another terminal receives `name`, restore
 * that collateral title (bounded by `collateralDepth`) before returning false
 * so callers do not abandon wrongly renamed terminals.
 *
 * When `expectedCurrentName` is set (restore path), skip the dispatch if the
 * terminal no longer bears that title so we do not clobber a newer legitimate
 * name that appeared while waiting for focus.
 */
async function dispatchRenameWithArg(
  terminal: vscode.Terminal,
  name: string,
  collateralDepth = RENAME_COLLATERAL_UNDO_DEPTH,
  expectedCurrentName?: string
): Promise<boolean> {
  if (terminal.name === name) {
    return true;
  }

  // Depth boundary: do not issue an unprotected renameWithArg that cannot
  // roll back further mid-dispatch collateral. Callers treat this as failure.
  if (collateralDepth <= 0) {
    return false;
  }

  // Restore path: title already moved off the collateral value — nothing to undo.
  if (
    expectedCurrentName !== undefined &&
    terminal.name !== expectedCurrentName
  ) {
    return true;
  }

  const focused = await waitForTerminalFocus(terminal, RENAME_FOCUS_TIMEOUT_MS);
  if (!focused || vscode.window.activeTerminal !== terminal) {
    return false;
  }

  if (terminal.name === name) {
    return true;
  }

  // Recheck after focus wait: shell/user may have renamed away from the
  // collateral title; do not overwrite that newer legitimate name.
  if (
    expectedCurrentName !== undefined &&
    terminal.name !== expectedCurrentName
  ) {
    return true;
  }

  const nameByTerminal = new Map<vscode.Terminal, string>();
  for (const t of vscode.window.terminals) {
    nameByTerminal.set(t, t.name);
  }

  // Final pre-dispatch check — still best-effort under API limits.
  if (vscode.window.activeTerminal !== terminal) {
    return false;
  }

  if (
    expectedCurrentName !== undefined &&
    terminal.name !== expectedCurrentName
  ) {
    return true;
  }

  await vscode.commands.executeCommand('workbench.action.terminal.renameWithArg', {
    name
  });

  if (terminal.name === name) {
    return true;
  }

  // Mid-dispatch focus steal: roll back terminals that wrongly received `name`
  // (depth was > 0 so nested recovery still has budget, or refuses further
  // unprotected dispatches at depth 0 without skipping detection).
  for (const candidate of vscode.window.terminals) {
    if (candidate === terminal) {
      continue;
    }
    const prior = nameByTerminal.get(candidate);
    if (prior === undefined) {
      // Opened after the snapshot and now bears `name` — cannot safely restore.
      if (candidate.name === name) {
        return false;
      }
      continue;
    }
    if (prior === name) {
      // Already had the intended title before dispatch — not new collateral.
      continue;
    }
    if (candidate.name !== name) {
      continue;
    }
    const restored = await dispatchRenameWithArg(
      candidate,
      prior,
      collateralDepth - 1,
      name
    );
    if (!restored) {
      return false;
    }
    // Still bearing the dispatched name means nested undo did not clear it.
    if (candidate.name === name) {
      return false;
    }
  }

  // Target still lacks `name`. Either nested undo cleared collateral, or focus
  // landed on a terminal that already had `name` (no observable new collateral).
  // Retry the parent rename in both cases — requiring nested rollback would
  // abort restoration while the original terminal keeps the wrong title.
  if (terminal.name === name) {
    return true;
  }
  return dispatchRenameWithArg(
    terminal,
    name,
    collateralDepth - 1,
    expectedCurrentName
  );
}

/**
 * Restore a terminal title after a mid-dispatch focus steal renamed the wrong
 * instance. Must run under the rename mutex (does not re-acquire it).
 *
 * `expectedCollateralName` is the erroneous title observed when deciding to
 * restore. If the terminal no longer has that title (shell update / manual
 * rename), skip dispatch so we do not clobber a newer legitimate name.
 */
async function restoreTerminalName(
  terminal: vscode.Terminal,
  previousName: string,
  expectedCollateralName: string
): Promise<boolean> {
  if (terminal.name === previousName) {
    return true;
  }
  if (terminal.name !== expectedCollateralName) {
    return true;
  }
  return dispatchRenameWithArg(
    terminal,
    previousName,
    RENAME_COLLATERAL_UNDO_DEPTH,
    expectedCollateralName
  );
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
    if (previousName === undefined) {
      // Terminal opened after the title snapshot and received intendedName.
      // Missing prior title must not be treated as a successful no-op restore.
      if (candidate.name === intendedName) {
        return false;
      }
      continue;
    }
    if (previousName === intendedName) {
      continue;
    }
    if (candidate.name === intendedName) {
      const restored = await restoreTerminalName(
        candidate,
        previousName,
        intendedName
      );
      if (!restored) {
        return false;
      }
      // Still bearing the collateral title means restore did not take effect.
      // A different title (previousName or a newer legitimate name) is OK.
      if (candidate.name === intendedName) {
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

/** Outcome of an AI rename attempt for callers that need skip vs failure. */
type RenameOutcome = 'renamed' | 'skipped' | 'failed';

/**
 * 使用 AI 重命名终端
 * @returns `renamed` on success, `skipped` when focus/restore could not hold
 * (retryable for auto-rename), `failed` on provider/configuration errors
 * (should not re-arm auto-rename on every subsequent command).
 */
async function renameTerminalWithAI(
  terminal: vscode.Terminal,
  commands: string[]
): Promise<RenameOutcome> {
  try {
    const config = vscode.workspace.getConfiguration('terminalAiNamer');
    const language = config.get<'zh' | 'en'>('language', 'zh');

    const provider = createProvider();
    const cwd = getTerminalCwd(terminal);

    let outcome: RenameOutcome = 'skipped';

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
        const renamed = await renameTerminalSafely(terminal, result.name);
        if (!renamed) {
          // Do not resetNamed here: auto-rename already keys off the outcome,
          // and clearing named would erase a prior successful manual/auto name
          // after a failed focus-held rename attempt.
          vscode.window.showWarningMessage(
            `无法聚焦目标终端，已跳过命名（生成名称: ${result.name}）`
          );
          outcome = 'skipped';
          return;
        }

        // 标记为已命名
        tracker?.markAsNamed(terminal);

        // 刷新侧边栏
        terminalTreeProvider?.refresh();

        vscode.window.showInformationMessage(`终端已命名为: ${result.name}`);
        outcome = 'renamed';
      }
    );

    return outcome;
  } catch (error) {
    // Provider/config failures (bad API key, quota, unreachable endpoint) are
    // not focus skips — return `failed` so auto-rename does not re-arm on every
    // shell command. Preserve prior named=true for already-named terminals.
    const message = error instanceof Error ? error.message : '未知错误';
    vscode.window.showErrorMessage(`命名失败: ${message}`);
    return 'failed';
  }
}

export function deactivate() {
  tracker?.dispose();
  console.log('=== Terminal AI Namer 已停用 ===');
}
