// ─────────────────────────────────────────────────────────────────────────────
// NNTrainer Visualizer — extension.js
//
// WHAT THIS FILE DOES (C++ analogy):
//   This is the "host process". Runs in Node.js with full access to:
//   - Filesystem  (read .ini and .bin files)
//   - VS Code API (panels, dialogs, file watchers, sidebar tree)
//   - Webview IPC (postMessage to/from the HTML visualizer)
//
// TRIGGERS:
//   1. Right-click .ini → "Open in NNTrainer Visualizer"
//   2. Command palette / Ctrl+Shift+V
//   3. Auto-detect: notification pops when .ini opened in editor
//   4. Sidebar icon in activity bar → lists all .ini files in workspace
//
// BIN LOADING: always via manual OS file picker dialog
// ─────────────────────────────────────────────────────────────────────────────

const vscode = require('vscode');
const fs     = require('fs');
const path   = require('path');

// Global registry: iniPath → WebviewPanel
// Prevents duplicate panels for the same file
// Like std::map<string, Panel*>
const openPanels = new Map();

// ═════════════════════════════════════════════════════════════════════════════
// ACTIVATE
// ═════════════════════════════════════════════════════════════════════════════
function activate(context) {

  // ── TRIGGER 1: Right-click in file explorer ──────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('nntrainer.visualizeFromExplorer', (uri) => {
      if (!uri?.fsPath) return;
      openVisualizer(context, uri.fsPath);
    })
  );

  // ── TRIGGER 2: Command palette + Ctrl+Shift+V ────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('nntrainer.visualize', () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showErrorMessage('NNTrainer: Open a .ini model file first.');
        return;
      }
      if (!editor.document.uri.fsPath.endsWith('.ini')) {
        vscode.window.showErrorMessage('NNTrainer: Active file is not a .ini file.');
        return;
      }
      openVisualizer(context, editor.document.uri.fsPath);
    })
  );

  // ── TRIGGER 3: Auto-detect when .ini opened in editor ────────────────────
  // Fires every time any file is opened — we filter to .ini only
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((doc) => {
      if (!doc.uri.fsPath.endsWith('.ini')) return;

      // Only ask once per file per session
      const key = `nntrainer.asked.${doc.uri.fsPath}`;
      if (context.workspaceState.get(key)) return;
      context.workspaceState.update(key, true);

      // Quick check: does this look like an NNTrainer model?
      const text = doc.getText();
      const isModel = /\[Model\]/i.test(text) ||
        /type\s*=\s*(conv2d|fully_connected|input|embedding|lstm|attention|rms_norm)/i.test(text);
      if (!isModel) return;

      // Show a toast notification with action button
      vscode.window.showInformationMessage(
        `NNTrainer model detected: ${path.basename(doc.uri.fsPath)}`,
        'Open Visualizer', 'Dismiss'
      ).then(choice => {
        if (choice === 'Open Visualizer') openVisualizer(context, doc.uri.fsPath);
      });
    })
  );

  // ── TRIGGER 4: Sidebar tree view ─────────────────────────────────────────
  const sidebarProvider = new NNTrainerSidebarProvider(context);
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('nntrainerSidebar', sidebarProvider)
  );

  // Refresh button at top of sidebar panel
  context.subscriptions.push(
    vscode.commands.registerCommand('nntrainer.refreshSidebar', () => {
      sidebarProvider.refresh();
    })
  );

  // Called when user clicks a file in the sidebar
  context.subscriptions.push(
    vscode.commands.registerCommand('nntrainer.openFromSidebar', (item) => {
      openVisualizer(context, item.filePath);
    })
  );

  // Watch for new/deleted .ini files → refresh sidebar automatically
  const watcher = vscode.workspace.createFileSystemWatcher('**/*.ini');
  watcher.onDidCreate(() => sidebarProvider.refresh());
  watcher.onDidDelete(() => sidebarProvider.refresh());
  context.subscriptions.push(watcher);
}

// ═════════════════════════════════════════════════════════════════════════════
// SIDEBAR TREE PROVIDER
// Scans workspace for .ini files and lists them in the NNTrainer sidebar panel
// VS Code calls getChildren() to get the list, getTreeItem() to render each row
// ═════════════════════════════════════════════════════════════════════════════
class NNTrainerSidebarProvider {
  constructor(context) {
    this.context = context;
    // EventEmitter — fire this to tell VS Code to redraw the tree
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData  = this._onDidChangeTreeData.event;
  }

