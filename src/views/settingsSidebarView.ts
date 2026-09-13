import * as vscode from 'vscode';
import { UsageTracker } from '../core';
import { ProviderType } from '../providers';
import {
  ApiKeyProvider,
  clearApiKey,
  hasApiKey,
  isApiKeyProvider,
  setApiKey
} from '../secrets/apiKeys';

const ALLOWED_PROVIDERS: readonly ProviderType[] = [
  'openrouter',
  'openai',
  'claude',
  'ollama'
];

const ALLOWED_LANGUAGES = ['zh', 'en'] as const;

const ALLOWED_OPENROUTER_MODELS = [
  'google/gemini-2.5-flash',
  'google/gemini-2.5-pro',
  'google/gemini-2.0-flash-001',
  'anthropic/claude-3-haiku',
  'anthropic/claude-3.5-sonnet',
  'openai/gpt-4o-mini',
  'openai/gpt-4o',
  'meta-llama/llama-3.1-8b-instruct'
] as const;

type AllowedSettingKey =
  | 'provider'
  | 'openrouterModel'
  | 'autoRename'
  | 'commandThreshold'
  | 'language';

type SettingValidator = (value: unknown) => boolean;

const SETTING_VALIDATORS: Record<AllowedSettingKey, SettingValidator> = {
  provider: (v) =>
    typeof v === 'string' && (ALLOWED_PROVIDERS as readonly string[]).includes(v),
  openrouterModel: (v) =>
    typeof v === 'string' &&
    (ALLOWED_OPENROUTER_MODELS as readonly string[]).includes(v),
  autoRename: (v) => typeof v === 'boolean',
  commandThreshold: (v) =>
    typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 10,
  language: (v) =>
    typeof v === 'string' && (ALLOWED_LANGUAGES as readonly string[]).includes(v)
};

interface SaveSettingsMessage {
  command: 'saveSettings';
  settings?: Record<string, unknown>;
  /** New API key to store; omit to keep existing. Empty string clears. */
  apiKey?: string;
}

/**
 * 侧边栏设置面板 Webview Provider
 */
