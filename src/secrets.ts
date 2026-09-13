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

/**
 * Legacy combined map for cleared providers (pre-per-provider keys).
 * Still read for backwards compatibility; new writes use per-provider keys.
 */
const CLEARED_API_KEYS_STATE = 'terminalAiNamer.clearedApiKeys';

/** Independent globalState key so concurrent clears cannot clobber each other. */
function clearedApiKeyStateKey(provider: ApiKeyProvider): string {
  return `terminalAiNamer.clearedApiKey.${provider}`;
}

/**
 * Legacy combined map for secret-override providers (pre-per-provider keys).
 * Still read for backwards compatibility; new writes use per-provider keys.
 */
const SECRET_OVERRIDES_LEGACY_STATE = 'terminalAiNamer.secretOverridesLegacy';

/**
 * Independent globalState key so concurrent sidebar saves for different
 * providers cannot clobber each other's override markers.
 */
function secretOverrideStateKey(provider: ApiKeyProvider): string {
  return `terminalAiNamer.secretOverride.${provider}`;
}

/** Full configuration ids for leftover plaintext API keys (migration listeners). */
export const LEGACY_API_KEY_CONFIGURATION_IDS = (
  Object.values(LEGACY_CONFIG_KEYS) as string[]
).map((key) => `terminalAiNamer.${key}`);

/** True when a configuration change may introduce leftover plaintext API keys. */
export function affectsLegacyApiKeyConfiguration(
  e: vscode.ConfigurationChangeEvent
): boolean {
  return LEGACY_API_KEY_CONFIGURATION_IDS.some((id) => e.affectsConfiguration(id));
}

const LEGACY_SCOPES: vscode.ConfigurationTarget[] = [
  vscode.ConfigurationTarget.Global,
  vscode.ConfigurationTarget.Workspace,
  vscode.ConfigurationTarget.WorkspaceFolder,
];

type InspectedString = {
  globalValue?: string;
  workspaceValue?: string;
  workspaceFolderValue?: string;
};

type EffectiveLegacy =
  | { kind: 'absent' }
  | { kind: 'empty' }
  | { kind: 'value'; value: string };

function readLegacyClearedProviders(
  context: vscode.ExtensionContext
): Partial<Record<ApiKeyProvider, true>> {
  return context.globalState.get<Partial<Record<ApiKeyProvider, true>>>(
    CLEARED_API_KEYS_STATE,
    {}
  );
}

async function markApiKeyCleared(
  context: vscode.ExtensionContext,
  provider: ApiKeyProvider
): Promise<void> {
  // Per-provider key avoids lost-update races when two windows clear different
  // providers concurrently against a shared map.
  await context.globalState.update(clearedApiKeyStateKey(provider), true);
}

async function clearApiKeyClearedMarker(
  context: vscode.ExtensionContext,
  provider: ApiKeyProvider
): Promise<void> {
  await context.globalState.update(clearedApiKeyStateKey(provider), undefined);
  const legacy = { ...readLegacyClearedProviders(context) };
  if (!legacy[provider]) {
    return;
  }
  delete legacy[provider];
  await context.globalState.update(
    CLEARED_API_KEYS_STATE,
    Object.keys(legacy).length > 0 ? legacy : undefined
  );
}

function isApiKeyCleared(
  context: vscode.ExtensionContext,
  provider: ApiKeyProvider
): boolean {
  if (context.globalState.get<boolean>(clearedApiKeyStateKey(provider))) {
    return true;
  }
  return Boolean(readLegacyClearedProviders(context)[provider]);
}

function readLegacySecretOverrideProviders(
  context: vscode.ExtensionContext
): Partial<Record<ApiKeyProvider, true>> {
  return context.globalState.get<Partial<Record<ApiKeyProvider, true>>>(
    SECRET_OVERRIDES_LEGACY_STATE,
    {}
  );
}

async function markSecretOverridesLegacy(
  context: vscode.ExtensionContext,
  provider: ApiKeyProvider
): Promise<void> {
  // Per-provider key avoids lost-update races when two windows save different
  // providers concurrently against a shared map.
  await context.globalState.update(secretOverrideStateKey(provider), true);
}

async function clearSecretOverridesLegacy(
  context: vscode.ExtensionContext,
  provider: ApiKeyProvider
): Promise<void> {
  await context.globalState.update(secretOverrideStateKey(provider), undefined);
  const legacy = { ...readLegacySecretOverrideProviders(context) };
  if (!legacy[provider]) {
    return;
  }
  delete legacy[provider];
  await context.globalState.update(
    SECRET_OVERRIDES_LEGACY_STATE,
    Object.keys(legacy).length > 0 ? legacy : undefined
  );
}