  refresh() { this._onDidChangeTreeData.fire(); }

  getTreeItem(element) { return element; }

  async getChildren(element) {
    if (element) return [];

    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.length) {
      const msg = new vscode.TreeItem('Open a folder to scan for models');
      msg.iconPath = new vscode.ThemeIcon('info');
      return [msg];
    }

    // find all .ini files in workspace (like: find . -name "*.ini" | head -100)
    const uris = await vscode.workspace.findFiles('**/*.ini', '**/node_modules/**', 100);
    if (!uris.length) {
      const msg = new vscode.TreeItem('No .ini files found in workspace');
      msg.iconPath = new vscode.ThemeIcon('info');
      return [msg];
    }

    // Filter: only files that contain NNTrainer model sections
    const modelFiles = [];
    for (const uri of uris) {
      try {
        const text = fs.readFileSync(uri.fsPath, 'utf-8');
        if (
          /\[Model\]/i.test(text) ||
          /type\s*=\s*(conv2d|fully_connected|input|embedding|lstm|attention)/i.test(text)
        ) modelFiles.push(uri);
      } catch (_) {}
    }

    if (!modelFiles.length) {
      const msg = new vscode.TreeItem('No NNTrainer model .ini files found');
      msg.iconPath = new vscode.ThemeIcon('info');
      return [msg];
    }

