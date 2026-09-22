import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { ModelWireMessage, ToolSpec } from '../provider';
import type { DelegatedTask } from '../../shared/harness';

export const HERMES_COMMIT = 'd595e636c83aa0b9606d4e914e1140ae9c796897';
const MAX_FRAME = 16 * 1024 * 1024;
export interface HermesRun {
  modelIdentity?: { model: string; providerId: string; temporaryTestSubstitute?: boolean };
  runId: string;
  parentRunId?: string;
  epoch: number;
  taskVersion: number;
  system: string;
  userMessage: ModelWireMessage['content'];
  history: ModelWireMessage[];
  tools: ToolSpec[];
  thinking: 'enabled' | 'disabled';
  maxIterations?: number;
  maxOutputTokens?: number;
  compression?: { enabled: boolean; thresholdTokens: number; forceInitial?: boolean };
  signal: AbortSignal;
  validate: () => void;
  model: (request: { messages: ModelWireMessage[]; tools?: ToolSpec[]; thinking?: { type: string }; [key: string]: unknown }) => Promise<{ assistant: ModelWireMessage; usage?: unknown }>;
  tool: (name: string, args: unknown, callId: string, agentId?: string) => Promise<unknown>;
  children?: {
    authorize: (args: unknown, callId: string) => Promise<void>;
    open: (task: DelegatedTask) => Promise<{ id: string; system: string; tools: ToolSpec[] }>;
    event: (id: string, status: 'running' | 'produced' | 'failed') => void;
    result: (callId: string, result: unknown) => Promise<void>;
  };
  event?: (event: { kind: string; sequence: number; payload: unknown }) => void;
}
export interface HermesResult {
  compactions?: number;
  content: string;
  messages: ModelWireMessage[];
  interrupted: boolean;
}

export class HermesRunError extends Error {
  readonly code: string;
  constructor(readonly diagnostic: Record<string, unknown>) {
    const code = typeof diagnostic.code === 'string' ? diagnostic.code : 'hermes_error';
    super('Hermes 侧车失败：' + code);
    this.name = 'HermesRunError';
    this.code = code;
  }
}

