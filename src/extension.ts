import * as vscode from 'vscode';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { readCooler, type Region, type Summary } from './reader';

function escapeAttribute(value: string): string {
    return value.replace(/[&<>"]/g, character =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[character]!));
}

function render(webview: vscode.Webview, media: vscode.Uri, template: string): string {
    const resources: Record<string, string> = {
        cspSource: webview.cspSource,
        styleUri: webview.asWebviewUri(vscode.Uri.joinPath(media, 'viewer.css')).toString(),
        scriptUri: webview.asWebviewUri(vscode.Uri.joinPath(media, 'heatmap.js')).toString()
    };
    return template.replace(/\{\{(cspSource|styleUri|scriptUri)\}\}/g, (_, name: string) =>
        escapeAttribute(resources[name]));
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function isRegion(message: Record<string, unknown>): message is Record<string, unknown> & Region {
    return typeof message.chrom === 'string' &&
        Number.isSafeInteger(message.start) && Number.isSafeInteger(message.end) &&
        (message.display === null || Number.isSafeInteger(message.display)) &&
        (message.mode === 'raw' || message.mode === 'balanced');
}

async function saveHeatmap(source: vscode.Uri, title: string, region: unknown, dataUrl: unknown): Promise<void> {
    const prefix = 'data:image/png;base64,';
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith(prefix) || dataUrl.length > 6 * 1024 * 1024) {
        throw new Error('Could not encode this heatmap as PNG.');
    }
    const bytes = Buffer.from(dataUrl.slice(prefix.length), 'base64');
    const signature = Buffer.from('89504e470d0a1a0a', 'hex');
    if (!bytes.subarray(0, signature.length).equals(signature)) {
        throw new Error('The exported image is not a valid PNG.');
    }
    const stem = path.parse(title).name.replace(/[^a-z0-9._-]+/gi, '_').slice(0, 80);
    const suffix = typeof region === 'string' ? region.replace(/[^a-z0-9._-]+/gi, '_').slice(0, 100) : 'heatmap';
    const destination = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.joinPath(source, '..', `${stem}-${suffix}.png`),
        filters: { 'PNG image': ['png'] },
        saveLabel: 'Save PNG'
    });
    if (!destination) return;
    if (!/\.png$/i.test(destination.path)) {
        throw new Error('Choose a filename ending in .png.');
    }
    await vscode.workspace.fs.writeFile(destination, bytes);
    void vscode.window.showInformationMessage('Heatmap saved as PNG.');
}

export function activate(context: vscode.ExtensionContext): void {
    const media = vscode.Uri.joinPath(context.extensionUri, 'media');
    const template = readFileSync(vscode.Uri.joinPath(media, 'viewer.html').fsPath, 'utf8');
    const provider: vscode.CustomReadonlyEditorProvider = {
        openCustomDocument(uri) {
            return { uri, dispose() {} };
        },
        resolveCustomEditor({ uri }, panel) {
            const { webview } = panel;
            const title = path.basename(uri.fsPath);
            let summary: Summary | undefined;
            let metadataRequest: AbortController | undefined;
            let heatmapRequest: AbortController | undefined;
            let saving: Promise<void> | undefined;

            async function loadSummary(id?: number, size?: number): Promise<void> {
                metadataRequest?.abort();
                heatmapRequest?.abort();
                const request = new AbortController();
                metadataRequest = request;
                try {
                    if (uri.scheme !== 'file' && uri.scheme !== 'vscode-remote') {
                        throw new Error('Open a Cooler file from the local desktop or a remote workspace.');
                    }
                    let result: Summary;
                    try {
                        result = await readCooler(uri.fsPath, { type: 'summary', size }, request.signal);
                    } catch (error) {
                        if (id !== undefined || size === undefined || request.signal.aborted) throw error;
                        result = await readCooler(uri.fsPath, { type: 'summary' }, request.signal);
                    }
                    if (request.signal.aborted) return;
                    summary = result;
                    void webview.postMessage({ type: 'summary', id, title, summary });
                } catch (error) {
                    if (!request.signal.aborted) {
                        void webview.postMessage({ type: 'summary', id, title, error: errorMessage(error) });
                    }
                } finally {
                    if (metadataRequest === request) metadataRequest = undefined;
                }
            }

            async function loadHeatmap(id: number, size: number | null, region: Region): Promise<void> {
                heatmapRequest?.abort();
                const request = new AbortController();
                heatmapRequest = request;
                try {
                    const tile = await readCooler(uri.fsPath, { type: 'heatmap', size, region }, request.signal);
                    if (!request.signal.aborted) void webview.postMessage({ type: 'heatmap', id, tile });
                } catch (error) {
                    if (!request.signal.aborted) {
                        void webview.postMessage({ type: 'heatmap', id, error: errorMessage(error) });
                    }
                } finally {
                    if (heatmapRequest === request) heatmapRequest = undefined;
                }
            }

            const listener = webview.onDidReceiveMessage((message: unknown) => {
                if (typeof message !== 'object' || message === null) return;
                const data = message as Record<string, unknown>;
                if (data.type === 'ready') {
                    const size = typeof data.size === 'number' && Number.isSafeInteger(data.size) && data.size > 0
                        ? data.size : undefined;
                    void loadSummary(undefined, size);
                    return;
                }
                if (data.type === 'summary' && typeof data.id === 'number' && Number.isSafeInteger(data.id)) {
                    if (data.size === undefined) void loadSummary(data.id);
                    else if (typeof data.size === 'number' && summary?.levels.includes(data.size)) {
                        void loadSummary(data.id, data.size);
                    }
                    return;
                }
                if (!summary) return;
                if (data.type === 'heatmap' && !metadataRequest &&
                    typeof data.id === 'number' && Number.isSafeInteger(data.id) && isRegion(data)) {
                    const { chrom, start, end, mode, display } = data;
                    void loadHeatmap(data.id, summary.size, { chrom, start, end, mode, display });
                } else if (data.type === 'savePng') {
                    saving ??= saveHeatmap(uri, title, data.region, data.dataUrl).catch((error: unknown) => {
                        void vscode.window.showErrorMessage(`Could not save heatmap. ${errorMessage(error)}`);
                    }).finally(() => { saving = undefined; });
                }
            });

            panel.onDidDispose(() => {
                metadataRequest?.abort();
                heatmapRequest?.abort();
                listener.dispose();
            });
            webview.options = { enableScripts: true, localResourceRoots: [media] };
            webview.html = render(webview, media, template);
        }
    };
    context.subscriptions.push(vscode.window.registerCustomEditorProvider('mcool.reader', provider, {
        webviewOptions: { retainContextWhenHidden: true }
    }));
}
