import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import readline from 'node:readline';
import { AppError, RpcError, errorMessage } from '../errors.js';
import type { Logger } from '../log.js';

const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
const MAX_STDERR_BUFFER = 64 * 1024;

export interface RpcMessage {
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(reason: unknown): void;
  timer: NodeJS.Timeout;
}

export interface ServerRequest {
  id: number | string;
  method: string;
  params: unknown;
}

export class JsonRpcProcess extends EventEmitter {
  readonly process: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number | string, PendingRequest>();
  private nextId = 1;
  private closed = false;
  private stderrBuffer = '';

  private constructor(process: ChildProcessWithoutNullStreams, private readonly logger: Logger) {
    super();
    this.process = process;
    const lines = readline.createInterface({ input: process.stdout, crlfDelay: Infinity });
    lines.on('line', (line) => this.handleLine(line));
    process.stderr.on('data', (chunk: Buffer) => {
      this.stderrBuffer = (this.stderrBuffer + chunk.toString('utf8')).slice(-MAX_STDERR_BUFFER);
      const text = chunk.toString('utf8').trim();
      if (text) this.logger.debug(`app-server: ${text}`);
    });
    process.once('error', (error) => this.handleClose(new AppError('APP_SERVER_SPAWN_FAILED', errorMessage(error), 1, { cause: error })));
    process.once('exit', (code, signal) => {
      const detail = this.stderrBuffer.trim();
      this.handleClose(new AppError(
        'APP_SERVER_EXITED',
        `App Server termino inesperadamente (codigo=${String(code)}, senal=${String(signal)})${detail ? `: ${detail.slice(-1000)}` : ''}`,
      ));
    });
  }

  static async start(binary: string, cwd: string, logger: Logger): Promise<JsonRpcProcess> {
    const childEnvironment = { ...process.env };
    delete childEnvironment.OPENAI_API_KEY;
    delete childEnvironment.CODEX_API_KEY;
    const child = spawn(binary, ['app-server', '--listen', 'stdio://'], {
      cwd,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: childEnvironment,
    });
    const rpc = new JsonRpcProcess(child, logger);
    await rpc.request('initialize', {
      clientInfo: {
        name: 'codex_desktop_infinite_agent',
        title: 'Codex Desktop Infinite Agent',
        version: '1.0.0',
      },
    }, 30_000);
    rpc.notify('initialized', {});
    return rpc;
  }

  request<T>(method: string, params: unknown = {}, timeoutMs = 30_000): Promise<T> {
    if (this.closed) return Promise.reject(new AppError('APP_SERVER_CLOSED', 'App Server ya esta cerrado.'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AppError('RPC_TIMEOUT', `Tiempo agotado para ${method}.`));
      }, timeoutMs);
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
      try {
        this.write({ id, method, params });
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  notify(method: string, params: unknown = {}): void {
    this.write({ method, params });
  }

  respond(id: number | string, result: unknown): void {
    this.write({ id, result });
  }

  respondError(id: number | string, code: number, message: string): void {
    this.write({ id, error: { code, message } });
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.process.stdin.writable) this.process.stdin.end();
    if (this.process.exitCode !== null) return;
    this.process.kill();
    await Promise.race([
      new Promise<void>((resolve) => this.process.once('exit', () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 3000)),
    ]);
    if (this.process.exitCode === null) this.process.kill('SIGKILL');
  }

  private write(message: RpcMessage): void {
    if (this.closed || !this.process.stdin.writable) {
      throw new AppError('APP_SERVER_CLOSED', 'No se puede escribir al App Server cerrado.');
    }
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string): void {
    if (Buffer.byteLength(line, 'utf8') > MAX_MESSAGE_BYTES) {
      this.handleClose(new AppError('RPC_MESSAGE_TOO_LARGE', 'App Server envio un mensaje que excede el limite de seguridad.'));
      void this.close();
      return;
    }
    let message: RpcMessage;
    try {
      message = JSON.parse(line) as RpcMessage;
    } catch {
      this.logger.warn('App Server envio una linea JSON invalida; se ignoro.');
      return;
    }

    if (message.id !== undefined && message.method === undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new RpcError(message.error.code ?? -32000, message.error.message ?? 'Error RPC desconocido', message.error.data));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.id !== undefined && typeof message.method === 'string') {
      this.emit('request', { id: message.id, method: message.method, params: message.params } satisfies ServerRequest);
      return;
    }
    if (typeof message.method === 'string') this.emit('notification', message);
  }

  private handleClose(error: Error): void {
    if (this.closed && this.pending.size === 0) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.emit('closed', error);
  }
}