function secretOverridesLegacy(
  context: vscode.ExtensionContext,
  provider: ApiKeyProvider
): boolean {
  if (context.globalState.get<boolean>(secretOverrideStateKey(provider))) {
    return true;
  }
  return Boolean(readLegacySecretOverrideProviders(context)[provider]);
}

/**
 * Resolve the effective legacy plaintext value using VS Code precedence.
 * An explicit empty string at a higher-priority scope remains authoritative
 * (disables the credential) even when a lower scope still holds a key.
 */
function effectiveLegacyFromInspect(inspected: InspectedString | undefined): EffectiveLegacy {
  const candidates = [
    inspected?.workspaceFolderValue,
    inspected?.workspaceValue,
    inspected?.globalValue,
  ];
  for (const value of candidates) {
    if (typeof value === 'string') {
      return value.length > 0 ? { kind: 'value', value } : { kind: 'empty' };
    }
  }
  return { kind: 'absent' };
}

/**
 * Effective legacy key for the current workspace / folder resource.
 * Used so retained conflicting plaintext remains usable until migrated.
 *
 * Only `inspect()` scoped fields count. Do not fall back to `config.get()`:
 * that returns the contributed package.json default `""`, which would look like
 * an explicit empty override and hide SecretStorage keys on normal installs.
 */
function effectiveLegacyForResource(
  provider: ApiKeyProvider,
  resource?: vscode.Uri
): EffectiveLegacy {
  const config = vscode.workspace.getConfiguration('terminalAiNamer', resource);
  const configKey = LEGACY_CONFIG_KEYS[provider];
  const inspected = config.inspect<string>(configKey);
  return effectiveLegacyFromInspect(inspected);
}

function currentWorkspaceResource(): vscode.Uri | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri;
}

/**
 * Map a string terminal cwd onto a workspace folder URI so remote schemes
 * (e.g. vscode-remote:) are preserved instead of forcing file:.
 */
function uriForTerminalCwdString(cwd: string): vscode.Uri {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const normalized = cwd.replace(/\\/g, '/');
  let best: vscode.WorkspaceFolder | undefined;
  let bestLen = -1;
  for (const folder of folders) {
    const folderPath = folder.uri.fsPath.replace(/\\/g, '/');
    const prefix = folderPath.endsWith('/') ? folderPath : `${folderPath}/`;
    if (normalized === folderPath || normalized.startsWith(prefix)) {
      if (folderPath.length > bestLen) {
        best = folder;
        bestLen = folderPath.length;
      }
    }
  }
  if (best) {
    return best.uri;
  }
  return vscode.Uri.file(cwd);
}

/**
 * Resolve configuration against the terminal's workspace folder when possible.
 * Falls back to the first workspace folder only when no terminal cwd is known.
 */
export function resourceForTerminal(terminal: vscode.Terminal): vscode.Uri | undefined {
  const shellCwd = terminal.shellIntegration?.cwd;
  if (shellCwd) {
    return shellCwd;
  }

  const creationOptions = terminal.creationOptions;
  if (creationOptions && 'cwd' in creationOptions && creationOptions.cwd) {
    const cwd = creationOptions.cwd;
    return typeof cwd === 'string' ? uriForTerminalCwdString(cwd) : cwd;
  }

  return currentWorkspaceResource();
}

export async function getApiKey(
  context: vscode.ExtensionContext,
  provider: ApiKeyProvider,
  resource?: vscode.Uri
): Promise<string | undefined> {
  if (isApiKeyCleared(context, provider)) {
    return undefined;
  }

  const secret = await context.secrets.get(SECRET_KEYS[provider]);

  // An explicit sidebar save takes precedence over retained conflicting plaintext
  // and over explicit empty legacy overrides that could not be cleared yet.
  if (secretOverridesLegacy(context, provider)) {
    return secret || undefined;
  }

  const resolvedResource = resource ?? currentWorkspaceResource();
  const legacy = effectiveLegacyForResource(provider, resolvedResource);
  // Explicit empty higher-priority override disables the credential in this workspace.
  if (legacy.kind === 'empty') {
    return undefined;
  }

  // Retained conflicting workspace plaintext must remain effective for this workspace.
  if (legacy.kind === 'value') {
    if (!secret || secret !== legacy.value) {
      return legacy.value;
    }
  }

  return secret || undefined;
}

