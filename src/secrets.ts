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

const MIGRATION_FLAG = 'terminalAiNamer.secretsMigrated';

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

/**
 * One-time migration: copy plaintext settings into SecretStorage, then clear them.
 */
export async function migrateApiKeysFromConfig(
  context: vscode.ExtensionContext
): Promise<void> {
  if (context.globalState.get<boolean>(MIGRATION_FLAG)) {
    return;
  }

  const config = vscode.workspace.getConfiguration('terminalAiNamer');

  for (const provider of Object.keys(LEGACY_CONFIG_KEYS) as ApiKeyProvider[]) {
    const configKey = LEGACY_CONFIG_KEYS[provider];
    // After removal from package.json contributes, prefer inspect() for leftover user values.
    const inspected = config.inspect<string>(configKey);
    const legacyValue =
      inspected?.globalValue ||
      inspected?.workspaceValue ||
      inspected?.workspaceFolderValue ||
      config.get<string>(configKey, '') ||
      '';
    if (!legacyValue) {
      continue;
    }

    const existing = await context.secrets.get(SECRET_KEYS[provider]);
    if (!existing) {
      await context.secrets.store(SECRET_KEYS[provider], legacyValue);
    }

    if (inspected?.globalValue !== undefined) {
      await config.update(configKey, undefined, vscode.ConfigurationTarget.Global);
    }
    if (inspected?.workspaceValue !== undefined) {
      await config.update(configKey, undefined, vscode.ConfigurationTarget.Workspace);
    }
    if (inspected?.workspaceFolderValue !== undefined) {
      await config.update(configKey, undefined, vscode.ConfigurationTarget.WorkspaceFolder);
    }
  }

  await context.globalState.update(MIGRATION_FLAG, true);
}
