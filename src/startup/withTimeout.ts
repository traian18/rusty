export class TimeoutError extends Error {
  constructor(message = "Operation timed out") {
    super(message);
    this.name = "TimeoutError";
  }
}

/**
 * Races `operation` against `timeoutMs`. Does NOT cancel `operation` on
 * timeout -- most callers in src/startup/ wrap work that has no cancellation
 * primitive of its own (WebCrypto's deriveKey, Tauri's `invoke`), so the
 * losing operation keeps running in the background. A no-op `.catch` is
 * attached so its eventual settlement never surfaces as an unhandled
 * rejection; callers that must not act on a late result should have their
 * `operation` check `StepContext.signal.aborted` before writing anywhere
 * (runStartup.ts aborts the step's signal the moment it times out).
 */
export function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (timeoutMs <= 0) {
      reject(new TimeoutError());
      operation.catch(() => {});
      return;
    }

    const timer = setTimeout(() => reject(new TimeoutError()), timeoutMs);
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
