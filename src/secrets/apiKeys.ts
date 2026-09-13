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

/**
 * Marker stored in SecretStorage when a scope is explicitly cleared / disabled.
 * Distinguished from a missing key so migration does not restore leftover
 * plaintext, and so empty scoped overrides can block fallthrough to global.
 */
const CLEARED_MARKER = '__terminalAiNamer.cleared__';

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

/** Tracks plaintext that was migrated but not successfully cleared from settings. */
function remnantKey(secretKey: string): string {
  return `${secretKey}.migratedRemnant`;
}

function isClearedMarker(value: string | undefined): boolean {
  return value === CLEARED_MARKER;
}

function isUsableSecret(value: string | undefined): value is string {
  return typeof value === 'string' && value.length > 0 && !isClearedMarker(value);
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
 * Read a workspace-scoped secret (including cleared markers), relocating any
 * folders:-keyed value onto the current file:-based id when needed while
 * retaining the folders: alias for future workspace-file renames.
 */
async function getWorkspaceScopedSecretRaw(
  secrets: vscode.SecretStorage,
  provider: ApiKeyProvider
): Promise<string | undefined> {
  const workspaceId = currentWorkspaceId();
  if (!workspaceId) {
    return undefined;
  }

  const primaryKey = workspaceSecretKey(provider, workspaceId);
  const primaryValue = await secrets.get(primaryKey);
  if (primaryValue !== undefined) {
    return primaryValue;
  }

  // Fall back to folders:-keyed alias after a workspace-file rename/move/save,
  // or when upgrading from the prior folders-only id scheme.
  const foldersId = foldersWorkspaceId();
  if (!foldersId || foldersId === workspaceId) {
    return undefined;
  }

  const foldersKey = workspaceSecretKey(provider, foldersId);
  const foldersValue = await secrets.get(foldersKey);
  if (foldersValue === undefined) {
    return undefined;
  }

  // Copy onto the current file: primary key but keep the folders: alias so a
  // later rename of the .code-workspace file can still resolve the secret.
  await secrets.store(primaryKey, foldersValue);
  return foldersValue;
}

/**
 * Persist a workspace-scoped value under the current primary id and, when a
 * distinct folder-set id exists, under the stable folders: alias as well.
 */
async function storeWorkspaceScopedSecret(
  secrets: vscode.SecretStorage,
  provider: ApiKeyProvider,
  value: string,
  replaceExisting: boolean
): Promise<void> {
  const workspaceId = currentWorkspaceId();
  if (!workspaceId) {
    return;
  }

  await storeMigratedSecret(
    secrets,
    workspaceSecretKey(provider, workspaceId),
    value,
    replaceExisting
  );

  const foldersId = foldersWorkspaceId();
  if (foldersId && foldersId !== workspaceId) {
    await storeMigratedSecret(
      secrets,
      workspaceSecretKey(provider, foldersId),
      value,
      replaceExisting
    );
  }
}

/** Delete every known workspace-scoped secret id for this provider. */
async function clearWorkspaceScopedSecrets(
  secrets: vscode.SecretStorage,
  provider: ApiKeyProvider
): Promise<void> {
  // Ensure file: primary exists from folders: alias before deleting both.
  await getWorkspaceScopedSecretRaw(secrets, provider);

  const workspaceId = currentWorkspaceId();
  if (workspaceId) {
    const key = workspaceSecretKey(provider, workspaceId);
    await secrets.delete(key);
    await secrets.delete(remnantKey(key));
  }

  const foldersId = foldersWorkspaceId();
  if (foldersId && foldersId !== workspaceId) {
    const key = workspaceSecretKey(provider, foldersId);
    await secrets.delete(key);
    await secrets.delete(remnantKey(key));
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
    // Treat any stored value (including cleared markers) as present so leftover
    // plaintext cannot resurrect a cleared credential.
    if (existing !== undefined) {
      return;
    }
  }
  await secrets.store(key, value);
}

/**
 * Migrate a plaintext setting into SecretStorage, skipping re-application when
 * the same plaintext was already migrated but cleanup previously failed (the
 * remnant marker). Always retries cleanup; clears the remnant on success.
 */
async function migrateScopeValue(
  secrets: vscode.SecretStorage,
  secretKey: string,
  plaintext: string,
  replaceExisting: boolean,
  store: (replace: boolean) => Promise<void>,
  cleanup: () => Promise<string | undefined>
): Promise<string | undefined> {
  const remnant = await secrets.get(remnantKey(secretKey));
  const alreadyMigratedRemnant = remnant === plaintext;

  if (!alreadyMigratedRemnant) {
    await store(replaceExisting);
  }

  const failure = await cleanup();
  if (failure) {
    // Remember this plaintext so a later activation does not recreate a scoped
    // secret the user already replaced/cleared via the sidebar while the
    // read-only settings file still holds the old value.
    await secrets.store(remnantKey(secretKey), plaintext);
    return failure;
  }

  await secrets.delete(remnantKey(secretKey));
  return undefined;
}

/**
 * Resolve API key with VS Code-like precedence:
 * matching workspace-folder (when resource given) > workspace > global/legacy.
 *
 * Cleared markers at a more-specific scope block fallthrough (explicit empty
 * overrides and sidebar clears).
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
      if (isClearedMarker(folderValue)) {
        return undefined;
      }
      if (isUsableSecret(folderValue)) {
        return folderValue;
      }
    }
  }

  const workspaceValue = await getWorkspaceScopedSecretRaw(secrets, provider);
  if (isClearedMarker(workspaceValue)) {
    return undefined;
  }
  if (isUsableSecret(workspaceValue)) {
    return workspaceValue;
  }

  const globalValue = await secrets.get(globalSecretKey(provider));
  if (isClearedMarker(globalValue) || !isUsableSecret(globalValue)) {
    return undefined;
  }
  return globalValue;
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
  await secrets.delete(remnantKey(globalSecretKey(provider)));

  // Clear more-specific overrides so the saved global value is what getApiKey
  // resolves for this window.
  await clearWorkspaceScopedSecrets(secrets, provider);

  const folders = vscode.workspace.workspaceFolders;
  if (folders) {
    for (const folder of folders) {
      const key = folderSecretKey(provider, folder.uri.toString());
      await secrets.delete(key);
      await secrets.delete(remnantKey(key));
    }
  }
}

/**
 * Clear every credential the unscoped sidebar control represents for this
 * provider (all folder overrides in the window, workspace scope, and global).
 * Global uses an explicit cleared marker so leftover synced plaintext settings
 * cannot rematerialize the key on the next activation.
 */
export async function clearApiKey(
  secrets: vscode.SecretStorage,
  provider: ApiKeyProvider
): Promise<void> {
  const folders = vscode.workspace.workspaceFolders;
  if (folders) {
    for (const folder of folders) {
      const key = folderSecretKey(provider, folder.uri.toString());
      await secrets.delete(key);
      await secrets.delete(remnantKey(key));
    }
  }

  await clearWorkspaceScopedSecrets(secrets, provider);

  // Tombstone rather than delete: migration leaves Global plaintext in place for
  // Settings Sync, and must not restore a key the user explicitly cleared.
  await secrets.store(globalSecretKey(provider), CLEARED_MARKER);
  await secrets.delete(remnantKey(globalSecretKey(provider)));
}

export async function hasApiKey(
  secrets: vscode.SecretStorage,
  provider: ApiKeyProvider
): Promise<boolean> {
  const folders = vscode.workspace.workspaceFolders;
  if (folders) {
    for (const folder of folders) {
      const folderValue = await secrets.get(
        folderSecretKey(provider, folder.uri.toString())
      );
      if (isUsableSecret(folderValue)) {
        return true;
      }
    }
  }

  const workspaceValue = await getWorkspaceScopedSecretRaw(secrets, provider);
  if (isClearedMarker(workspaceValue)) {
    // Explicit workspace disable — treat as unconfigured for this window.
    return false;
  }
  if (isUsableSecret(workspaceValue)) {
    return true;
  }

  const globalValue = await secrets.get(globalSecretKey(provider));
  return isUsableSecret(globalValue);
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
 * Explicit empty strings at workspace/folder scope are stored as cleared
 * markers so they continue to disable more-general credentials.
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
    await getWorkspaceScopedSecretRaw(secrets, provider);

    const legacyKey = LEGACY_CONFIG_KEYS[provider];
    const inspected = rootConfig.inspect<string>(legacyKey);

    const globalValue = inspected?.globalValue;
    if (typeof globalValue === 'string' && globalValue.length > 0) {
      // Store-if-absent only: leftover synced Global plaintext must not clobber
      // a newer SecretStorage value (or cleared marker) set via the sidebar.
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
    if (typeof workspaceValue === 'string' && workspaceId) {
      const primaryKey = workspaceSecretKey(provider, workspaceId);

      if (workspaceValue.length === 0) {
        // Explicit empty scoped override: keep a tombstone so global does not leak.
        await storeWorkspaceScopedSecret(
          secrets,
          provider,
          CLEARED_MARKER,
          true
        );
        const failure = await clearLegacyScope(
          rootConfig,
          legacyKey,
          vscode.ConfigurationTarget.Workspace
        );
        if (failure) {
          cleanupFailures.push(failure);
        }
      } else {
        const failure = await migrateScopeValue(
          secrets,
          primaryKey,
          workspaceValue,
          replaceExisting,
          (replace) =>
            storeWorkspaceScopedSecret(secrets, provider, workspaceValue, replace),
          () =>
            clearLegacyScope(
              rootConfig,
              legacyKey,
              vscode.ConfigurationTarget.Workspace
            )
        );
        if (failure) {
          cleanupFailures.push(failure);
        }
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
      if (typeof folderValue !== 'string') {
        continue;
      }

      const folderKey = folderSecretKey(provider, folder.uri.toString());

      if (folderValue.length === 0) {
        await storeMigratedSecret(secrets, folderKey, CLEARED_MARKER, true);
        const failure = await clearLegacyScope(
          folderConfig,
          legacyKey,
          vscode.ConfigurationTarget.WorkspaceFolder
        );
        if (failure) {
          cleanupFailures.push(failure);
        }
        continue;
      }

      const failure = await migrateScopeValue(
        secrets,
        folderKey,
        folderValue,
        replaceExisting,
        (replace) =>
          storeMigratedSecret(secrets, folderKey, folderValue, replace),
        () =>
          clearLegacyScope(
            folderConfig,
            legacyKey,
            vscode.ConfigurationTarget.WorkspaceFolder
          )
      );
      if (failure) {
        cleanupFailures.push(failure);
      }
    }
  }

  return { cleanupFailures };
}