export async function setApiKey(
  context: vscode.ExtensionContext,
  provider: ApiKeyProvider,
  apiKey: string
): Promise<void> {
  const wasCleared = isApiKeyCleared(context, provider);
  const hadOverride = secretOverridesLegacy(context, provider);

  // Store first so a rejected write cannot leave override markers claiming a
  // replacement that never landed.
  await context.secrets.store(SECRET_KEYS[provider], apiKey);

  try {
    await clearApiKeyClearedMarker(context, provider);
    await markSecretOverridesLegacy(context, provider);
  } catch (error) {
    try {
      if (wasCleared) {
        await markApiKeyCleared(context, provider);
      } else {
        await clearApiKeyClearedMarker(context, provider);
      }
      if (hadOverride) {
        await markSecretOverridesLegacy(context, provider);
      } else {
        await clearSecretOverridesLegacy(context, provider);
      }
    } catch (restoreError) {
      console.error(
        'Failed to restore API key markers after partial setApiKey:',
        restoreError
      );
    }
    throw error;
  }
}

export async function deleteApiKey(
  context: vscode.ExtensionContext,
  provider: ApiKeyProvider
): Promise<void> {
  await markApiKeyCleared(context, provider);
  await clearSecretOverridesLegacy(context, provider);
  await context.secrets.delete(SECRET_KEYS[provider]);
}

/**
 * Best-effort removal of visible legacy plaintext values for a provider.
 * Failures (e.g. read-only workspace settings) are collected and rethrown after
 * attempting every scope so callers can still delete SecretStorage.
 */
export async function clearLegacyApiKeySettings(
  provider: ApiKeyProvider
): Promise<void> {
  const configKey = LEGACY_CONFIG_KEYS[provider];
  const failures: unknown[] = [];

  const tryClearConfig = async (
    config: vscode.WorkspaceConfiguration,
    target: vscode.ConfigurationTarget
  ): Promise<void> => {
    const inspected = config.inspect<string>(configKey);
    if (!inspected) {
      return;
    }
    const scoped = readScopedString(inspected, target);
    // Clear non-empty keys and explicit empty overrides (empty can block SecretStorage).
    if (typeof scoped === 'string') {
      await config.update(configKey, undefined, target);
    }
  };

  // Clear unscoped / workspace / user values first.
  const rootConfig = vscode.workspace.getConfiguration('terminalAiNamer');
  for (const target of LEGACY_SCOPES) {
    try {
      await tryClearConfig(rootConfig, target);
    } catch (error) {
      failures.push(error);
    }
  }

  // Also clear each multi-root folder's .vscode/settings.json values.
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const folderConfig = vscode.workspace.getConfiguration('terminalAiNamer', folder.uri);
    try {
      await tryClearConfig(folderConfig, vscode.ConfigurationTarget.WorkspaceFolder);
    } catch (error) {
      failures.push(error);
    }
  }

  if (failures.length > 0) {
    const detail = failures
      .map((error) => (error instanceof Error ? error.message : String(error)))
      .join('; ');
    throw new Error(`Failed to clear some legacy API key settings: ${detail}`);
  }
}

export async function hasApiKey(
  context: vscode.ExtensionContext,
  provider: ApiKeyProvider,
  resource?: vscode.Uri
): Promise<boolean> {
  const value = await getApiKey(context, provider, resource);
  return Boolean(value);
}

/** Where the effective credential currently comes from for UI messaging. */
export type ApiKeySource = 'none' | 'secret' | 'legacy';

/**
 * Resolve whether the effective key is SecretStorage or retained plaintext.
 * Used so the sidebar does not claim "SecretStorage" when a conflicting
 * workspace settings.json value is still what getApiKey returns.
 */
export async function getApiKeySource(
  context: vscode.ExtensionContext,
  provider: ApiKeyProvider,
  resource?: vscode.Uri
): Promise<ApiKeySource> {
  if (isApiKeyCleared(context, provider)) {
    return 'none';
  }

  const secret = await context.secrets.get(SECRET_KEYS[provider]);

  if (secretOverridesLegacy(context, provider)) {
    return secret ? 'secret' : 'none';
  }

  const resolvedResource = resource ?? currentWorkspaceResource();
  const legacy = effectiveLegacyForResource(provider, resolvedResource);
  if (legacy.kind === 'empty') {
    return 'none';
  }
  if (legacy.kind === 'value') {
    if (!secret || secret !== legacy.value) {
      return 'legacy';
    }
    // Values match: SecretStorage holds the credential; leftover plaintext is
    // compatible residue pending cleanup, not a conflicting retained key.
    return 'secret';
  }

  return secret ? 'secret' : 'none';
}

