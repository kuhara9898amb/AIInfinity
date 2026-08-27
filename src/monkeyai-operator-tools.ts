import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { spawn } from 'node:child_process';
import { appendFile, mkdir, open, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const MONKEYAI_ROOT = '/Users/erka/MonkeyAI';
const REGISTRY_PATH = path.join(MONKEYAI_ROOT, 'config/mcp-validation-jobs.json');
const RUNTIME_DIR = path.join(MONKEYAI_ROOT, 'storage/logs/mcp-validation-runner');
const STATE_PATH = path.join(RUNTIME_DIR, 'state.json');
const AUDIT_PATH = path.join(RUNTIME_DIR, 'audit.jsonl');

type JobDefinition = {
  description: string;
  args: string[];
};

type RunnerState = {
  job: string;
  description: string;
  pid: number;
  status: 'running' | 'completed' | 'failed' | 'unknown';
  started_at: string;
  log_path: string;
};

function textResult(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

function errorResult(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true };
}

async function loadRegistry(): Promise<Record<string, JobDefinition>> {
  const parsed = JSON.parse(await readFile(REGISTRY_PATH, 'utf8')) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('MonkeyAIジョブ定義が不正です');

  const registry: Record<string, JobDefinition> = {};
  for (const [job, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!/^[a-z0-9_]{3,80}$/.test(job)) throw new Error(`不正なジョブ名です: ${job}`);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`ジョブ定義が不正です: ${job}`);

    const description = String((value as Record<string, unknown>).description ?? '');
    const args = (value as Record<string, unknown>).args;
    if (!description || !Array.isArray(args) || args.length < 1 || args.length > 20 || !args.every(v => typeof v === 'string')) {
      throw new Error(`ジョブ定義が不正です: ${job}`);
    }
    if (!/^boat:[a-z0-9:-]+$/.test(args[0] as string)) throw new Error(`boat:コマンド以外は禁止されています: ${job}`);
    for (const arg of args.slice(1) as string[]) {
      if (!/^--[a-z0-9-]+=[A-Za-z0-9_./:-]+$/.test(arg)) throw new Error(`固定オプションが不正です: ${job}`);
      if (arg.includes('..')) throw new Error(`親ディレクトリ参照は禁止されています: ${job}`);
    }
    registry[job] = { description, args: args as string[] };
  }
  return registry;
}

async function readState(): Promise<RunnerState | null> {
  try {
    return JSON.parse(await readFile(STATE_PATH, 'utf8')) as RunnerState;
  } catch {
    return null;
  }
}

function isRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function logTail(logPath: string, maximumBytes = 30000): Promise<string> {
  try {
    const data = await readFile(logPath);
    return data.subarray(Math.max(0, data.length - maximumBytes)).toString('utf8');
  } catch {
    return '';
  }
}

async function audit(action: string, details: Record<string, unknown>) {
  await mkdir(RUNTIME_DIR, { recursive: true });
  await appendFile(AUDIT_PATH, JSON.stringify({ timestamp: new Date().toISOString(), action, ...details }) + '\n', { encoding: 'utf8', mode: 0o600 });
}

export function registerMonkeyAiOperatorTools(server: McpServer) {
  server.registerTool('monkeyai_validation_jobs', {
    title: 'MonkeyAI検証ジョブ一覧',
    description: 'MonkeyAI側で事前許可された検証ジョブだけを一覧表示します。任意コマンドは実行できません。',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => {
    try {
      const registry = await loadRegistry();
      return textResult({ jobs: Object.entries(registry).map(([job, value]) => ({ job, description: value.description })) });
    } catch (error) {
      return errorResult(error);
    }
  });

  server.registerTool('monkeyai_validation_run', {
    title: 'MonkeyAI固定検証開始',
    description: 'MonkeyAI側の固定レジストリに登録済みの検証だけをDocker内でバックグラウンド開始します。引数・期間・閾値・任意コマンドは指定できません。',
    inputSchema: z.object({ job: z.string().regex(/^[a-z0-9_]{3,80}$/), reason: z.string().min(5).max(500) }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ job, reason }) => {
    try {
      await mkdir(RUNTIME_DIR, { recursive: true });
      const current = await readState();
      if (current && isRunning(current.pid)) throw new Error(`別の検証が実行中です: ${current.job} (PID ${current.pid})`);

      const registry = await loadRegistry();
      const definition = registry[job];
      if (!definition) throw new Error(`許可されていないジョブです: ${job}`);

      const logPath = path.join(RUNTIME_DIR, `${job}-${Date.now()}.log`);
      const handle = await open(logPath, 'a', 0o600);
      const child = spawn('docker', ['exec', 'monkey-ai', 'php', 'artisan', ...definition.args], {
        cwd: MONKEYAI_ROOT,
        detached: true,
        stdio: ['ignore', handle.fd, handle.fd],
        env: process.env,
      });
      if (!child.pid) {
        await handle.close();
        throw new Error('検証プロセスを開始できませんでした');
      }
      child.unref();
      await handle.close();

      const state: RunnerState = {
        job,
        description: definition.description,
        pid: child.pid,
        status: 'running',
        started_at: new Date().toISOString(),
        log_path: logPath,
      };
      await writeFile(STATE_PATH, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 });
      await audit('run', { job, reason, pid: child.pid, args: definition.args });

      return textResult({ success: true, ...state, message: 'バックグラウンドで開始しました。monkeyai_validation_statusで進捗を確認できます。' });
    } catch (error) {
      await audit('run_failed', { job, reason, error: String(error) });
      return errorResult(error);
    }
  });

  server.registerTool('monkeyai_validation_status', {
    title: 'MonkeyAI検証状態確認',
    description: '直近のMonkeyAI検証について、実行状態とログ末尾を読み取り専用で確認します。',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => {
    try {
      const state = await readState();
      if (!state) return textResult({ status: 'not_started' });

      const running = isRunning(state.pid);
      const tail = await logTail(state.log_path);
      let status: RunnerState['status'] = running ? 'running' : 'unknown';
      if (!running && /JSON:\s+\S+/u.test(tail) && !/Error:|Fatal error|ParseError|Exception/u.test(tail)) status = 'completed';
      if (!running && /Error:|Fatal error|ParseError|Exception/u.test(tail)) status = 'failed';

      const updated = { ...state, status };
      if (state.status !== status) await writeFile(STATE_PATH, JSON.stringify(updated, null, 2), { encoding: 'utf8', mode: 0o600 });

      const progressMatches = [...tail.matchAll(/(\d+)\/(\d+)/g)];
      const lastProgress = progressMatches.length ? progressMatches[progressMatches.length - 1] : null;
      const progress = lastProgress ? {
        current: Number(lastProgress[1]),
        total: Number(lastProgress[2]),
        percent: Number(lastProgress[2]) > 0 ? Math.round(Number(lastProgress[1]) / Number(lastProgress[2]) * 10000) / 100 : null,
      } : null;

      return textResult({ ...updated, progress, log_tail: tail });
    } catch (error) {
      return errorResult(error);
    }
  });
}
