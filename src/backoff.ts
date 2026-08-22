export function backoffMs(attempt: number, baseMs: number, maxMs: number, random = Math.random): number {
  const exponent = Math.max(0, attempt - 1);
  const capped = Math.min(maxMs, baseMs * (2 ** exponent));
  const jitter = 0.75 + random() * 0.5;
  return Math.round(capped * jitter);
}

export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('Aborted'));
    };
    function done() {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}
