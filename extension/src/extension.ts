import * as vscode from 'vscode';
import * as mime from 'mime-types';
import * as path from 'path';

let currentPanel: BeamrWebviewPanel | undefined = undefined;

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand('beamr.sendFile', async (uri: vscode.Uri) => {
      // If the command is triggered from command palette without uri, ask user to select a file
      if (!uri) {
        const uris = await vscode.window.showOpenDialog({
          canSelectMany: false,
          openLabel: 'Select file to share'
        });
        if (uris && uris[0]) {
          uri = uris[0];
        } else {
          return;
        }
      }

      try {
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.type === vscode.FileType.Directory) {
          vscode.window.showErrorMessage('Beamr can only send files, not directories.');
          return;
        }

        const bytes = await vscode.workspace.fs.readFile(uri);
        const filename = path.basename(uri.fsPath);
        const mimeType = mime.lookup(filename) || 'text/plain';

        const base64Data = Buffer.from(bytes).toString('base64');

        if (currentPanel) {
          currentPanel.reveal();
        } else {
          currentPanel = new BeamrWebviewPanel(context.extensionUri);
          currentPanel.onDidDispose(() => {
            currentPanel = undefined;
          });
        }

        currentPanel.sendFileData({
          filename,
          size: stat.size,
          mimeType,
          data: base64Data
        });

      } catch (err: any) {
        vscode.window.showErrorMessage(`Beamr failed to read file: ${err.message}`);
      }
    })
  );
}

class BeamrWebviewPanel {
  public readonly panel: vscode.WebviewPanel;
  private _isReady = false;
  private _pendingFileData?: any;
  private _disposables: vscode.Disposable[] = [];

  constructor(private readonly _extensionUri: vscode.Uri) {
    this.panel = vscode.window.createWebviewPanel(
      'beamrPanel',
      'Beamr Transfer',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        localResourceRoots: [this._extensionUri]
      }
    );

    this.panel.webview.html = this._getHtmlForWebview(this.panel.webview);

    this.panel.webview.onDidReceiveMessage(message => {
      if (message.type === 'ready') {
        this._isReady = true;
        if (this._pendingFileData) {
          this.sendFileData(this._pendingFileData);
          this._pendingFileData = undefined;
        }
      }
    }, null, this._disposables);

    this.panel.onDidDispose(() => this.dispose(), null, this._disposables);
  }

  public sendFileData(fileData: any) {
    if (this._isReady) {
      this.panel.webview.postMessage({ type: 'fileData', ...fileData });
    } else {
      this._pendingFileData = fileData;
    }
  }

  public reveal() {
    this.panel.reveal();
  }

  public onDidDispose(cb: () => void) {
    this._disposables.push({ dispose: cb });
  }

  public dispose() {
    this.panel.dispose();
    while (this._disposables.length) {
      const x = this._disposables.pop();
      if (x) {
        x.dispose();
      }
    }
  }

  private _getHtmlForWebview(webview: vscode.Webview) {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'sender.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'sender.css'));
    const qrcodeUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'qrcode.min.js'));
    const pakoUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'pako.min.js'));

    const nonce = getNonce();

    return `<!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <link href="${styleUri}" rel="stylesheet">
        <title>Beamr</title>
      </head>
      <body>
        <div id="ui-idle" class="screen active">
          <div style="display: flex; align-items: center; justify-content: center; gap: 8px; margin-bottom: 16px;">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"></path>
              <polyline points="16 6 12 2 8 6"></polyline>
              <line x1="12" y1="2" x2="12" y2="15"></line>
            </svg>
            <h2 style="margin: 0; font-family: var(--font-sans);">Beamr</h2>
          </div>
          <p class="hint">Select a file in the explorer and choose<br><strong>Share with Beamr</strong>.</p>
        </div>

        <div id="ui-active" class="screen">
          <div class="content-wrapper">
            <div class="header">
              <div id="filename" class="mono">--</div>
              <div id="filesize" class="dim mono">-- bytes</div>
            </div>
            
            <div class="main-layout">
              <div class="qr-column">
                <div class="qr-container">
                  <canvas id="qr-canvas"></canvas>
                  <div id="progress-bar-bg" class="progress-bg"><div id="progress-bar" class="progress"></div></div>
                </div>
              </div>
              
              <div class="controls-column">
                <div class="controls">
                  <div class="control-row">
                    <label>Interval (<span id="interval-val">300</span>ms)</label>
                    <input type="range" id="interval-slider" min="150" max="800" step="50" value="300">
                  </div>
                  <div class="control-row">
                    <label>Chunk Size (<span id="chunk-val">700</span>)</label>
                    <input type="range" id="chunk-slider" min="200" max="1500" step="50" value="700">
                  </div>
                  
                  <button id="toggle-btn" class="btn primary">Start Transfer</button>
                </div>
                
                <div class="stats mono">
                  <div id="frame-counter">Frame -- / --</div>
                  <div id="loop-counter" class="dim">Loop --</div>
                  <div id="time-estimate" class="dim">Est. cycle: --</div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <script nonce="${nonce}" src="${qrcodeUri}"></script>
        <script nonce="${nonce}" src="${pakoUri}"></script>
        <script nonce="${nonce}" src="${scriptUri}"></script>
      </body>
      </html>`;
  }
}

function getNonce() {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