/**
 * Sidebar status across every workspace folder so multi-root retained plaintext
 * is not hidden behind workspaceFolders[0] (which may be secret-only or an
 * explicit empty override while another folder still has a usable legacy key).
 *
 * Prefer `legacy` over `secret` when any folder still uses plaintext; otherwise
 * report `secret` if any folder can resolve a key.
 */
export async function getAggregatedApiKeySource(
  context: vscode.ExtensionContext,
  provider: ApiKeyProvider
): Promise<ApiKeySource> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    return getApiKeySource(context, provider);
  }

  let sawSecret = false;
  for (const folder of folders) {
    const source = await getApiKeySource(context, provider, folder.uri);
    if (source === 'legacy') {
      return 'legacy';
    }
    if (source === 'secret') {
      sawSecret = true;
    }
  }
  return sawSecret ? 'secret' : 'none';
}

function readScopedString(
  inspect: InspectedString,
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
 * Clear legacy plaintext values that match the retained SecretStorage key.
 * Scopes with a different non-empty value are left untouched so a conflicting
 * workspace credential is not destroyed when another workspace already migrated.
 */
async function clearCompatibleLegacyScopes(
  config: vscode.WorkspaceConfiguration,
  configKey: string,
  retainedSecret: string
): Promise<void> {
  const inspected = config.inspect<string>(configKey);
  if (!inspected) {
    return;
  }

  // Attempt every matching scope even if an earlier one fails (e.g. read-only
  // global settings) so writable workspace/folder leftovers still clear.
  const failures: unknown[] = [];
  for (const target of LEGACY_SCOPES) {
    const scoped = readScopedString(inspected, target);
    if (typeof scoped === 'string' && scoped.length > 0 && scoped === retainedSecret) {
      try {
        await config.update(configKey, undefined, target);
      } catch (error) {
        failures.push(error);
      }
    }
  }

  if (failures.length > 0) {
    const detail = failures
      .map((error) => (error instanceof Error ? error.message : String(error)))
      .join('; ');
    throw new Error(`Failed to clear some compatible legacy API key settings: ${detail}`);
  }
}

/**
 * After promoting the effective legacy value into SecretStorage, clear scopes
 * whose plaintext matches that migrated value (including the effective scope).
 * Distinct lower-precedence credentials are left untouched so another workspace
 * that still relies on them is not silently rewritten to the migrated key.
 */
async function clearMatchingLegacyScopes(
  config: vscode.WorkspaceConfiguration,
  configKey: string,
  migratedValue: string,
  inspected: InspectedString
): Promise<void> {
  // Highest → lowest priority for locating the effective scope.
  const scopeOrder: Array<{
    target: vscode.ConfigurationTarget;
    value: string | undefined;
  }> = [
    {
      target: vscode.ConfigurationTarget.WorkspaceFolder,
      value: inspected.workspaceFolderValue,
    },
    {
      target: vscode.ConfigurationTarget.Workspace,
      value: inspected.workspaceValue,
    },
    {
      target: vscode.ConfigurationTarget.Global,
      value: inspected.globalValue,
    },
  ];

  let effectiveIndex = -1;
  for (let i = 0; i < scopeOrder.length; i++) {
    if (typeof scopeOrder[i].value === 'string') {
      effectiveIndex = i;
      break;
    }
  }
  if (effectiveIndex < 0) {
    return;
  }

  // Lowest → highest among effective+lower scopes so partial failure cannot
  // expose a previously shadowed lower key after the effective one is gone.
  // Only clear values equal to the migrated key; preserve distinct credentials.
  const toClear = scopeOrder.slice(effectiveIndex).reverse();
  const failures: unknown[] = [];
  for (const { target, value } of toClear) {
    if (typeof value === 'string' && value === migratedValue) {
      try {
        await config.update(configKey, undefined, target);
      } catch (error) {
        failures.push(error);
      }
    }
  }

  if (failures.length > 0) {
    const detail = failures
      .map((error) => (error instanceof Error ? error.message : String(error)))
      .join('; ');
    throw new Error(`Failed to clear some matching legacy API key settings: ${detail}`);
  }
}

/**
 * Best-effort plaintext cleanup that never throws (used while a Clear tombstone
 * is active so remigration stays suppressed but leftovers can still be retried).
 */
async function tryClearLegacyApiKeySettings(provider: ApiKeyProvider): Promise<void> {
  try {
    await clearLegacyApiKeySettings(provider);
  } catch (error) {
    console.error(
      `Retry cleanup of legacy API key settings failed for ${provider}:`,
      error
    );
  }
}

async function migrateProviderForConfig(
  context: vscode.ExtensionContext,
  provider: ApiKeyProvider,
  config: vscode.WorkspaceConfiguration
): Promise<void> {
  if (isApiKeyCleared(context, provider)) {
    // User explicitly cleared this provider; never remigrate retained plaintext.
    // Keep suppressing remigration, but retry best-effort plaintext removal so
    // credentials do not linger forever after a previously read-only settings file
    // becomes writable again.
    const existing = await context.secrets.get(SECRET_KEYS[provider]);
    if (existing) {
      await context.secrets.delete(SECRET_KEYS[provider]);
    }
    await tryClearLegacyApiKeySettings(provider);
    return;
  }

  const configKey = LEGACY_CONFIG_KEYS[provider];
  const inspected = config.inspect<string>(configKey);
  const effective = effectiveLegacyFromInspect(inspected);

  // Explicit empty higher-priority override: do not promote a lower-scope key.
  if (effective.kind === 'empty' || effective.kind === 'absent') {
    return;
  }

  const legacyValue = effective.value;
  const existing = await context.secrets.get(SECRET_KEYS[provider]);
  if (!existing) {
    await context.secrets.store(SECRET_KEYS[provider], legacyValue);
    // Re-read after store so a concurrent activation that claimed the shared
    // secret with a different value does not cause us to delete our plaintext.
    const claimed = await context.secrets.get(SECRET_KEYS[provider]);
    if (claimed !== legacyValue) {
      return;
    }
    // Clear only scopes whose value matches the migrated key so a shadowed
    // distinct global/user credential is preserved for other workspaces.
    if (inspected) {
      await clearMatchingLegacyScopes(config, configKey, claimed, inspected);
    }
    return;
  }

  // Explicit sidebar save: remove every visible legacy value (including ones
  // that differ from the secret) so obsolete plaintext does not linger forever
  // in closed workspaces that still carry conflicting settings.
  if (secretOverridesLegacy(context, provider)) {
    await tryClearLegacyApiKeySettings(provider);
    return;
  }

  // Keep SecretStorage as source of truth. Only remove plaintext that matches
  // the stored secret; leave conflicting workspace/user values in place so
  // getApiKey can still honor them for the current workspace.
  await clearCompatibleLegacyScopes(config, configKey, existing);
}

/**
 * Migrate leftover plaintext settings into SecretStorage, then clear them.
 *
 * Intentionally has no global one-shot flag: legacy keys may live in other
 * workspaces that were not open on the first activation, so every activation
 * (and config-change) continues to scan the currently visible scopes, including
 * each multi-root workspace folder.
 */
export async function migrateApiKeysFromConfig(
  context: vscode.ExtensionContext
): Promise<void> {
  const failures: Array<{ provider: ApiKeyProvider; error: unknown }> = [];

  // Unscoped configuration covers Global + Workspace (+ default folder when single-root).
  const rootConfig = vscode.workspace.getConfiguration('terminalAiNamer');
  for (const provider of Object.keys(LEGACY_CONFIG_KEYS) as ApiKeyProvider[]) {
    try {
      await migrateProviderForConfig(context, provider, rootConfig);
    } catch (providerError) {
      console.error(`API key migration failed for provider ${provider}:`, providerError);
      failures.push({ provider, error: providerError });
    }
  }

  // Multi-root: inspect each folder's resource-scoped configuration so folder-only
  // `.vscode/settings.json` keys are migrated / cleaned.
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const folderConfig = vscode.workspace.getConfiguration('terminalAiNamer', folder.uri);
    for (const provider of Object.keys(LEGACY_CONFIG_KEYS) as ApiKeyProvider[]) {
      try {
        await migrateProviderForConfig(context, provider, folderConfig);
      } catch (providerError) {
        console.error(
          `API key migration failed for provider ${provider} in folder ${folder.name}:`,
          providerError
        );
        failures.push({ provider, error: providerError });
      }
    }
  }

  // Continue other providers/folders above, then surface failures so activate/config
  // listeners can warn the user that plaintext may remain.
  if (failures.length > 0) {
    const detail = failures
      .map(({ provider, error }) => {
        const message = error instanceof Error ? error.message : String(error);
        return `${provider}: ${message}`;
      })
      .join('; ');
    throw new Error(`API key migration failed for ${failures.length} provider(s): ${detail}`);
  }
}
