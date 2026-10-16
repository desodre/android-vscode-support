/** Waits `ms`, rejecting with `cancelledMessage` if `signal` aborts before or during the wait. */
export function sleep(ms: number, signal: AbortSignal | undefined, cancelledMessage: string): Promise<void> {
  if (signal?.aborted) { return Promise.reject(new Error(cancelledMessage)); }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(new Error(cancelledMessage));
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
}
