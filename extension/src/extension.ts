import * as vscode from 'vscode';
import * as mime from 'mime-types';
import * as path from 'path';
import AdmZip = require('adm-zip');

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
        
        let bytes: Uint8Array;
        let filename: string;
        let mimeType: string;
        let finalSize: number;

        if (stat.type === vscode.FileType.Directory) {
          vscode.window.showInformationMessage(`Compressing folder ${path.basename(uri.fsPath)}...`);
          const zip = new AdmZip();
          zip.addLocalFolder(uri.fsPath);
          const zipBuffer = zip.toBuffer();
          bytes = new Uint8Array(zipBuffer);
          filename = path.basename(uri.fsPath) + '.zip';
          mimeType = 'application/zip';
          finalSize = bytes.length;
        } else {
          bytes = await vscode.workspace.fs.readFile(uri);
          filename = path.basename(uri.fsPath);
          mimeType = mime.lookup(filename) || 'application/octet-stream';
          finalSize = stat.size;
        }

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
          size: finalSize,
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
    const logoUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'logo.svg'));

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
          <div class="logo-container">
            <img src="${logoUri}" alt="Beamr Logo" width="48" height="48" />
            <h2>Beamr</h2>
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

        <footer class="footer">
          <div class="footer-content">
            <span>Crafted by Abhishek</span>
            <div class="social-links">
              <a href="https://github.com/w3abhishek" target="_blank" rel="noopener noreferrer" aria-label="GitHub">
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22"></path></svg>
              </a>
              <a href="https://x.com/pyvrma" target="_blank" rel="noopener noreferrer" aria-label="X (Twitter)">
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 4s-.7 2.1-2 3.4c1.6 10-9.4 17.3-18 11.6 2.2.1 4.4-.6 6-2C3 15.5.5 9.6 3 5c2.2 2.6 5.6 4.1 9 4-.9-4.2 4-6.6 7-3.8 1.1 0 3-1.2 3-1.2z"></path></svg>
              </a>
            </div>
          </div>
        </footer>

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
