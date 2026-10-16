import * as vscode from 'vscode';

/** Runs `task` under a cancellable notification; cancelling the notification aborts the signal. */
export async function withCancellableProgress<T>(title: string, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
  return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: true },
    async (_progress, token) => {
      const controller = new AbortController();
      const subscription = token.onCancellationRequested(() => controller.abort());
      try { return await task(controller.signal); }
      finally { subscription.dispose(); }
    });
}

/** Gradle, emulators and devices run project code; only a trusted workspace may start them. */
export function requireTrust(action: string): void {
  if (!vscode.workspace.isTrusted) { throw new Error(`Confie na pasta de trabalho antes de ${action}.`); }
}
