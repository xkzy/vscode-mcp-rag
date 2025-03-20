// src/extension.ts
import * as vscode from 'vscode';
import axios from 'axios';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Types
interface CodeChunk {
  content: string;
  file_path: string;
  start_line: number;
  end_line: number;
  chunk_type: string;
  parent_name?: string;
  score: number;
}

interface ServerStatus {
  status: string;
  project_dir: string;
  num_chunks: number;
}

// State
let serverUrl: string = 'http://localhost:8000';
let serverStatus: ServerStatus | null = null;
let currentResults: CodeChunk[] = [];
let queryHistory: string[] = [];

// Views
class CodeContextProvider implements vscode.TreeDataProvider<CodeChunkItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<CodeChunkItem | undefined | null | void> = new vscode.EventEmitter<CodeChunkItem | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<CodeChunkItem | undefined | null | void> = this._onDidChangeTreeData.event;

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: CodeChunkItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: CodeChunkItem): Thenable<CodeChunkItem[]> {
    if (element) {
      return Promise.resolve([]);
    } else {
      return Promise.resolve(
        currentResults.map(
          (chunk, index) => new CodeChunkItem(
            `${chunk.file_path} (${chunk.start_line}-${chunk.end_line})`,
            chunk,
            index
          )
        )
      );
    }
  }
}

class HistoryProvider implements vscode.TreeDataProvider<HistoryItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<HistoryItem | undefined | null | void> = new vscode.EventEmitter<HistoryItem | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<HistoryItem | undefined | null | void> = this._onDidChangeTreeData.event;

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: HistoryItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: HistoryItem): Thenable<HistoryItem[]> {
    if (element) {
      return Promise.resolve([]);
    } else {
      return Promise.resolve(
        queryHistory.map(
          (query, index) => new HistoryItem(query, index)
        )
      );
    }
  }
}

class CodeChunkItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly chunk: CodeChunk,
    public readonly index: number
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.tooltip = `${chunk.chunk_type} - Score: ${chunk.score.toFixed(2)}`;
    this.description = chunk.chunk_type;
    this.contextValue = 'codeChunk';
    
    // Set the command that is executed when the item is clicked
    this.command = {
      command: 'vscode-mcp-rag.openChunk',
      title: 'Open Code Chunk',
      arguments: [this.chunk]
    };
  }

  iconPath = new vscode.ThemeIcon('code');
}

class HistoryItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly index: number
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'historyItem';
    
    // Set the command that is executed when the item is clicked
    this.command = {
      command: 'vscode-mcp-rag.repeatQuery',
      title: 'Repeat Query',
      arguments: [this.label]
    };
  }

  iconPath = new vscode.ThemeIcon('history');
}

// Providers
const contextProvider = new CodeContextProvider();
const historyProvider = new HistoryProvider();

// Utility functions
async function checkServerConnection(): Promise<boolean> {
  try {
    const response = await axios.get(`${serverUrl}/status`);
    serverStatus = response.data;
    return response.data.status === 'running';
  } catch (error) {
    return false;
  }
}