/** Transport/state adapter only: the production model/tool loop lives in AIAgent. */
export function runHermes(input: HermesRun): Promise<HermesResult> {
  input.signal.throwIfAborted();
  input.validate();
  const root = path.resolve(process.env.ZAICHANG_RUNTIME_ROOT || process.cwd());
  const bundledPython = path.join(root, '.runtime', 'python', process.platform === 'win32' ? 'python.exe' : 'bin/python3');
  const python = fs.existsSync(bundledPython) ? bundledPython : path.join(root, '.runtime', 'hermes-agent', '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const script = path.join(root, 'runtime', 'hermes', 'sidecar.py');
  if (!fs.existsSync(python) || !fs.existsSync(script))
    return Promise.reject(new Error('Hermes 运行环境未安装，请运行 node scripts/setup-hermes.mjs。'));
  const environment: NodeJS.ProcessEnv = {};
  for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'PATH'])
    if (process.env[key]) environment[key] = process.env[key];
  environment.PYTHONUTF8 = '1';
  environment.PYTHONDONTWRITEBYTECODE = '1';
  environment.HERMES_HOME = path.join(root, '.runtime', 'hermes-home');
  environment.ZAICHANG_HERMES_HOST = '1';
  const debugErrors = process.env.ZAICHANG_DEBUG_ERRORS === '1';
  const identity = { version: 1, run_id: input.runId, parent_run_id: input.parentRunId || null, epoch: input.epoch, task_version: input.taskVersion };
  return new Promise((resolve, reject) => {
    const child = spawn(python, ['-I', '-X', 'utf8', '-B', script], { cwd: root, env: environment, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer: Buffer = Buffer.alloc(0), sequence = 0, sentSequence = 0, settled = false;
    const pending = new Set<Promise<void>>(), childIds = new Set<string>();
    const close = () => { input.signal.removeEventListener('abort', abort); child.stdin.destroy(); child.kill(); };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      close();
      reject(error instanceof Error ? error : new Error('Hermes 运行失败。'));
    };
    const abort = () => fail(input.signal.reason || new DOMException('已停止', 'AbortError'));
    const write = (frame: unknown) => {
      const data = Buffer.from(JSON.stringify({ ...(frame as object), sequence: ++sentSequence }));
      if (data.length > MAX_FRAME) throw new Error('Hermes 协议帧超限，原输入未被截断。');
      const prefix = Buffer.alloc(4); prefix.writeUInt32BE(data.length);
      child.stdin.write(Buffer.concat([prefix, data]));
    };
    const handle = async (frame: any) => {
      if (settled) return;
      input.signal.throwIfAborted(); input.validate();
      input.event?.({ kind: frame.kind, sequence: frame.sequence, payload: frame.kind === 'run.error' || frame.kind === 'run.ready' ? frame.payload : undefined });
      if (frame.kind === 'run.error') {
        if (debugErrors) {
          const line = '[在场] Hermes run.error ' + JSON.stringify(frame.payload) + '\n';
          console.error(line.trim());
          const logPath = process.env.ZAICHANG_DEBUG_LOG;
          if (logPath) {
            try { fs.appendFileSync(logPath, line, 'utf8'); } catch { /* diagnostics must never affect a run */ }
          }
        }
        throw new HermesRunError(frame.payload && typeof frame.payload === 'object' ? frame.payload : {});
      }
      if (frame.kind === 'run.final') {
        await Promise.all([...pending]);
        settled = true;
        close();
        resolve(frame.payload as HermesResult);
        return;
      }
      if (frame.kind === 'run.ready') return;
      if (!frame.request_id) throw new Error('Hermes 请求缺少配对标识。');
      const agentId = frame.payload.agent_id || input.runId;
      if (agentId !== input.runId && !childIds.has(agentId)) throw new Error('Hermes 子任务没有宿主许可。');
      let payload: unknown;
      if (frame.kind === 'model.request') payload = await input.model(frame.payload);
      else if (frame.kind === 'tool.request') payload = await input.tool(frame.payload.name, frame.payload.arguments, frame.payload.tool_call_id, agentId);
      else if (frame.kind === 'delegate.authorize' && input.children && agentId === input.runId) {
        await input.children.authorize(frame.payload.arguments, frame.payload.tool_call_id); payload = { authorized: true };
      } else if (frame.kind === 'child.open' && input.children && agentId === input.runId) {
        const ticket = await input.children.open(frame.payload.task);
        if (childIds.has(ticket.id) || ticket.id === input.runId) throw new Error('重复的子任务标识。');
        childIds.add(ticket.id); payload = ticket;
      } else if (['child.started', 'child.finished'].includes(frame.kind) && input.children && childIds.has(agentId)) {
        input.children.event(agentId, frame.kind === 'child.started' ? 'running' : frame.payload.status === 'produced' ? 'produced' : 'failed'); payload = { received: true };
      } else if (frame.kind === 'delegate.result' && input.children && agentId === input.runId) {
        await input.children.result(frame.payload.tool_call_id, frame.payload.result); payload = { received: true };
      } else throw new Error('未知或未授权的 Hermes 事件。');
      input.signal.throwIfAborted(); input.validate();
      if (!settled) write({ ...identity, kind: 'response', request_id: frame.request_id, payload });
    };
    child.stdout.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      try {
        while (buffer.length >= 4) {
          const size = buffer.readUInt32BE(0);
          if (size < 2 || size > MAX_FRAME) throw new Error('Hermes 协议帧长度不合法。');
          if (buffer.length < size + 4) break;
          const frame = JSON.parse(buffer.subarray(4, size + 4).toString('utf8'));
          buffer = buffer.subarray(size + 4);
          if (frame.version !== 1 || frame.run_id !== input.runId || frame.epoch !== input.epoch || frame.task_version !== input.taskVersion || frame.parent_run_id !== identity.parent_run_id || frame.sequence !== ++sequence)
            throw new Error('Hermes 运行归属、版本或事件顺序不匹配。');
          const request = handle(frame).catch(error => {
            const agentId = frame.payload?.agent_id;
            if (agentId && childIds.has(agentId) && ['model.request', 'tool.request'].includes(frame.kind) && !input.signal.aborted && !settled) {
              try {
                input.validate();
                write({ ...identity, kind: 'response', request_id: frame.request_id, error: { code: error?.code || 'child_call_failed' } });
                return;
              } catch { /* A parent boundary failure still stops the whole tree. */ }
            }
            fail(error);
          });
          pending.add(request);
          void request.finally(() => pending.delete(request));
        }
      } catch (error) { fail(error); }
    });
    child.stderr.resume(); // Sidecar stderr is never trusted as user-safe diagnostics.
    child.stdin.on('error', fail);
    child.on('error', fail);
    child.on('exit', code => { void Promise.all([...pending]).then(() => { if (!settled) fail(new Error('Hermes 提前退出，退出码 ' + code)); }); });
    input.signal.addEventListener('abort', abort, { once: true });
    write({ ...identity, kind: 'run.start', payload: { modelIdentity: input.modelIdentity, system: input.system, userMessage: input.userMessage, history: input.history, tools: input.tools, thinking: input.thinking, maxIterations: input.maxIterations || 12, maxOutputTokens: input.maxOutputTokens || 4096, compression: input.compression } });
  });
}
