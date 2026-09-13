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

/** globalState marker so an explicit Clear cannot remigrate retained plaintext. */
const CLEARED_API_KEYS_STATE = 'terminalAiNamer.clearedApiKeys';

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

function readClearedProviders(
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
  const cleared = { ...readClearedProviders(context), [provider]: true as const };
  await context.globalState.update(CLEARED_API_KEYS_STATE, cleared);
}

async function clearApiKeyClearedMarker(
  context: vscode.ExtensionContext,
  provider: ApiKeyProvider
): Promise<void> {
  const cleared = { ...readClearedProviders(context) };
  if (!cleared[provider]) {
    return;
  }
  delete cleared[provider];
  await context.globalState.update(CLEARED_API_KEYS_STATE, cleared);
}

function isApiKeyCleared(
  context: vscode.ExtensionContext,
  provider: ApiKeyProvider
): boolean {
  return Boolean(readClearedProviders(context)[provider]);
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
 */
function effectiveLegacyForResource(
  provider: ApiKeyProvider,
  resource?: vscode.Uri
): EffectiveLegacy {
  const config = vscode.workspace.getConfiguration('terminalAiNamer', resource);
  const configKey = LEGACY_CONFIG_KEYS[provider];
  const inspected = config.inspect<string>(configKey);
  const fromInspect = effectiveLegacyFromInspect(inspected);
  if (fromInspect.kind !== 'absent') {
    return fromInspect;
  }
  // Fallback for values that inspect may not surface (rare / language overrides).
  const fallback = config.get<string>(configKey);
  if (typeof fallback === 'string') {
    return fallback.length > 0 ? { kind: 'value', value: fallback } : { kind: 'empty' };
  }
  return { kind: 'absent' };
}

function currentWorkspaceResource(): vscode.Uri | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri;
}

export async function getApiKey(
  context: vscode.ExtensionContext,
  provider: ApiKeyProvider
): Promise<string | undefined> {
  if (isApiKeyCleared(context, provider)) {
    return undefined;
  }

  const resource = currentWorkspaceResource();
  const legacy = effectiveLegacyForResource(provider, resource);
  // Explicit empty higher-priority override disables the credential in this workspace.
  if (legacy.kind === 'empty') {
    return undefined;
  }

  const secret = await context.secrets.get(SECRET_KEYS[provider]);

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
  await clearApiKeyClearedMarker(context, provider);
  await context.secrets.store(SECRET_KEYS[provider], apiKey);
}

export async function deleteApiKey(
  context: vscode.ExtensionContext,
  provider: ApiKeyProvider
): Promise<void> {
  await markApiKeyCleared(context, provider);
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
    if (typeof scoped === 'string' && scoped.length > 0) {
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
  provider: ApiKeyProvider
): Promise<boolean> {
  const value = await getApiKey(context, provider);
  return Boolean(value);
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

  for (const target of LEGACY_SCOPES) {
    const scoped = readScopedString(inspected, target);
    if (typeof scoped === 'string' && scoped.length > 0 && scoped === retainedSecret) {
      await config.update(configKey, undefined, target);
    }
  }
}

async function migrateProviderForConfig(
  context: vscode.ExtensionContext,
  provider: ApiKeyProvider,
  config: vscode.WorkspaceConfiguration
): Promise<void> {
  if (isApiKeyCleared(context, provider)) {
    // User explicitly cleared this provider; never remigrate retained plaintext.
    // Still attempt compatible cleanup of matching leftover values when possible.
    const existing = await context.secrets.get(SECRET_KEYS[provider]);
    if (existing) {
      await context.secrets.delete(SECRET_KEYS[provider]);
    }
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
    await clearCompatibleLegacyScopes(config, configKey, legacyValue);
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
