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

async function storeMigratedSecret(
  secrets: vscode.SecretStorage,
  key: string,
  value: string,
  replaceExisting: boolean
): Promise<void> {
  if (!replaceExisting) {
    const existing = await secrets.get(key);
    if (existing) {
      return;
    }
  }
  await secrets.store(key, value);
}

/**
 * Resolve API key with VS Code-like precedence:
 * matching workspace-folder (when resource given) > workspace > global/legacy.
 * Without a resource, any folder override counts as "configured" for settings UI.
 */
export async function getApiKey(
  secrets: vscode.SecretStorage,
  provider: ApiKeyProvider,
  resource?: vscode.Uri
): Promise<string | undefined> {
  const folders = vscode.workspace.workspaceFolders;
  if (folders) {
    if (resource) {
      const matchingFolder = vscode.workspace.getWorkspaceFolder(resource);
      if (matchingFolder) {
        const folderValue = await secrets.get(
          folderSecretKey(provider, matchingFolder.uri.toString())
        );
        if (folderValue) {
          return folderValue;
        }
      }
    } else {
      for (const folder of folders) {
        const folderValue = await secrets.get(
          folderSecretKey(provider, folder.uri.toString())
        );
        if (folderValue) {
          return folderValue;
        }
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
): Promise<string | undefined> {
  try {
    await config.update(legacyKey, undefined, target);
    return undefined;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `Failed to clear terminalAiNamer.${legacyKey} (${configurationTargetLabel(target)}): ${message}`;
  }
}

function configurationTargetLabel(target: vscode.ConfigurationTarget): string {
  switch (target) {
    case vscode.ConfigurationTarget.Global:
      return 'Global';
    case vscode.ConfigurationTarget.Workspace:
      return 'Workspace';
    case vscode.ConfigurationTarget.WorkspaceFolder:
      return 'WorkspaceFolder';
    default:
      return String(target);
  }
}

export interface MigrateApiKeysResult {
  cleanupFailures: string[];
}

/**
 * Copy plaintext API keys from each configuration scope into a matching
 * SecretStorage key, then clear only that scope. Multi-root folders are
 * inspected with a resource-scoped configuration.
 *
 * @param replaceExisting When true (later deprecated-setting edits), overwrite
 *   existing SecretStorage values. Initial activation keeps store-if-absent.
 */
export async function migrateApiKeysFromSettings(
  secrets: vscode.SecretStorage,
  options?: { replaceExisting?: boolean }
): Promise<MigrateApiKeysResult> {
  const replaceExisting = options?.replaceExisting === true;
  const cleanupFailures: string[] = [];
  const providers: ApiKeyProvider[] = ['openrouter', 'openai', 'claude'];
  const rootConfig = vscode.workspace.getConfiguration('terminalAiNamer');

  for (const provider of providers) {
    const legacyKey = LEGACY_CONFIG_KEYS[provider];
    const inspected = rootConfig.inspect<string>(legacyKey);

    const globalValue = inspected?.globalValue;
    if (typeof globalValue === 'string' && globalValue.length > 0) {
      await storeMigratedSecret(
        secrets,
        globalSecretKey(provider),
        globalValue,
        replaceExisting
      );
      const failure = await clearLegacyScope(
        rootConfig,
        legacyKey,
        vscode.ConfigurationTarget.Global
      );
      if (failure) {
        cleanupFailures.push(failure);
      }
    }

    const workspaceValue = inspected?.workspaceValue;
    const workspaceId = currentWorkspaceId();
    if (
      typeof workspaceValue === 'string' &&
      workspaceValue.length > 0 &&
      workspaceId
    ) {
      await storeMigratedSecret(
        secrets,
        workspaceSecretKey(provider, workspaceId),
        workspaceValue,
        replaceExisting
      );
      const failure = await clearLegacyScope(
        rootConfig,
        legacyKey,
        vscode.ConfigurationTarget.Workspace
      );
      if (failure) {
        cleanupFailures.push(failure);
      }
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

      await storeMigratedSecret(
        secrets,
        folderSecretKey(provider, folder.uri.toString()),
        folderValue,
        replaceExisting
      );
      const failure = await clearLegacyScope(
        folderConfig,
        legacyKey,
        vscode.ConfigurationTarget.WorkspaceFolder
      );
      if (failure) {
        cleanupFailures.push(failure);
      }
    }
  }

  return { cleanupFailures };
}
