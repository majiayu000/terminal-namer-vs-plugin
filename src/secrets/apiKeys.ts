import * as vscode from 'vscode';

export type ApiKeyProvider = 'openrouter' | 'openai' | 'claude';

/** SecretStorage keys for provider API credentials. */
const SECRET_KEYS: Record<ApiKeyProvider, string> = {
  openrouter: 'terminalAiNamer.openrouterApiKey',
  openai: 'terminalAiNamer.openaiApiKey',
  claude: 'terminalAiNamer.claudeApiKey'
};

/** Legacy settings keys that may still hold plaintext API keys. */
const LEGACY_CONFIG_KEYS: Record<ApiKeyProvider, string> = {
  openrouter: 'openrouterApiKey',
  openai: 'openaiApiKey',
  claude: 'claudeApiKey'
};

const LEGACY_SCOPES: vscode.ConfigurationTarget[] = [
  vscode.ConfigurationTarget.Global,
  vscode.ConfigurationTarget.Workspace,
  vscode.ConfigurationTarget.WorkspaceFolder
];

export function isApiKeyProvider(provider: string): provider is ApiKeyProvider {
  return provider === 'openrouter' || provider === 'openai' || provider === 'claude';
}

export function getLegacyConfigKeys(): string[] {
  return Object.values(LEGACY_CONFIG_KEYS);
}

export async function getApiKey(
  secrets: vscode.SecretStorage,
  provider: ApiKeyProvider
): Promise<string | undefined> {
  const value = await secrets.get(SECRET_KEYS[provider]);
  return value || undefined;
}

export async function setApiKey(
  secrets: vscode.SecretStorage,
  provider: ApiKeyProvider,
  apiKey: string
): Promise<void> {
  await secrets.store(SECRET_KEYS[provider], apiKey);
}

export async function clearApiKey(
  secrets: vscode.SecretStorage,
  provider: ApiKeyProvider
): Promise<void> {
  await secrets.delete(SECRET_KEYS[provider]);
}

export async function hasApiKey(
  secrets: vscode.SecretStorage,
  provider: ApiKeyProvider
): Promise<boolean> {
  const value = await getApiKey(secrets, provider);
  return !!value;
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
 * holds a non-empty value (global, workspace, and workspace-folder).
 */
async function clearLegacyKeyAllScopes(
  config: vscode.WorkspaceConfiguration,
  legacyKey: string
): Promise<void> {
  const inspected = config.inspect<string>(legacyKey);
  if (!inspected) {
    return;
  }

  for (const target of LEGACY_SCOPES) {
    const scoped = readScopedString(inspected, target);
    if (typeof scoped === 'string' && scoped.length > 0) {
      await config.update(legacyKey, undefined, target);
    }
  }
}

/**
 * One-time migration: copy plaintext API keys from workspace settings into
 * SecretStorage, then clear the settings values at every populated scope.
 * Also clears leftover plaintext even when SecretStorage already has a key.
 */
export async function migrateApiKeysFromSettings(
  secrets: vscode.SecretStorage
): Promise<void> {
  const config = vscode.workspace.getConfiguration('terminalAiNamer');
  const providers: ApiKeyProvider[] = ['openrouter', 'openai', 'claude'];

  for (const provider of providers) {
    const legacyKey = LEGACY_CONFIG_KEYS[provider];
    const inspected = config.inspect<string>(legacyKey);
    const scopedValues = [
      inspected?.globalValue,
      inspected?.workspaceValue,
      inspected?.workspaceFolderValue
    ].filter((v): v is string => typeof v === 'string' && v.length > 0);

    if (scopedValues.length === 0) {
      continue;
    }

    const existing = await getApiKey(secrets, provider);
    if (!existing) {
      // Prefer the most specific scope (folder > workspace > global).
      const legacyValue =
        scopedValues[scopedValues.length - 1] ?? scopedValues[0];
      await setApiKey(secrets, provider, legacyValue);
    }

    await clearLegacyKeyAllScopes(config, legacyKey);
  }
}
