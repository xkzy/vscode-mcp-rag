"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.deactivate = exports.activate = void 0;
// src/extension.ts
const vscode = __importStar(require("vscode"));
const axios_1 = __importDefault(require("axios"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const os = __importStar(require("os"));
// State
let serverUrl = 'http://localhost:8000';
let serverStatus = null;
let currentResults = [];
let queryHistory = [];
let axiosInstance;
let serverStatusCache = { status: null, timestamp: 0 };
const STATUS_CACHE_TTL = 5000; // 5 seconds cache
let abortController = null;
// Views
class CodeContextProvider {
    constructor() {
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    }
    refresh() {
        this._onDidChangeTreeData.fire();
    }
    getTreeItem(element) {
        return element;
    }
    getChildren(element) {
        if (element) {
            return Promise.resolve([]);
        }
        else {
            return Promise.resolve(currentResults.map((chunk, index) => new CodeChunkItem(`${chunk.file_path} (${chunk.start_line}-${chunk.end_line})`, chunk, index)));
        }
    }
}
class HistoryProvider {
    constructor() {
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    }
    refresh() {
        this._onDidChangeTreeData.fire();
    }
    getTreeItem(element) {
        return element;
    }
    getChildren(element) {
        if (element) {
            return Promise.resolve([]);
        }
        else {
            return Promise.resolve(queryHistory.map((query, index) => new HistoryItem(query, index)));
        }
    }
}
class CodeChunkItem extends vscode.TreeItem {
    constructor(label, chunk, index) {
        super(label, vscode.TreeItemCollapsibleState.None);
        this.label = label;
        this.chunk = chunk;
        this.index = index;
        this.iconPath = new vscode.ThemeIcon('code');
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
}
class HistoryItem extends vscode.TreeItem {
    constructor(label, index) {
        super(label, vscode.TreeItemCollapsibleState.None);
        this.label = label;
        this.index = index;
        this.iconPath = new vscode.ThemeIcon('history');
        this.contextValue = 'historyItem';
        // Set the command that is executed when the item is clicked
        this.command = {
            command: 'vscode-mcp-rag.repeatQuery',
            title: 'Repeat Query',
            arguments: [this.label]
        };
    }
}
// Providers
const contextProvider = new CodeContextProvider();
const historyProvider = new HistoryProvider();
// Initialize axios instance with timeout configuration
function initializeAxiosInstance() {
    axiosInstance = axios_1.default.create({
        timeout: 30000,
        headers: {
            'Content-Type': 'application/json'
        }
    });
}
// Utility functions
async function checkServerConnection(useCache = true) {
    // Use cached status if available and not expired
    if (useCache && serverStatusCache.status && Date.now() - serverStatusCache.timestamp < STATUS_CACHE_TTL) {
        serverStatus = serverStatusCache.status;
        return serverStatus.status === 'running';
    }
    try {
        const response = await axiosInstance.get(`${serverUrl}/status`);
        serverStatus = response.data;
        serverStatusCache = { status: serverStatus, timestamp: Date.now() };
        return response.data.status === 'running';
    }
    catch (error) {
        serverStatusCache = { status: null, timestamp: Date.now() };
        return false;
    }
}
async function searchCode(query, k = 5) {
    try {
        // Cancel any pending request
        if (abortController) {
            abortController.abort();
        }
        // Create new abort controller for this request
        abortController = new AbortController();
        const response = await axiosInstance.post(`${serverUrl}/query`, { query, k }, {
            signal: abortController.signal
        });
        abortController = null;
        return response.data.results || [];
    }
    catch (error) {
        if (axios_1.default.isCancel(error)) {
            vscode.window.showInformationMessage('Search cancelled');
            return [];
        }
        vscode.window.showErrorMessage(`Failed to search: ${error instanceof Error ? error.message : String(error)}`);
        return [];
    }
}
async function reindexProject(directory) {
    try {
        const data = {};
        if (directory) {
            data.directory = directory;
        }
        const response = await axiosInstance.post(`${serverUrl}/reindex`, data);
        return response.status === 200;
    }
    catch (error) {
        vscode.window.showErrorMessage(`Failed to reindex: ${error instanceof Error ? error.message : String(error)}`);
        return false;
    }
}
async function getFile(filePath) {
    try {
        const response = await axiosInstance.get(`${serverUrl}/file`, {
            params: { path: filePath }
        });
        return response.data.content;
    }
    catch (error) {
        vscode.window.showErrorMessage(`Failed to get file: ${error instanceof Error ? error.message : String(error)}`);
        return null;
    }
}
async function openChunk(chunk) {
    try {
        const uri = vscode.Uri.file(chunk.file_path);
        const document = await vscode.workspace.openTextDocument(uri);
        const editor = await vscode.window.showTextDocument(document);
        // Highlight the range
        const range = new vscode.Range(new vscode.Position(chunk.start_line - 1, 0), new vscode.Position(chunk.end_line - 1, document.lineAt(chunk.end_line - 1).text.length));
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
    }
    catch (error) {
        vscode.window.showErrorMessage(`Failed to open file: ${error instanceof Error ? error.message : String(error)}`);
    }
}
function saveContextToTemp(results) {
    const tempDir = os.tmpdir();
    const tempFilePath = path.join(tempDir, `mcp_context_${Date.now()}.md`);
    // Use array join for efficient string building
    const contentParts = ['# MCP Context\n\n'];
    for (let i = 0; i < results.length; i++) {
        const chunk = results[i];
        contentParts.push(`## Result ${i + 1}: ${chunk.file_path} (${chunk.start_line}-${chunk.end_line})\n`, `Type: ${chunk.chunk_type}, Score: ${chunk.score.toFixed(2)}\n\n`, '```\n', chunk.content, '\n```\n\n');
    }
    const content = contentParts.join('');
    // Use async file write with sync fallback for simplicity
    // In production, consider using promises API
    fs.writeFileSync(tempFilePath, content);
    return tempFilePath;
}
async function sendToCoder(query, contextFile) {
    const config = vscode.workspace.getConfiguration('vscode-mcp-rag');
    const coderPath = config.get('coderPath', 'coder');
    try {
        const terminal = vscode.window.createTerminal('Coder Agent');
        terminal.show();
        terminal.sendText(`${coderPath} --context "${contextFile}" "${query}"`);
    }
    catch (error) {
        vscode.window.showErrorMessage(`Failed to run Coder: ${error instanceof Error ? error.message : String(error)}`);
    }
}
// Helper function to get configuration values
function getConfig() {
    const config = vscode.workspace.getConfiguration('vscode-mcp-rag');
    return {
        serverUrl: config.get('serverUrl', 'http://localhost:8000'),
        coderPath: config.get('coderPath', 'coder'),
        maxResults: config.get('maxResults', 5)
    };
}
// Extension commands
async function connectToServer() {
    const config = getConfig();
    serverUrl = config.serverUrl;
    const isConnected = await checkServerConnection(false); // Force fresh check on explicit connect
    if (isConnected) {
        vscode.window.showInformationMessage(`Connected to MCP RAG server at ${serverUrl}`);
        vscode.commands.executeCommand('setContext', 'mcpConnected', true);
    }
    else {
        const result = await vscode.window.showErrorMessage(`Failed to connect to MCP RAG server at ${serverUrl}`, 'Change Server URL', 'Start Server');
        if (result === 'Change Server URL') {
            const newUrl = await vscode.window.showInputBox({
                prompt: 'Enter MCP server URL',
                value: serverUrl
            });
            if (newUrl) {
                await vscode.workspace.getConfiguration('vscode-mcp-rag').update('serverUrl', newUrl, true);
                serverUrl = newUrl;
                vscode.commands.executeCommand('vscode-mcp-rag.connect');
            }
        }
        else if (result === 'Start Server') {
            // Open terminal with command to start server
            const terminal = vscode.window.createTerminal('MCP RAG Server');
            terminal.show();
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
            if (workspaceFolder) {
                terminal.sendText(`python -m mcp_rag_server --dir "${workspaceFolder}" --port 8000`);
            }
            else {
                terminal.sendText('python -m mcp_rag_server --port 8000');
            }
            vscode.window.showInformationMessage('Starting MCP RAG server... Please connect again when server is running.');
        }
    }
}
async function searchCodeContext() {
    if (!await checkServerConnection()) {
        const answer = await vscode.window.showErrorMessage('Not connected to MCP RAG server', 'Connect Now');
        if (answer === 'Connect Now') {
            await connectToServer();
            if (!serverStatus)
                return;
        }
        else {
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
        if (!input)
            return;
        query = input;
    }
    // Add to history (limit to 10 items)
    const historyIndex = queryHistory.indexOf(query);
    if (historyIndex > -1) {
        queryHistory.splice(historyIndex, 1);
    }
    queryHistory.unshift(query);
    if (queryHistory.length > 10) {
        queryHistory = queryHistory.slice(0, 10);
    }
    historyProvider.refresh();
    // Show progress
    const config = getConfig();
    const results = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Searching for: ${query}`,
        cancellable: false
    }, async (progress) => {
        progress.report({ increment: 50 });
        const results = await searchCode(query, config.maxResults);
        progress.report({ increment: 50 });
        return results;
    });
    // Update results
    currentResults = results;
    contextProvider.refresh();
    if (results.length === 0) {
        vscode.window.showInformationMessage('No matching code found');
    }
    else {
        vscode.window.showInformationMessage(`Found ${results.length} relevant code chunks`);
    }
}
async function reindexProjectCommand() {
    if (!await checkServerConnection()) {
        const answer = await vscode.window.showErrorMessage('Not connected to MCP RAG server', 'Connect Now');
        if (answer === 'Connect Now') {
            await connectToServer();
            if (!serverStatus)
                return;
        }
        else {
            return;
        }
    }
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
    if (!workspaceFolder) {
        vscode.window.showErrorMessage('No workspace folder open');
        return;
    }
    const useWorkspace = await vscode.window.showQuickPick(['Yes, use workspace folder', 'No, specify custom folder'], { placeHolder: `Reindex ${workspaceFolder}?` });
    let directory = workspaceFolder;
    if (useWorkspace === 'No, specify custom folder') {
        const folderUri = await vscode.window.showOpenDialog({
            canSelectFolders: true,
            canSelectFiles: false,
            canSelectMany: false,
            openLabel: 'Select Folder to Index'
        });
        if (!folderUri || folderUri.length === 0)
            return;
        directory = folderUri[0].fsPath;
    }
    // Show progress
    const success = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Reindexing ${directory}`,
        cancellable: false
    }, async (progress) => {
        progress.report({ increment: 50 });
        const success = await reindexProject(directory);
        progress.report({ increment: 50 });
        return success;
    });
    if (success) {
        // Update server status (force fresh check)
        await checkServerConnection(false);
        vscode.window.showInformationMessage(`Successfully reindexed ${serverStatus?.num_chunks} code chunks from ${directory}`);
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
    if (!query)
        return;
    // Save context to temp file
    const contextFile = saveContextToTemp(currentResults);
    // Send to Coder
    await sendToCoder(query, contextFile);
}
async function repeatQuery(query) {
    await searchCode(query);
}
// Extension activation
function activate(context) {
    // Initialize axios instance
    initializeAxiosInstance();
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
    context.subscriptions.push(vscode.commands.registerCommand('vscode-mcp-rag.connect', connectToServer), vscode.commands.registerCommand('vscode-mcp-rag.search', searchCodeContext), vscode.commands.registerCommand('vscode-mcp-rag.reindex', reindexProjectCommand), vscode.commands.registerCommand('vscode-mcp-rag.sendToCoder', sendToCoderCommand), vscode.commands.registerCommand('vscode-mcp-rag.openChunk', openChunk), vscode.commands.registerCommand('vscode-mcp-rag.repeatQuery', repeatQuery));
    // Auto-connect to server
    connectToServer();
}
exports.activate = activate;
function deactivate() {
    // Clean up resources
    if (abortController) {
        abortController.abort();
        abortController = null;
    }
    // Clear caches
    serverStatusCache = { status: null, timestamp: 0 };
    currentResults = [];
    queryHistory = [];
}
exports.deactivate = deactivate;
//# sourceMappingURL=extension.js.map