import * as vscode from 'vscode';
import { UsageTracker } from '../core';

/**
 * 侧边栏设置面板 Webview Provider
 */
export class SettingsSidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'terminalAiNamer.settingsView';
  private _view?: vscode.WebviewView;
  private _usageTracker?: UsageTracker;

  constructor(
    private readonly _extensionUri: vscode.Uri,
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
          break;
        case 'getSettings':
          this._sendCurrentSettings();
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

    this._sendCurrentSettings();
    this.updateStats();
  }

  private async _saveSettings(settings: Record<string, unknown>) {
    const config = vscode.workspace.getConfiguration('terminalAiNamer');
    for (const [key, value] of Object.entries(settings)) {
      await config.update(key, value, vscode.ConfigurationTarget.Global);
    }
  }

  private _sendCurrentSettings() {
    if (!this._view) return;

    const config = vscode.workspace.getConfiguration('terminalAiNamer');
    this._view.webview.postMessage({
      command: 'loadSettings',
      settings: {
        provider: config.get('provider', 'openrouter'),
        openrouterApiKey: config.get('openrouterApiKey', ''),
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

    <div class="form-group api-key-group">
      <label>API Key</label>
      <input type="password" id="apiKey" placeholder="Enter API Key">
      <button class="toggle-visibility" onclick="toggleApiKey()">*</button>
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

    function toggleApiKey() {
      const input = document.getElementById('apiKey');
      input.type = input.type === 'password' ? 'text' : 'password';
    }

    function onProviderChange() {
      const provider = document.getElementById('provider').value;
      const modelGroup = document.getElementById('modelGroup');
      modelGroup.style.display = provider === 'openrouter' ? 'block' : 'none';
    }

    function saveSettings() {
      const provider = document.getElementById('provider').value;
      const settings = {
        provider,
        autoRename: document.getElementById('autoRename').checked,
        commandThreshold: parseInt(document.getElementById('threshold').value),
        language: document.getElementById('language').value
      };

      const apiKey = document.getElementById('apiKey').value;
      if (provider === 'openrouter') {
        settings.openrouterApiKey = apiKey;
        settings.openrouterModel = document.getElementById('model').value;
      } else if (provider === 'openai') {
        settings.openaiApiKey = apiKey;
      } else if (provider === 'claude') {
        settings.claudeApiKey = apiKey;
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

    function updateStatus(hasKey) {
      const status = document.getElementById('status');
      if (hasKey) {
        status.className = 'status success';
        status.textContent = 'API Key configured';
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

        if (s.provider === 'openrouter') {
          document.getElementById('apiKey').value = s.openrouterApiKey || '';
          document.getElementById('model').value = s.openrouterModel;
          updateStatus(!!s.openrouterApiKey);
        }

        onProviderChange();
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
