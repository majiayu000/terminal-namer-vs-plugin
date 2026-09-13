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
 * Workspace-scoped secret id for the open window.
 *
 * Prefer the `.code-workspace` file URI when present so two workspace files that
 * share the same folder set do not collide, and so folderless workspace files
 * still get an identity. Fall back to the sorted folder URI set for single-folder
 * / untitled windows without a workspace file.
 */
function currentWorkspaceId(): string | undefined {
  const workspaceFile = vscode.workspace.workspaceFile;
  if (workspaceFile) {
    return `file:${workspaceFile.toString()}`;
  }

  return foldersWorkspaceId();
}

/**
 * Folder-set id used as a relocation fallback (prior builds keyed secrets this
 * way, and it survives `.code-workspace` renames when the folder set is unchanged).
 */
function foldersWorkspaceId(): string | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return undefined;
  }

  return `folders:${folders
    .map((folder) => folder.uri.toString())
    .sort()
    .join('|')}`;
}

/**
 * Read a workspace-scoped secret, relocating any folders:-keyed value onto the
 * current file:-based id when the workspace file is present.
 */
async function getWorkspaceScopedSecret(
  secrets: vscode.SecretStorage,
  provider: ApiKeyProvider
): Promise<string | undefined> {
  const workspaceId = currentWorkspaceId();
  if (!workspaceId) {
    return undefined;
  }

  const primaryKey = workspaceSecretKey(provider, workspaceId);
  const primaryValue = await secrets.get(primaryKey);
  if (primaryValue) {
    return primaryValue;
  }

  // Relocate folders:-keyed secrets after a workspace-file rename or upgrade
  // from the prior folders-only id scheme.
  const foldersId = foldersWorkspaceId();
  if (!foldersId || foldersId === workspaceId) {
    return undefined;
  }

  const foldersKey = workspaceSecretKey(provider, foldersId);
  const foldersValue = await secrets.get(foldersKey);
  if (!foldersValue) {
    return undefined;
  }

  await secrets.store(primaryKey, foldersValue);
  await secrets.delete(foldersKey);
  return foldersValue;
}

/** Delete every known workspace-scoped secret id for this provider. */
async function clearWorkspaceScopedSecrets(
  secrets: vscode.SecretStorage,
  provider: ApiKeyProvider
): Promise<void> {
  // Relocate folders: → file: first so the primary id is what we delete.
  await getWorkspaceScopedSecret(secrets, provider);

  const workspaceId = currentWorkspaceId();
  if (workspaceId) {
    await secrets.delete(workspaceSecretKey(provider, workspaceId));
  }

  const foldersId = foldersWorkspaceId();
  if (foldersId && foldersId !== workspaceId) {
    await secrets.delete(workspaceSecretKey(provider, foldersId));
  }
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
 *
 * When no resource is provided (unknown terminal cwd / no Shell Integration),
 * folder-scoped credentials are skipped so we never silently pick an unrelated
 * folder account — fall through to workspace/global instead. Use hasApiKey to
 * detect whether any scope (including folder) is configured for the settings UI.
 */
export async function getApiKey(
  secrets: vscode.SecretStorage,
  provider: ApiKeyProvider,
  resource?: vscode.Uri
): Promise<string | undefined> {
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
  }

  const workspaceValue = await getWorkspaceScopedSecret(secrets, provider);
  if (workspaceValue) {
    return workspaceValue;
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

  // Clear more-specific overrides so the saved global value is what getApiKey
  // resolves for this window.
  await clearWorkspaceScopedSecrets(secrets, provider);

  const folders = vscode.workspace.workspaceFolders;
  if (folders) {
    for (const folder of folders) {
      await secrets.delete(folderSecretKey(provider, folder.uri.toString()));
    }
  }
}

/**
 * Clear every credential the unscoped sidebar control represents for this
 * provider (all folder overrides in the window, workspace scope, and global).
 * The settings UI has no terminal/resource scope, so clearing only the first
 * folder key would leave other folder credentials configured.
 */
export async function clearApiKey(
  secrets: vscode.SecretStorage,
  provider: ApiKeyProvider
): Promise<void> {
  const folders = vscode.workspace.workspaceFolders;
  if (folders) {
    for (const folder of folders) {
      await secrets.delete(folderSecretKey(provider, folder.uri.toString()));
    }
  }

  await clearWorkspaceScopedSecrets(secrets, provider);
  await secrets.delete(globalSecretKey(provider));
}

export async function hasApiKey(
  secrets: vscode.SecretStorage,
  provider: ApiKeyProvider
): Promise<boolean> {
  const folders = vscode.workspace.workspaceFolders;
  if (folders) {
    for (const folder of folders) {
      if (await secrets.get(folderSecretKey(provider, folder.uri.toString()))) {
        return true;
      }
    }
  }

  if (await getWorkspaceScopedSecret(secrets, provider)) {
    return true;
  }

  return !!(await secrets.get(globalSecretKey(provider)));
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
 * @param replaceExisting When true, overwrite existing SecretStorage values
 *   (activation and live deprecated-setting edits). Use this whenever a
 *   plaintext value is present so offline replacements are not discarded.
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
    // Relocate folders:-keyed workspace secrets onto the current id first.
    await getWorkspaceScopedSecret(secrets, provider);

    const legacyKey = LEGACY_CONFIG_KEYS[provider];
    const inspected = rootConfig.inspect<string>(legacyKey);

    const globalValue = inspected?.globalValue;
    if (typeof globalValue === 'string' && globalValue.length > 0) {
      // Store-if-absent only: leftover synced Global plaintext must not clobber
      // a newer SecretStorage value set via the sidebar on this machine.
      await storeMigratedSecret(
        secrets,
        globalSecretKey(provider),
        globalValue,
        false
      );
      // Do not clear Global — Settings Sync would delete the plaintext on other
      // installations before they migrate. SecretStorage is preferred for reads;
      // users can remove the deprecated setting manually after all clients upgrade,
      // or re-enter via the sidebar Quick Settings panel.
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
