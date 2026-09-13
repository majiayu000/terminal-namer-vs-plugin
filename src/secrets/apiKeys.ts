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

export function isApiKeyProvider(provider: string): provider is ApiKeyProvider {
  return provider === 'openrouter' || provider === 'openai' || provider === 'claude';
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

/**
 * One-time migration: copy plaintext API keys from workspace settings into
 * SecretStorage, then clear the settings values.
 */
export async function migrateApiKeysFromSettings(
  secrets: vscode.SecretStorage
): Promise<void> {
  const config = vscode.workspace.getConfiguration('terminalAiNamer');
  const providers: ApiKeyProvider[] = ['openrouter', 'openai', 'claude'];

  for (const provider of providers) {
    const existing = await getApiKey(secrets, provider);
    if (existing) {
      continue;
    }

    const legacyKey = LEGACY_CONFIG_KEYS[provider];
    const legacyValue = config.get<string>(legacyKey, '');
    if (!legacyValue) {
      continue;
    }

    await setApiKey(secrets, provider, legacyValue);
    await config.update(legacyKey, '', vscode.ConfigurationTarget.Global);
  }
}
