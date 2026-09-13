import * as vscode from 'vscode';

export type ApiKeyProvider = 'openrouter' | 'openai' | 'claude';

/** SecretStorage keys for provider API credentials (global / legacy unscoped). */
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

export function getLegacyConfigKeys(): string[] {
  return Object.values(LEGACY_CONFIG_KEYS);
}

function globalSecretKey(provider: ApiKeyProvider): string {
  return SECRET_KEYS[provider];
}

function workspaceSecretKey(provider: ApiKeyProvider, workspaceId: string): string {
  return `${SECRET_KEYS[provider]}.workspace.${workspaceId}`;
}

function folderSecretKey(provider: ApiKeyProvider, folderUri: string): string {
  return `${SECRET_KEYS[provider]}.folder.${folderUri}`;
}

/**
 * Stable id for the currently open workspace so workspace-scoped secrets do not
 * collide across different multi-root / .code-workspace windows.
 */
function currentWorkspaceId(): string | undefined {
  const workspaceFile = vscode.workspace.workspaceFile;
  if (workspaceFile) {
    return `file:${workspaceFile.toString()}`;
  }

  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return undefined;
  }

  return `folders:${folders
    .map((folder) => folder.uri.toString())
    .sort()
    .join('|')}`;
}

async function storeIfAbsent(
  secrets: vscode.SecretStorage,
  key: string,
  value: string
): Promise<void> {
  const existing = await secrets.get(key);
  if (!existing) {
    await secrets.store(key, value);
  }
}

/**
 * Resolve API key with VS Code-like precedence:
 * workspace-folder > workspace > global/legacy unscoped.
 */
export async function getApiKey(
  secrets: vscode.SecretStorage,
  provider: ApiKeyProvider
): Promise<string | undefined> {
  const folders = vscode.workspace.workspaceFolders;
  if (folders) {
    for (const folder of folders) {
      const folderValue = await secrets.get(
        folderSecretKey(provider, folder.uri.toString())
      );
      if (folderValue) {
        return folderValue;
      }
    }
  }

  const workspaceId = currentWorkspaceId();
  if (workspaceId) {
    const workspaceValue = await secrets.get(
      workspaceSecretKey(provider, workspaceId)
    );
    if (workspaceValue) {
      return workspaceValue;
    }
  }

  const globalValue = await secrets.get(globalSecretKey(provider));
  return globalValue || undefined;
}

/**
 * Store a key at global scope and clear more-specific overrides for the current
 * workspace so the saved value is what getApiKey resolves to.
 */
export async function setApiKey(
  secrets: vscode.SecretStorage,
  provider: ApiKeyProvider,
  apiKey: string
): Promise<void> {
  await secrets.store(globalSecretKey(provider), apiKey);

  const workspaceId = currentWorkspaceId();
  if (workspaceId) {
    await secrets.delete(workspaceSecretKey(provider, workspaceId));
  }

  const folders = vscode.workspace.workspaceFolders;
  if (folders) {
    for (const folder of folders) {
      await secrets.delete(folderSecretKey(provider, folder.uri.toString()));
    }
  }
}

/**
 * Clear only the currently effective credential so other scopes (e.g. a global
 * key still needed in another workspace) remain intact.
 */
export async function clearApiKey(
  secrets: vscode.SecretStorage,
  provider: ApiKeyProvider
): Promise<void> {
  const folders = vscode.workspace.workspaceFolders;
  if (folders) {
    for (const folder of folders) {
      const key = folderSecretKey(provider, folder.uri.toString());
      if (await secrets.get(key)) {
        await secrets.delete(key);
        return;
      }
    }
  }

  const workspaceId = currentWorkspaceId();
  if (workspaceId) {
    const key = workspaceSecretKey(provider, workspaceId);
    if (await secrets.get(key)) {
      await secrets.delete(key);
      return;
    }
  }

  await secrets.delete(globalSecretKey(provider));
}

export async function hasApiKey(
  secrets: vscode.SecretStorage,
  provider: ApiKeyProvider
): Promise<boolean> {
  const value = await getApiKey(secrets, provider);
  return !!value;
}

async function clearLegacyScope(
  config: vscode.WorkspaceConfiguration,
  legacyKey: string,
  target: vscode.ConfigurationTarget
): Promise<void> {
  await config.update(legacyKey, undefined, target);
}

/**
 * One-time migration: copy plaintext API keys from each configuration scope into
 * a matching SecretStorage key, then clear only that scope. Multi-root folders
 * are inspected with a resource-scoped configuration.
 */
export async function migrateApiKeysFromSettings(
  secrets: vscode.SecretStorage
): Promise<void> {
  const providers: ApiKeyProvider[] = ['openrouter', 'openai', 'claude'];
  const rootConfig = vscode.workspace.getConfiguration('terminalAiNamer');

  for (const provider of providers) {
    const legacyKey = LEGACY_CONFIG_KEYS[provider];
    const inspected = rootConfig.inspect<string>(legacyKey);

    const globalValue = inspected?.globalValue;
    if (typeof globalValue === 'string' && globalValue.length > 0) {
      await storeIfAbsent(secrets, globalSecretKey(provider), globalValue);
      await clearLegacyScope(
        rootConfig,
        legacyKey,
        vscode.ConfigurationTarget.Global
      );
    }

    const workspaceValue = inspected?.workspaceValue;
    const workspaceId = currentWorkspaceId();
    if (
      typeof workspaceValue === 'string' &&
      workspaceValue.length > 0 &&
      workspaceId
    ) {
      await storeIfAbsent(
        secrets,
        workspaceSecretKey(provider, workspaceId),
        workspaceValue
      );
      await clearLegacyScope(
        rootConfig,
        legacyKey,
        vscode.ConfigurationTarget.Workspace
      );
    }

    const folders = vscode.workspace.workspaceFolders;
    if (!folders) {
      continue;
    }

    for (const folder of folders) {
      const folderConfig = vscode.workspace.getConfiguration(
        'terminalAiNamer',
        folder.uri
      );
      const folderInspected = folderConfig.inspect<string>(legacyKey);
      const folderValue = folderInspected?.workspaceFolderValue;
      if (typeof folderValue !== 'string' || folderValue.length === 0) {
        continue;
      }

      await storeIfAbsent(
        secrets,
        folderSecretKey(provider, folder.uri.toString()),
        folderValue
      );
      await clearLegacyScope(
        folderConfig,
        legacyKey,
        vscode.ConfigurationTarget.WorkspaceFolder
      );
    }
  }
}
