export class KernelRequestError extends Error {
  readonly code?: string;

  constructor(message: string, code?: string) {
    super(message);
    this.name = "KernelRequestError";
    this.code = code;
  }
}

export function throwKernelError(
  body: { error?: { code?: string; message?: string } },
  fallback: string,
): never {
  throw new KernelRequestError(body.error?.message ?? fallback, body.error?.code);
}
