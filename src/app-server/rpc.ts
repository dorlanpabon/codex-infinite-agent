import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import readline from 'node:readline';
import { AppError, RpcError, errorMessage } from '../errors.js';
import type { Logger } from '../log.js';
import { minimalWindowsEnvironment, spawnManagedProcess, terminateProcessTree } from '../trusted-process.js';

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

function appServerEnvironment(): NodeJS.ProcessEnv {
  const allowed = [
    'PATH', 'PATHEXT', 'SystemRoot', 'WINDIR', 'COMSPEC', 'SystemDrive',
    'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA',
    'PROGRAMDATA', 'ProgramFiles', 'ProgramFiles(x86)', 'TEMP', 'TMP', 'TMPDIR',
    'SHELL', 'USER', 'USERNAME', 'LOGNAME', 'LANG', 'LC_ALL', 'TERM', 'COLORTERM', 'NO_COLOR',
    'CODEX_HOME', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY',
    'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
    'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME',
  ];
  const environment: NodeJS.ProcessEnv = {};
  for (const key of allowed) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  return minimalWindowsEnvironment({
    ...environment,
    COMSPEC: 'C:\\Windows\\System32\\cmd.exe',
    ProgramFiles: 'C:\\Program Files',
    'ProgramFiles(x86)': 'C:\\Program Files (x86)',
  });
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
    let child: ChildProcessWithoutNullStreams;
    try {
      const spawned = spawnManagedProcess(binary, ['app-server', '--listen', 'stdio://'], {
        cwd,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: appServerEnvironment(),
      });
      if (!spawned.stdin || !spawned.stdout || !spawned.stderr) {
        throw new AppError('APP_SERVER_SPAWN_FAILED', 'El App Server no expuso stdio administrado.');
      }
      child = spawned as ChildProcessWithoutNullStreams;
    } catch (error) {
      throw new AppError('APP_SERVER_SPAWN_FAILED', errorMessage(error), 1, { cause: error });
    }
    const rpc = new JsonRpcProcess(child, logger);
    try {
      await rpc.request('initialize', {
        clientInfo: {
          name: 'codex_desktop_infinite_agent',
          title: 'Codex Desktop Infinite Agent',
          version: '0.1.0',
        },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
        },
      }, 30_000);
      rpc.notify('initialized', {});
      return rpc;
    } catch (error) {
      await rpc.close();
      throw error;
    }
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
    await terminateProcessTree(this.process);
    if (this.process.stdin.writable) this.process.stdin.end();
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