    // Build a TreeItem for each model file
    return modelFiles.map(uri => {
      const fileName  = path.basename(uri.fsPath);
      const parentDir = path.basename(path.dirname(uri.fsPath));

      const item           = new vscode.TreeItem(fileName, vscode.TreeItemCollapsibleState.None);
      item.description     = parentDir;             // greyed-out text on the right
      item.tooltip         = uri.fsPath;            // shown on hover
      item.contextValue    = 'iniFile';             // used in package.json menus
      item.filePath        = uri.fsPath;            // our custom property
      item.iconPath        = new vscode.ThemeIcon('circuit-board');

      // Single click → open visualizer
      item.command = {
        command:   'nntrainer.openFromSidebar',
        title:     'Open Visualizer',
        arguments: [item]
      };
      return item;
    });
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// OPEN VISUALIZER PANEL
// ═════════════════════════════════════════════════════════════════════════════
function openVisualizer(context, iniPath) {

  // Reuse existing panel if already open for this file
  if (openPanels.has(iniPath)) {
    openPanels.get(iniPath).reveal(vscode.ViewColumn.Beside);
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    'nntrainerVisualizer',
    `⬡ ${path.basename(iniPath)}`,
    vscode.ViewColumn.Beside,
    {
      enableScripts:           true,
      retainContextWhenHidden: true,
      localResourceRoots: [
        vscode.Uri.file(path.join(context.extensionPath, 'media'))
      ]
    }
  );

  openPanels.set(iniPath, panel);
  panel.onDidDispose(() => openPanels.delete(iniPath));
  panel.webview.html = getWebviewHtml(context, panel.webview);

  // ── Messages from webview → extension ────────────────────────────────────
  panel.webview.onDidReceiveMessage(async (msg) => {
    switch (msg.type) {
      case 'READY':
        // Webview is ready — send the .ini file text
        sendIniFile(panel, iniPath);
        break;

      case 'PICK_BIN':
        // Webview wants user to pick a .bin file
        await pickAndLoadBin(panel, iniPath, msg.layers);
        break;
    }
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// SEND .INI FILE TEXT TO WEBVIEW
// ═════════════════════════════════════════════════════════════════════════════
function sendIniFile(panel, iniPath) {
  try {
    const text = fs.readFileSync(iniPath, 'utf-8');
    panel.webview.postMessage({
      type: 'INI_TEXT',
      data: { text, fileName: path.basename(iniPath) }
    });
  } catch (err) {
    panel.webview.postMessage({
      type: 'ERROR',
      data: { message: `Cannot read .ini file:\n${err.message}` }
    });
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// MANUAL .BIN FILE PICKER
// Shows OS file picker → reads file → parses weights → sends stats to webview
// ═════════════════════════════════════════════════════════════════════════════
async function pickAndLoadBin(panel, iniPath, layers) {
  const uris = await vscode.window.showOpenDialog({
    canSelectFiles:   true,
    canSelectMany:    false,
    canSelectFolders: false,
    filters:          { 'NNTrainer Weight Files': ['bin'] },
    defaultUri:       vscode.Uri.file(path.dirname(iniPath)),
    openLabel:        'Load Weights'
  });

  if (!uris?.[0]) return; // user cancelled

  const binPath = uris[0].fsPath;

  panel.webview.postMessage({
    type: 'BIN_START',
    data: { fileName: path.basename(binPath) }
  });

  await parseBinAndSend(panel, binPath, layers);
}

// ═════════════════════════════════════════════════════════════════════════════
// BIN PARSER
// Reads sequential float32 tensors, computes stats per tensor
// ═════════════════════════════════════════════════════════════════════════════
async function parseBinAndSend(panel, binPath, layers) {
  try {
    const fileSize = fs.statSync(binPath).size;
    const fd       = fs.openSync(binPath, 'r');
    const result   = {};
    let   offset   = 0;

    for (let i = 0; i < layers.length; i++) {
      const layer = layers[i];

      panel.webview.postMessage({
        type: 'BIN_PROGRESS',
        data: { pct: Math.round((i / layers.length) * 100), layerName: layer.fullName }
      });

      // Yield every 20 layers so the UI stays responsive
      if (i % 20 === 0) await sleep(0);

      const tensorStats = [];

      for (const tensor of layer.weightTensors) {
        if (!tensor.bytes || offset + tensor.bytes > fileSize) {
          tensorStats.push(null); continue;
        }

        // Read tensor.bytes bytes at position offset
        // C equivalent: fseek(fd, offset, SEEK_SET); fread(buf, 1, bytes, fd);
        const buf = Buffer.alloc(tensor.bytes);
        fs.readSync(fd, buf, 0, tensor.bytes, offset);
        offset += tensor.bytes;

        // Reinterpret as float32 — like (float*)buf in C
        const count = tensor.bytes / 4;
        const f32   = new Float32Array(buf.buffer, buf.byteOffset, count);

        // Pass 1: min, max, mean
        let mn = Infinity, mx = -Infinity, sum = 0;
        for (let j = 0; j < f32.length; j++) {
          if (f32[j] < mn) mn = f32[j];
          if (f32[j] > mx) mx = f32[j];
          sum += f32[j];
        }
        const mean = sum / f32.length;

        // Pass 2: std deviation
        let variance = 0;
        for (let j = 0; j < f32.length; j++) variance += (f32[j] - mean) ** 2;
        const std = Math.sqrt(variance / f32.length);

        // Pass 3: 24-bin histogram
        const BINS = 24, hist = new Array(BINS).fill(0);
        const range = (mx - mn) || 1e-9;
        for (let j = 0; j < f32.length; j++) {
          hist[Math.min(BINS - 1, Math.floor(((f32[j] - mn) / range) * BINS))]++;
        }

        tensorStats.push({ name: tensor.name, shape: tensor.shape, min: mn, max: mx, mean, std, hist, count: f32.length });
      }

      if (tensorStats.some(Boolean)) result[layer.id] = tensorStats.filter(Boolean);
    }

    fs.closeSync(fd);

    panel.webview.postMessage({
      type: 'BIN_LOADED',
      data: { stats: result, fileName: path.basename(binPath), fileSize }
    });

  } catch (err) {
    panel.webview.postMessage({
      type: 'ERROR',
      data: { message: `Failed to parse .bin:\n${err.message}` }
    });
  }
}

// ─── Utilities ────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

function getNonce() {
  let n = '';
  const c = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) n += c[Math.floor(Math.random() * c.length)];
  return n;
}

function getWebviewHtml(context, webview) {
  const htmlPath = path.join(context.extensionPath, 'media', 'visualizer.html');
  let   html     = fs.readFileSync(htmlPath, 'utf-8');
  const nonce    = getNonce();
  const mediaUri = webview.asWebviewUri(vscode.Uri.file(path.join(context.extensionPath, 'media')));
  html = html.replace(/\$\{nonce\}/g,    nonce);
  html = html.replace(/\$\{mediaUri\}/g, mediaUri.toString());
  return html;
}

function deactivate() {}
module.exports = { activate, deactivate };
