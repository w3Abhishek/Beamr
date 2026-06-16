import * as vscode from 'vscode';
import * as mime from 'mime-types';
import * as path from 'path';

export function activate(context: vscode.ExtensionContext) {
  const provider = new BeamrWebviewViewProvider(context.extensionUri);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(BeamrWebviewViewProvider.viewType, provider)
  );

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

        // Focus the webview view
        await vscode.commands.executeCommand(`${BeamrWebviewViewProvider.viewType}.focus`);

        // Convert Uint8Array to base64 for safe transit
        // In Node/VSCode extension host we can use Buffer
        const base64Data = Buffer.from(bytes).toString('base64');

        provider.sendFileData({
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

class BeamrWebviewViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'beamr.sidebar';

  private _view?: vscode.WebviewView;
  private _isReady = false;
  private _pendingFileData?: any;

  constructor(
    private readonly _extensionUri: vscode.Uri,
  ) { }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ) {
    this._view = webviewView;
    this._isReady = false;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        this._extensionUri
      ]
    };

    webviewView.webview.onDidReceiveMessage(message => {
      if (message.type === 'ready') {
        this._isReady = true;
        if (this._pendingFileData) {
          this.sendFileData(this._pendingFileData);
          this._pendingFileData = undefined;
        }
      }
    });

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);
  }

  public sendFileData(fileData: any) {
    if (this._view && this._isReady) {
      this._view.webview.postMessage({ type: 'fileData', ...fileData });
    } else {
      this._pendingFileData = fileData;
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
        <!-- CSP allows local bundled scripts only -->
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <link href="${styleUri}" rel="stylesheet">
        <title>Beamr</title>
      </head>
      <body>
        <div id="ui-idle" class="screen active">
          <p class="hint">Select a file in the explorer and choose <strong>Share with Beamr</strong>.</p>
        </div>

        <div id="ui-active" class="screen">
          <div class="header">
            <div id="filename" class="mono">--</div>
            <div id="filesize" class="dim mono">-- bytes</div>
          </div>
          
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
          
          <div class="qr-container">
            <canvas id="qr-canvas"></canvas>
            <div id="progress-bar-bg" class="progress-bg"><div id="progress-bar" class="progress"></div></div>
          </div>
          
          <div class="stats mono">
            <div id="frame-counter">Frame -- / --</div>
            <div id="loop-counter" class="dim">Loop --</div>
            <div id="time-estimate" class="dim">Est. cycle: --</div>
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