async function searchCode(query: string, k: number = 5): Promise<CodeChunk[]> {
  try {
    const response = await axios.post(`${serverUrl}/query`, { query, k });
    return response.data.results || [];
  } catch (error) {
    vscode.window.showErrorMessage(`Failed to search: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

async function reindexProject(directory?: string): Promise<boolean> {
  try {
    const data: any = {};
    if (directory) {
      data.directory = directory;
    }
    
    const response = await axios.post(`${serverUrl}/reindex`, data);
    return response.status === 200;
  } catch (error) {
    vscode.window.showErrorMessage(`Failed to reindex: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

async function getFile(filePath: string): Promise<string | null> {
  try {
    const response = await axios.get(`${serverUrl}/file`, {
      params: { path: filePath }
    });
    return response.data.content;
  } catch (error) {
    vscode.window.showErrorMessage(`Failed to get file: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

async function openChunk(chunk: CodeChunk): Promise<void> {
  try {
    const uri = vscode.Uri.file(chunk.file_path);
    const document = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(document);
    
    // Highlight the range
    const range = new vscode.Range(
      new vscode.Position(chunk.start_line - 1, 0),
      new vscode.Position(chunk.end_line - 1, document.lineAt(chunk.end_line - 1).text.length)
    );
    
    editor.selection = new vscode.Selection(range.start, range.start);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
    
    // Highlight the range
    const decoration = vscode.window.createTextEditorDecorationType({
      backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
      isWholeLine: true
    });
    
    editor.setDecorations(decoration, [range]);
    
    // Remove the decoration after 3 seconds
    setTimeout(() => {
      decoration.dispose();
    }, 3000);
  } catch (error) {
    vscode.window.showErrorMessage(`Failed to open file: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function saveContextToTemp(results: CodeChunk[]): string {
  const tempDir = os.tmpdir();
  const tempFilePath = path.join(tempDir, `mcp_context_${Date.now()}.md`);
  
  let content = '# MCP Context\n\n';
  
  for (let i = 0; i < results.length; i++) {
    const chunk = results[i];
    content += `## Result ${i+1}: ${chunk.file_path} (${chunk.start_line}-${chunk.end_line})\n`;
    content += `Type: ${chunk.chunk_type}, Score: ${chunk.score.toFixed(2)}\n\n`;
    content += '```\n';
    content += chunk.content;
    content += '\n```\n\n';
  }
  
  fs.writeFileSync(tempFilePath, content);
  return tempFilePath;
}

async function sendToCoder(query: string, contextFile: string): Promise<void> {
  const config = vscode.workspace.getConfiguration('vscode-mcp-rag');
  const coderPath = config.get<string>('coderPath', 'coder');
  
  try {
    const terminal = vscode.window.createTerminal('Coder Agent');
    terminal.show();
    terminal.sendText(`${coderPath} --context "${contextFile}" "${query}"`);
  } catch (error) {
    vscode.window.showErrorMessage(`Failed to run Coder: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// Extension commands
async function connectToServer() {
  const config = vscode.workspace.getConfiguration('vscode-mcp-rag');
  serverUrl = config.get<string>('serverUrl', 'http://localhost:8000');
  
  const isConnected = await checkServerConnection();
  
  if (isConnected) {
    vscode.window.showInformationMessage(`Connected to MCP RAG server at ${serverUrl}`);
    vscode.commands.executeCommand('setContext', 'mcpConnected', true);
  } else {
    const result = await vscode.window.showErrorMessage(
      `Failed to connect to MCP RAG server at ${serverUrl}`,
      'Change Server URL',
      'Start Server'
    );
    
    if (result === 'Change Server URL') {
      const newUrl = await vscode.window.showInputBox({
        prompt: 'Enter MCP server URL',
        value: serverUrl
      });
      
      if (newUrl) {
        config.update('serverUrl', newUrl, true);
        serverUrl = newUrl;
        vscode.commands.executeCommand('vscode-mcp-rag.connect');
      }
    } else if (result === 'Start Server') {
      // Open terminal with command to start server
      const terminal = vscode.window.createTerminal('MCP RAG Server');
      terminal.show();
      
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
      if (workspaceFolder) {
        terminal.sendText(`python -m mcp_rag_server --dir "${workspaceFolder}" --port 8000`);
      } else {
        terminal.sendText('python -m mcp_rag_server --port 8000');
      }
      
      vscode.window.showInformationMessage('Starting MCP RAG server... Please connect again when server is running.');
    }
  }
}

async function searchCodeContext() {
  if (!await checkServerConnection()) {
    const answer = await vscode.window.showErrorMessage(
      'Not connected to MCP RAG server',
      'Connect Now'
    );
    
    if (answer === 'Connect Now') {
      await connectToServer();
      if (!serverStatus) return;
    } else {
      return;
    }
  }
  
  // Get the selected text or ask for a query
  let query = '';
  const editor = vscode.window.activeTextEditor;
  
  if (editor && !editor.selection.isEmpty) {
    query = editor.document.getText(editor.selection);
  }
  
  if (!query) {
    const input = await vscode.window.showInputBox({
      prompt: 'Enter search query',
      placeHolder: 'e.g., "How to handle user authentication"'
    });
    
    if (!input) return;
    query = input;
  }
  
  // Add to history
  queryHistory.unshift(query);
  if (queryHistory.length > 10) {
    queryHistory.pop();
  }
  historyProvider.refresh();
  
  // Show progress
  const results = await vscode.window.withProgress<CodeChunk[]>(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Searching for: ${query}`,
      cancellable: false
    },
    async (progress) => {
      progress.report({ increment: 50 });
      const config = vscode.workspace.getConfiguration('vscode-mcp-rag');
      const maxResults = config.get<number>('maxResults', 5);
      
      const results = await searchCode(query, maxResults);
      progress.report({ increment: 50 });
      return results;
    }
  );
  
  // Update results
  currentResults = results;
  contextProvider.refresh();
  
  if (results.length === 0) {
    vscode.window.showInformationMessage('No matching code found');
  } else {
    vscode.window.showInformationMessage(`Found ${results.length} relevant code chunks`);
  }
}

async function reindexProjectCommand() {
  if (!await checkServerConnection()) {
    const answer = await vscode.window.showErrorMessage(
      'Not connected to MCP RAG server',
      'Connect Now'
    );
    
    if (answer === 'Connect Now') {
      await connectToServer();
      if (!serverStatus) return;
    } else {
      return;
    }
  }
  
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
  
  if (!workspaceFolder) {
    vscode.window.showErrorMessage('No workspace folder open');
    return;
  }
  
  const useWorkspace = await vscode.window.showQuickPick(
    ['Yes, use workspace folder', 'No, specify custom folder'],
    { placeHolder: `Reindex ${workspaceFolder}?` }
  );
  
  let directory = workspaceFolder;
  
  if (useWorkspace === 'No, specify custom folder') {
    const folderUri = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: false,
      openLabel: 'Select Folder to Index'
    });
    
    if (!folderUri || folderUri.length === 0) return;
    directory = folderUri[0].fsPath;
  }
  
  // Show progress
  const success = await vscode.window.withProgress<boolean>(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Reindexing ${directory}`,
      cancellable: false
    },
    async (progress) => {
      progress.report({ increment: 50 });
      const success = await reindexProject(directory);
      progress.report({ increment: 50 });
      return success;
    }
  );
  
  if (success) {
    // Update server status
    await checkServerConnection();
    vscode.window.showInformationMessage(
      `Successfully reindexed ${serverStatus?.num_chunks} code chunks from ${directory}`
    );
  }
}

async function sendToCoderCommand() {
  if (currentResults.length === 0) {
    vscode.window.showWarningMessage('No code context available. Please search first.');
    return;
  }
  
  const query = await vscode.window.showInputBox({
    prompt: 'Enter your request for the Coder agent',
    placeHolder: 'e.g., "Create a new API endpoint based on these examples"'
  });
  
  if (!query) return;
  
  // Save context to temp file
  const contextFile = saveContextToTemp(currentResults);
  
  // Send to Coder
  await sendToCoder(query, contextFile);
}

async function repeatQuery(query: string) {
  await searchCode(query);
}

// Extension activation
export function activate(context: vscode.ExtensionContext) {
  // Register views
  vscode.window.createTreeView('mcpContextView', {
    treeDataProvider: contextProvider,
    showCollapseAll: true
  });
  
  vscode.window.createTreeView('mcpHistoryView', {
    treeDataProvider: historyProvider,
    showCollapseAll: true
  });
  
  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('vscode-mcp-rag.connect', connectToServer),
    vscode.commands.registerCommand('vscode-mcp-rag.search', searchCodeContext),
    vscode.commands.registerCommand('vscode-mcp-rag.reindex', reindexProjectCommand),
    vscode.commands.registerCommand('vscode-mcp-rag.sendToCoder', sendToCoderCommand),
    vscode.commands.registerCommand('vscode-mcp-rag.openChunk', openChunk),
    vscode.commands.registerCommand('vscode-mcp-rag.repeatQuery', repeatQuery)
  );
  
  // Auto-connect to server
  connectToServer();
}

export function deactivate() {
  // Clean up resources
}