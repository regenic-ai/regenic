import { PersonalKernelStoppedError } from "./personal-runtime.service";

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export class WriteBackTimeoutError extends Error {
  constructor() {
    super("Write-back send timed out");
    this.name = "WriteBackTimeoutError";
  }
}

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new WriteBackTimeoutError());
    }, ms);
    promise.then(
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

export function isWorkTickShutdown(error: unknown): boolean {
  if (error instanceof PersonalKernelStoppedError) {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return (
    (error instanceof TypeError && /database connection is not open/i.test(message)) ||
    /Service is not available/i.test(message)
  );
}
