import * as vscode from 'vscode';
import { UsageTracker } from '../core';
import {
  ApiKeyProvider,
  clearLegacyApiKeySettings,
  deleteApiKey,
  hasApiKey,
  setApiKey,
} from '../secrets';

/**
 * 侧边栏设置面板 Webview Provider
 */
export class SettingsSidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'terminalAiNamer.settingsView';
  private _view?: vscode.WebviewView;
  private _usageTracker?: UsageTracker;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _context: vscode.ExtensionContext,
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

    webviewView.webview.html = this._getHtmlContent();

    webviewView.webview.onDidReceiveMessage(async (message) => {
      switch (message.command) {
        case 'saveSettings':
          await this._saveSettings(message.settings);
          vscode.window.showInformationMessage('设置已保存');
          await this._sendCurrentSettings();
          break;
        case 'clearApiKey':
          await this._clearApiKey(message.provider);
          vscode.window.showInformationMessage('API Key 已清除');
          await this._sendCurrentSettings();
          break;
        case 'checkApiKey':
          await this._sendApiKeyStatus(message.provider);
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

  private _providerFromSettings(provider: unknown): ApiKeyProvider | undefined {
    if (provider === 'openrouter' || provider === 'openai' || provider === 'claude') {
      return provider;
    }
    return undefined;
  }

  private async _clearApiKey(provider: unknown) {
    const secretProvider = this._providerFromSettings(provider);
    if (!secretProvider) {
      return;
    }
    // Delete SecretStorage (+ tombstone) first so Clear succeeds even when some
    // retained legacy settings live in read-only workspace files. Best-effort
    // plaintext cleanup follows; remigration is blocked by the tombstone.
    await deleteApiKey(this._context, secretProvider);
    try {
      await clearLegacyApiKeySettings(secretProvider);
    } catch (error) {
      console.error('Failed to clear some legacy API key settings after delete:', error);
      vscode.window.showWarningMessage(
        'API Key cleared from SecretStorage, but some plaintext settings could not be removed (they may be read-only).'
      );
    }
  }

  private async _sendApiKeyStatus(provider: unknown) {
    if (!this._view) {
      return;
    }

    if (provider === 'ollama') {
      this._view.webview.postMessage({
        command: 'apiKeyStatus',
        provider,
        hasApiKey: true,
      });
      return;
    }

    const secretProvider = this._providerFromSettings(provider);
    const configured = secretProvider
      ? await hasApiKey(this._context, secretProvider)
      : false;

    this._view.webview.postMessage({
      command: 'apiKeyStatus',
      provider,
      hasApiKey: configured,
    });
  }

  private async _saveSettings(settings: Record<string, unknown>) {
    const config = vscode.workspace.getConfiguration('terminalAiNamer');
    const apiKeyFields: Record<string, ApiKeyProvider> = {
      openrouterApiKey: 'openrouter',
      openaiApiKey: 'openai',
      claudeApiKey: 'claude',
    };

    for (const [key, value] of Object.entries(settings)) {
      const secretProvider = apiKeyFields[key];
      if (secretProvider) {
        // Write-only: empty string means keep existing secret; never clear via blank field.
        // Explicit clear goes through the clearApiKey message instead.
        if (typeof value === 'string' && value.length > 0) {
          await setApiKey(this._context, secretProvider, value);
        }
        continue;
      }
      await config.update(key, value, vscode.ConfigurationTarget.Global);
    }
  }

  private async _sendCurrentSettings() {
    if (!this._view) return;

    const config = vscode.workspace.getConfiguration('terminalAiNamer');
    const provider = config.get<string>('provider', 'openrouter');
    const apiKeyConfigured =
      provider === 'ollama'
        ? true
        : await hasApiKey(
            this._context,
            provider === 'openai' || provider === 'claude' ? provider : 'openrouter'
          );

    this._view.webview.postMessage({
      command: 'loadSettings',
      settings: {
        provider,
        hasApiKey: apiKeyConfigured,
        openrouterModel: config.get('openrouterModel', 'google/gemini-2.5-flash'),
        autoRename: config.get('autoRename', true),
        commandThreshold: config.get('commandThreshold', 3),
        language: config.get('language', 'zh')
      }
    });
  }

  private _getHtmlContent(): string {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
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
    .toggle-visibility {
      position: absolute;
      right: 6px;
      top: 50%;
      transform: translateY(-50%);
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
    .hint {
      font-size: 11px;
      opacity: 0.7;
      margin-top: 4px;
    }
  </style>
</head>
<body>
  <div id="status" class="status warning" style="display:none;"></div>

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
    <button class="secondary" onclick="resetStats()">Reset Stats</button>
  </div>

  <div class="section">
    <div class="section-title">AI Config</div>

    <div class="form-group">
      <label>Provider</label>
      <select id="provider" onchange="onProviderChange()">
        <option value="openrouter">OpenRouter</option>
        <option value="openai">OpenAI</option>
        <option value="claude">Claude</option>
        <option value="ollama">Ollama</option>
      </select>
    </div>

    <div class="form-group api-key-group" id="apiKeyGroup">
      <label>API Key</label>
      <input type="password" id="apiKey" placeholder="Enter API Key" autocomplete="off">
      <button class="toggle-visibility" onclick="toggleApiKey()">*</button>
      <div class="hint" id="apiKeyHint" style="display:none;">Leave blank to keep the existing key.</div>
      <button class="secondary" id="clearApiKeyBtn" style="display:none; margin-top:8px;" onclick="clearApiKey()">Clear API Key</button>
    </div>

    <div class="form-group" id="modelGroup">
      <label>Model</label>
      <select id="model">
        <option value="google/gemini-2.5-flash">Gemini 2.5 Flash (Recommended)</option>
        <option value="google/gemini-2.5-pro">Gemini 2.5 Pro</option>
        <option value="google/gemini-2.0-flash-001">Gemini 2.0 Flash</option>
        <option value="anthropic/claude-3-haiku">Claude 3 Haiku</option>
        <option value="anthropic/claude-3.5-sonnet">Claude 3.5 Sonnet</option>
        <option value="openai/gpt-4o-mini">GPT-4o Mini</option>
        <option value="openai/gpt-4o">GPT-4o</option>
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
      <label>Command threshold</label>
      <input type="number" id="threshold" min="1" max="10" value="3">
    </div>

    <div class="form-group">
      <label>Language</label>
      <select id="language">
        <option value="zh">Chinese</option>
        <option value="en">English</option>
      </select>
    </div>
  </div>

  <button onclick="saveSettings()">Save Settings</button>
  <button class="secondary" onclick="openFullSettings()">Full Settings</button>

  <script>
    const vscode = acquireVsCodeApi();
    let hasExistingApiKey = false;

    function toggleApiKey() {
      const input = document.getElementById('apiKey');
      input.type = input.type === 'password' ? 'text' : 'password';
    }

    function syncProviderUi() {
      const provider = document.getElementById('provider').value;
      const modelGroup = document.getElementById('modelGroup');
      const apiKeyGroup = document.getElementById('apiKeyGroup');
      modelGroup.style.display = provider === 'openrouter' ? 'block' : 'none';
      apiKeyGroup.style.display = provider === 'ollama' ? 'none' : 'block';
    }

    function onProviderChange() {
      syncProviderUi();
      // Pending typed key must not apply to a different provider.
      document.getElementById('apiKey').value = '';
      const provider = document.getElementById('provider').value;
      if (provider === 'ollama') {
        updateStatus(true, { resetInput: true });
        return;
      }
      // Query SecretStorage for the newly selected provider instead of forcing missing.
      vscode.postMessage({ command: 'checkApiKey', provider });
    }

    function clearApiKey() {
      const provider = document.getElementById('provider').value;
      if (provider === 'ollama') {
        return;
      }
      vscode.postMessage({ command: 'clearApiKey', provider });
    }

    function saveSettings() {
      const provider = document.getElementById('provider').value;
      const settings = {
        provider,
        autoRename: document.getElementById('autoRename').checked,
        commandThreshold: parseInt(document.getElementById('threshold').value),
        language: document.getElementById('language').value
      };

      const apiKey = document.getElementById('apiKey').value.trim();
      if (provider === 'openrouter') {
        if (apiKey) {
          settings.openrouterApiKey = apiKey;
        }
        settings.openrouterModel = document.getElementById('model').value;
      } else if (provider === 'openai') {
        if (apiKey) {
          settings.openaiApiKey = apiKey;
        }
      } else if (provider === 'claude') {
        if (apiKey) {
          settings.claudeApiKey = apiKey;
        }
      }

      vscode.postMessage({ command: 'saveSettings', settings });
    }

    function openFullSettings() {
      vscode.postMessage({ command: 'openFullSettings' });
    }

    function resetStats() {
      vscode.postMessage({ command: 'resetStats' });
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

    function updateStatus(hasKey, options) {
      const resetInput = !!(options && options.resetInput);
      const status = document.getElementById('status');
      const hint = document.getElementById('apiKeyHint');
      const clearBtn = document.getElementById('clearApiKeyBtn');
      const input = document.getElementById('apiKey');
      const provider = document.getElementById('provider').value;
      hasExistingApiKey = !!hasKey;
      // Only wipe the password field on provider transitions / full settings reload /
      // completed save — never when an async apiKeyStatus reply arrives mid-typing.
      if (resetInput) {
        input.value = '';
      }
      input.placeholder = hasKey ? '•••••••• (saved securely)' : 'Enter API Key';
      hint.style.display = hasKey ? 'block' : 'none';
      clearBtn.style.display = hasKey && provider !== 'ollama' ? 'block' : 'none';
      if (provider === 'ollama') {
        status.style.display = 'none';
        return;
      }
      if (hasKey) {
        status.className = 'status success';
        status.textContent = 'API Key configured (SecretStorage)';
        status.style.display = 'block';
      } else {
        status.className = 'status warning';
        status.textContent = 'Please configure API Key';
        status.style.display = 'block';
      }
    }

    window.addEventListener('message', event => {
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

        updateStatus(!!s.hasApiKey, { resetInput: true });
        syncProviderUi();
      } else if (message.command === 'apiKeyStatus') {
        // Ignore stale replies if the user already changed selection again.
        if (message.provider !== document.getElementById('provider').value) {
          return;
        }
        // Preserve any in-progress typed key while the async status reply arrives.
        updateStatus(!!message.hasApiKey, { resetInput: false });
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
