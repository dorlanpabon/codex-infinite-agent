export class AppError extends Error {
  readonly code: string;
  readonly exitCode: number;

  constructor(code: string, message: string, exitCode = 1, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AppError';
    this.code = code;
    this.exitCode = exitCode;
  }
}

export class RpcError extends Error {
  readonly rpcCode: number;
  readonly data: unknown;

  constructor(rpcCode: number, message: string, data?: unknown) {
    super(message);
    this.name = 'RpcError';
    this.rpcCode = rpcCode;
    this.data = data;
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