export class SettingsSidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'terminalAiNamer.settingsView';
  private _view?: vscode.WebviewView;
  private _usageTracker?: UsageTracker;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _secrets: vscode.SecretStorage,
    usageTracker?: UsageTracker
  ) {
    this._usageTracker = usageTracker;
  }

  public updateStats() {
    if (this._view && this._usageTracker) {
      const today = this._usageTracker.getTodayStats();
      const total = this._usageTracker.getStats();
      this._view.webview.postMessage({
        command: 'updateStats',
        stats: {
          todayTokens: today.totalTokens,
          todayCost: today.totalCost,
          todayRequests: today.requestCount,
          totalTokens: total.totalTokens,
          totalCost: total.totalCost,
          totalRequests: total.requestCount
        }
      });
    }
  }

  /** Re-push current settings after SecretStorage migration completes. */
  public refreshSettings() {
    void this._sendCurrentSettings();
    this.updateStats();
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri]
    };

    webviewView.webview.html = this._getHtmlContent(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (message) => {
      switch (message.command) {
        case 'saveSettings':
          await this._saveSettings(message as SaveSettingsMessage);
          break;
        case 'getSettings':
          await this._sendCurrentSettings();
          this.updateStats();
          break;
        case 'openFullSettings':
          vscode.commands.executeCommand('terminalAiNamer.openSettings');
          break;
        case 'resetStats':
          vscode.commands.executeCommand('terminalAiNamer.resetStats');
          break;
      }
    });

    void this._sendCurrentSettings();
    this.updateStats();
  }

  private async _saveSettings(message: SaveSettingsMessage) {
    const settings = message.settings;
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      vscode.window.showErrorMessage('设置保存失败: 无效的设置载荷');
      return;
    }

    const config = vscode.workspace.getConfiguration('terminalAiNamer');
    const rejected: string[] = [];
    const updateFailures: string[] = [];
    let providerForKey: ProviderType | undefined;

    for (const [key, value] of Object.entries(settings)) {
      // Reject inherited Object keys (constructor, __proto__, etc.).
      if (!Object.prototype.hasOwnProperty.call(SETTING_VALIDATORS, key)) {
        rejected.push(key);
        continue;
      }

      const settingKey = key as AllowedSettingKey;
      if (!SETTING_VALIDATORS[settingKey](value)) {
        rejected.push(key);
        continue;
      }

      if (settingKey === 'provider') {
        providerForKey = value as ProviderType;
      }

      // Isolate non-secret update failures so a read-only Global settings store
      // cannot abort the handler before SecretStorage credential writes.
      try {
        await config.update(settingKey, value, vscode.ConfigurationTarget.Global);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        updateFailures.push(`${key} (${detail})`);
      }
    }

    if (rejected.length > 0) {
      vscode.window.showWarningMessage(
        `已忽略无效设置项: ${rejected.join(', ')}`
      );
    }

    // API keys never go through configuration — only SecretStorage.
    let apiKeySaved = false;
    if (typeof message.apiKey === 'string') {
      const provider =
        providerForKey ??
        config.get<ProviderType>('provider', 'openrouter');

      if (!isApiKeyProvider(provider)) {
        vscode.window.showWarningMessage('当前提供商不使用 API Key');
      } else if (message.apiKey.length === 0) {
        await clearApiKey(this._secrets, provider);
        apiKeySaved = true;
      } else {
        await setApiKey(this._secrets, provider, message.apiKey);
        apiKeySaved = true;
      }
    }

    if (updateFailures.length > 0) {
      vscode.window.showWarningMessage(
        `部分设置未能写入配置${apiKeySaved ? '（API Key 已保存到 SecretStorage）' : ''}: ${updateFailures.join('; ')}`
      );
    } else {
      vscode.window.showInformationMessage('设置已保存');
    }
    await this._sendCurrentSettings();
  }

  private async _sendCurrentSettings() {
    if (!this._view) return;

    const config = vscode.workspace.getConfiguration('terminalAiNamer');
    const provider = config.get<ProviderType>('provider', 'openrouter');
    let apiKeyConfigured = false;

    if (isApiKeyProvider(provider)) {
      apiKeyConfigured = await hasApiKey(this._secrets, provider as ApiKeyProvider);
    }

    // Never send plaintext API keys into the webview.
    this._view.webview.postMessage({
      command: 'loadSettings',
      settings: {
        provider,
        openrouterModel: config.get('openrouterModel', 'google/gemini-2.5-flash'),
        autoRename: config.get('autoRename', true),
        commandThreshold: config.get('commandThreshold', 3),
        language: config.get('language', 'zh'),
        apiKeyConfigured
      }
    });
  }

  private _getHtmlContent(webview: vscode.Webview): string {
    const nonce = getNonce();
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `img-src ${webview.cspSource} https:`,
      `font-src ${webview.cspSource}`
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      padding: 12px;
    }
    .section { margin-bottom: 16px; }
    .section-title {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      color: var(--vscode-foreground);
      margin-bottom: 8px;
      opacity: 0.8;
    }
    .form-group { margin-bottom: 12px; }
    label {
      display: block;
      font-size: 12px;
      margin-bottom: 4px;
    }
    input, select {
      width: 100%;
      padding: 6px 8px;
      border: 1px solid var(--vscode-input-border);
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border-radius: 3px;
      font-size: 12px;
    }
    input:focus, select:focus {
      outline: none;
      border-color: var(--vscode-focusBorder);
    }
    .checkbox-row {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .checkbox-row input { width: auto; }
    button {
      width: 100%;
      padding: 8px;
      border: none;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border-radius: 3px;
      cursor: pointer;
      font-size: 12px;
      margin-top: 4px;
    }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button.secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    .status {
      padding: 8px;
      border-radius: 3px;
      margin-bottom: 12px;
      font-size: 11px;
    }
    .status.success {
      background: var(--vscode-inputValidation-infoBackground);
      border: 1px solid var(--vscode-inputValidation-infoBorder);
    }
    .status.warning {
      background: var(--vscode-inputValidation-warningBackground);
      border: 1px solid var(--vscode-inputValidation-warningBorder);
    }
    .api-key-group { position: relative; }
    .api-key-hint {
      font-size: 11px;
      opacity: 0.7;
      margin-top: 4px;
    }
    .toggle-visibility {
      position: absolute;
      right: 6px;
      top: 22px;
      background: none;
      border: none;
      width: auto;
      padding: 2px 4px;
      cursor: pointer;
      opacity: 0.6;
      margin: 0;
    }
    .toggle-visibility:hover {
      opacity: 1;
      background: none;
    }
    .stats-card {
      background: var(--vscode-editor-inactiveSelectionBackground);
      border-radius: 6px;
      padding: 10px;
      margin-bottom: 8px;
    }
    .stats-row {
      display: flex;
      justify-content: space-between;
      font-size: 11px;
      margin-bottom: 4px;
    }
    .stats-row:last-child { margin-bottom: 0; }
    .stats-label { opacity: 0.7; }
    .stats-value { font-weight: 600; }
    .stats-value.cost { color: var(--vscode-charts-green); }
    .hidden { display: none !important; }
  </style>
</head>
<body>
  <div id="status" class="status warning hidden"></div>

  <div class="section">
    <div class="section-title">Usage Stats</div>
    <div class="stats-card">
      <div class="stats-row">
        <span class="stats-label">Today Requests</span>
        <span class="stats-value" id="todayRequests">0</span>
      </div>
      <div class="stats-row">
        <span class="stats-label">Today Tokens</span>
        <span class="stats-value" id="todayTokens">0</span>
      </div>
      <div class="stats-row">
        <span class="stats-label">Today Cost</span>
        <span class="stats-value cost" id="todayCost">$0.000000</span>
      </div>
    </div>
    <div class="stats-card">
      <div class="stats-row">
        <span class="stats-label">Total Requests</span>
        <span class="stats-value" id="totalRequests">0</span>
      </div>
      <div class="stats-row">
        <span class="stats-label">Total Tokens</span>
        <span class="stats-value" id="totalTokens">0</span>
      </div>
      <div class="stats-row">
        <span class="stats-label">Total Cost</span>
        <span class="stats-value cost" id="totalCost">$0.000000</span>
      </div>
    </div>
    <button type="button" class="secondary" id="resetStatsBtn">Reset Stats</button>
  </div>

  <div class="section">
    <div class="section-title">AI Config</div>

    <div class="form-group">
      <label for="provider">Provider</label>
      <select id="provider">
        <option value="openrouter">OpenRouter</option>
        <option value="openai">OpenAI</option>
        <option value="claude">Claude</option>
        <option value="ollama">Ollama</option>
      </select>
    </div>

    <div class="form-group api-key-group" id="apiKeyGroup">
      <label for="apiKey">API Key</label>
      <input type="password" id="apiKey" placeholder="Enter new API Key" autocomplete="off">
      <button type="button" class="toggle-visibility" id="toggleApiKeyBtn" aria-label="Toggle API key visibility">*</button>
      <div class="api-key-hint" id="apiKeyHint"></div>
      <button type="button" class="secondary hidden" id="clearApiKeyBtn">Clear API Key</button>
    </div>

    <div class="form-group" id="modelGroup">
      <label for="model">Model</label>
      <select id="model">
        <option value="google/gemini-2.5-flash">Gemini 2.5 Flash (Recommended)</option>
        <option value="google/gemini-2.5-pro">Gemini 2.5 Pro</option>
        <option value="google/gemini-2.0-flash-001">Gemini 2.0 Flash</option>
        <option value="anthropic/claude-3-haiku">Claude 3 Haiku</option>
        <option value="anthropic/claude-3.5-sonnet">Claude 3.5 Sonnet</option>
        <option value="openai/gpt-4o-mini">GPT-4o Mini</option>
        <option value="openai/gpt-4o">GPT-4o</option>
        <option value="meta-llama/llama-3.1-8b-instruct">Llama 3.1 8B</option>
      </select>
    </div>
  </div>

  <div class="section">
    <div class="section-title">Behavior</div>

    <div class="form-group">
      <div class="checkbox-row">
        <input type="checkbox" id="autoRename" checked>
        <label for="autoRename">Auto rename terminals</label>
      </div>
    </div>

    <div class="form-group">
      <label for="threshold">Command threshold</label>
      <input type="number" id="threshold" min="1" max="10" value="3">
    </div>

    <div class="form-group">
      <label for="language">Language</label>
      <select id="language">
        <option value="zh">Chinese</option>
        <option value="en">English</option>
      </select>
    </div>
  </div>

  <button type="button" id="saveSettingsBtn">Save Settings</button>
  <button type="button" class="secondary" id="openFullSettingsBtn">Full Settings</button>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    let apiKeyConfigured = false;
    let clearRequested = false;

    function syncProviderUi() {
      const provider = document.getElementById('provider').value;
      const modelGroup = document.getElementById('modelGroup');
      const apiKeyGroup = document.getElementById('apiKeyGroup');
      modelGroup.classList.toggle('hidden', provider !== 'openrouter');
      apiKeyGroup.classList.toggle('hidden', provider === 'ollama');
    }

    function onProviderChange() {
      syncProviderUi();
      // Pending clear/replace must not apply to a different provider.
      clearRequested = false;
      document.getElementById('apiKey').value = '';
      apiKeyConfigured = false;
      updateApiKeyUi();
      const provider = document.getElementById('provider').value;
      if (provider !== 'ollama') {
        updateStatus(false);
      } else {
        document.getElementById('status').classList.add('hidden');
      }
    }

    function updateApiKeyUi() {
      const hint = document.getElementById('apiKeyHint');
      const clearBtn = document.getElementById('clearApiKeyBtn');
      const input = document.getElementById('apiKey');
      if (apiKeyConfigured && !clearRequested) {
        hint.textContent = 'API Key stored securely (enter a new value to replace)';
        input.placeholder = '•••••••• (saved — leave blank to keep)';
        clearBtn.classList.remove('hidden');
      } else if (clearRequested) {
        hint.textContent = 'API Key will be cleared on save';
        input.placeholder = 'Enter new API Key';
        clearBtn.classList.add('hidden');
      } else {
        hint.textContent = 'Stored in VS Code SecretStorage — never sent to the webview';
        input.placeholder = 'Enter new API Key';
        clearBtn.classList.add('hidden');
      }
    }

    function updateStatus(hasKey) {
      const status = document.getElementById('status');
      if (hasKey) {
        status.className = 'status success';
        status.textContent = 'API Key configured';
        status.classList.remove('hidden');
      } else {
        status.className = 'status warning';
        status.textContent = 'Please configure API Key';
        status.classList.remove('hidden');
      }
    }

    function formatCost(cost) {
      if (cost < 0.000001) return '$0.000000';
      return '$' + cost.toFixed(6);
    }

    function updateStats(stats) {
      document.getElementById('todayRequests').textContent = stats.todayRequests;
      document.getElementById('todayTokens').textContent = stats.todayTokens.toLocaleString();
      document.getElementById('todayCost').textContent = formatCost(stats.todayCost);
      document.getElementById('totalRequests').textContent = stats.totalRequests;
      document.getElementById('totalTokens').textContent = stats.totalTokens.toLocaleString();
      document.getElementById('totalCost').textContent = formatCost(stats.totalCost);
    }

    function saveSettings() {
      const provider = document.getElementById('provider').value;
      const settings = {
        provider: provider,
        autoRename: document.getElementById('autoRename').checked,
        commandThreshold: parseInt(document.getElementById('threshold').value, 10),
        language: document.getElementById('language').value
      };

      if (provider === 'openrouter') {
        settings.openrouterModel = document.getElementById('model').value;
      }

      const payload = { command: 'saveSettings', settings: settings };
      const typedKey = document.getElementById('apiKey').value;
      // A typed replacement wins over a prior Clear click.
      if (typedKey) {
        payload.apiKey = typedKey;
      } else if (clearRequested) {
        payload.apiKey = '';
      }

      vscode.postMessage(payload);
      clearRequested = false;
      document.getElementById('apiKey').value = '';
    }

    document.getElementById('provider').addEventListener('change', onProviderChange);
    document.getElementById('toggleApiKeyBtn').addEventListener('click', function () {
      const input = document.getElementById('apiKey');
      input.type = input.type === 'password' ? 'text' : 'password';
    });
    document.getElementById('apiKey').addEventListener('input', function () {
      if (document.getElementById('apiKey').value) {
        clearRequested = false;
        updateApiKeyUi();
      }
    });
    document.getElementById('clearApiKeyBtn').addEventListener('click', function () {
      clearRequested = true;
      document.getElementById('apiKey').value = '';
      updateApiKeyUi();
    });
    document.getElementById('saveSettingsBtn').addEventListener('click', saveSettings);
    document.getElementById('openFullSettingsBtn').addEventListener('click', function () {
      vscode.postMessage({ command: 'openFullSettings' });
    });
    document.getElementById('resetStatsBtn').addEventListener('click', function () {
      vscode.postMessage({ command: 'resetStats' });
    });

    window.addEventListener('message', function (event) {
      const message = event.data;
      if (message.command === 'loadSettings') {
        const s = message.settings;
        document.getElementById('provider').value = s.provider;
        document.getElementById('autoRename').checked = s.autoRename;
        document.getElementById('threshold').value = s.commandThreshold;
        document.getElementById('language').value = s.language;
        if (s.openrouterModel) {
          document.getElementById('model').value = s.openrouterModel;
        }
        apiKeyConfigured = !!s.apiKeyConfigured;
        clearRequested = false;
        document.getElementById('apiKey').value = '';
        updateApiKeyUi();
        if (s.provider !== 'ollama') {
          updateStatus(apiKeyConfigured);
        } else {
          document.getElementById('status').classList.add('hidden');
        }
        syncProviderUi();
      } else if (message.command === 'updateStats') {
        updateStats(message.stats);
      }
    });

    vscode.postMessage({ command: 'getSettings' });
  </script>
</body>
</html>`;
  }
}

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
