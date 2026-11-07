import * as vscode from 'vscode';
import * as path from 'path';

/*
 * Facts about how the extension was started, captured once in activate(), so
 * modules that are not handed the extension context (the rule processors) can
 * still honor the user's settings.
 */

let extensionMode: vscode.ExtensionMode = vscode.ExtensionMode.Production;
let globalStoragePath = '';

export function initRuntime(context: vscode.ExtensionContext): void {
    extensionMode = context.extensionMode;
    globalStoragePath = context.globalStorageUri.fsPath;
}

/** True in an Extension Development Host (F5), where study runs happen. */
export function isDevelopmentHost(): boolean {
    return extensionMode === vscode.ExtensionMode.Development;
}

/**
 * Folder that receives accepted-fix records, or undefined when recording is
 * off. Installed copies record nothing unless designfix.fixLogs.enabled is
 * set. An Extension Development Host records by default, into <repo-root>/data,
 * so the study workflow keeps working unchanged.
 */
export function resolveFixLogRoot(): string | undefined {
    const config = vscode.workspace.getConfiguration('designfix');
    const setting = config.inspect<boolean>('fixLogs.enabled');
    const explicit = setting?.workspaceFolderValue ?? setting?.workspaceValue ?? setting?.globalValue;
    if (!(explicit ?? isDevelopmentHost())) {
        return undefined;
    }

    const configured = (config.get<string>('fixLogs.directory') ?? '').trim();
    if (configured) {
        if (path.isAbsolute(configured)) {
            return configured;
        }
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        return workspaceRoot ? path.join(workspaceRoot, configured) : path.resolve(configured);
    }
    if (isDevelopmentHost()) {
        // <repo-root>/DesignFix-Extension/out -> up two levels -> repo root.
        return path.join(__dirname, '..', '..', 'data');
    }
    return path.join(globalStoragePath, 'fix-logs');
}
