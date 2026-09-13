import * as vscode from 'vscode';

/** Stable SecretStorage keys for API credentials. */
export const SECRET_KEYS = {
  openrouter: 'terminalAiNamer.openrouterApiKey',
  openai: 'terminalAiNamer.openaiApiKey',
  claude: 'terminalAiNamer.claudeApiKey',
} as const;

export type ApiKeyProvider = keyof typeof SECRET_KEYS;

/** Legacy plaintext configuration property names (migration only). */
const LEGACY_CONFIG_KEYS: Record<ApiKeyProvider, string> = {
  openrouter: 'openrouterApiKey',
  openai: 'openaiApiKey',
  claude: 'claudeApiKey',
};

const LEGACY_SCOPES: vscode.ConfigurationTarget[] = [
  vscode.ConfigurationTarget.Global,
  vscode.ConfigurationTarget.Workspace,
  vscode.ConfigurationTarget.WorkspaceFolder,
];

export async function getApiKey(
  context: vscode.ExtensionContext,
  provider: ApiKeyProvider
): Promise<string | undefined> {
  const value = await context.secrets.get(SECRET_KEYS[provider]);
  return value || undefined;
}

export async function setApiKey(
  context: vscode.ExtensionContext,
  provider: ApiKeyProvider,
  apiKey: string
): Promise<void> {
  await context.secrets.store(SECRET_KEYS[provider], apiKey);
}

export async function deleteApiKey(
  context: vscode.ExtensionContext,
  provider: ApiKeyProvider
): Promise<void> {
  await context.secrets.delete(SECRET_KEYS[provider]);
}

export async function hasApiKey(
  context: vscode.ExtensionContext,
  provider: ApiKeyProvider
): Promise<boolean> {
  const value = await getApiKey(context, provider);
  return Boolean(value);
}

function readScopedString(
  inspect: {
    globalValue?: string;
    workspaceValue?: string;
    workspaceFolderValue?: string;
  },
  target: vscode.ConfigurationTarget
): string | undefined {
  switch (target) {
    case vscode.ConfigurationTarget.Global:
      return inspect.globalValue;
    case vscode.ConfigurationTarget.Workspace:
      return inspect.workspaceValue;
    case vscode.ConfigurationTarget.WorkspaceFolder:
      return inspect.workspaceFolderValue;
    default:
      return undefined;
  }
}

/**
 * Clear a legacy plaintext API key from every configuration scope that still
 * holds a value (global, workspace, and workspace-folder).
 */
async function clearLegacyKeyAllScopes(
  config: vscode.WorkspaceConfiguration,
  configKey: string
): Promise<void> {
  const inspected = config.inspect<string>(configKey);
  if (!inspected) {
    return;
  }

  for (const target of LEGACY_SCOPES) {
    if (readScopedString(inspected, target) !== undefined) {
      await config.update(configKey, undefined, target);
    }
  }
}

/**
 * Effective VS Code configuration precedence for a setting value.
 * Prefer the most specific scope that still holds a non-empty string.
 */
function effectiveLegacyValue(
  inspected:
    | {
        globalValue?: string;
        workspaceValue?: string;
        workspaceFolderValue?: string;
      }
    | undefined,
  fallback: string
): string {
  const candidates = [
    inspected?.workspaceFolderValue,
    inspected?.workspaceValue,
    inspected?.globalValue,
  ];
  for (const value of candidates) {
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return fallback;
}

/**
 * Migrate leftover plaintext settings into SecretStorage, then clear them.
 *
 * Intentionally has no global one-shot flag: legacy keys may live in other
 * workspaces that were not open on the first activation, so every activation
 * (and config-change) continues to scan the currently visible scopes.
 */
export async function migrateApiKeysFromConfig(
  context: vscode.ExtensionContext
): Promise<void> {
  const config = vscode.workspace.getConfiguration('terminalAiNamer');

  for (const provider of Object.keys(LEGACY_CONFIG_KEYS) as ApiKeyProvider[]) {
    const configKey = LEGACY_CONFIG_KEYS[provider];
    // After removal from package.json contributes, prefer inspect() for leftover user values.
    const inspected = config.inspect<string>(configKey);
    const hasScopedLegacy =
      (typeof inspected?.globalValue === 'string' && inspected.globalValue.length > 0) ||
      (typeof inspected?.workspaceValue === 'string' && inspected.workspaceValue.length > 0) ||
      (typeof inspected?.workspaceFolderValue === 'string' &&
        inspected.workspaceFolderValue.length > 0);

    const fallback = config.get<string>(configKey, '') || '';
    const legacyValue = effectiveLegacyValue(inspected, fallback);

    if (!hasScopedLegacy && !legacyValue) {
      continue;
    }

    if (legacyValue) {
      const existing = await context.secrets.get(SECRET_KEYS[provider]);
      if (!existing) {
        await context.secrets.store(SECRET_KEYS[provider], legacyValue);
      }
    }

    await clearLegacyKeyAllScopes(config, configKey);
  }
}
