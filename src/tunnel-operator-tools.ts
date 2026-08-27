import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import * as z from 'zod/v4';

const execFileAsync = promisify(execFile);

const PROFILE_PATH = '/Users/erka/.config/tunnel-client/ai-infinity-v4.yaml';
const TUNNEL_PATTERN = `tunnel-client run --profile-file ${PROFILE_PATH}`;
const MCP_ROOT = '/Users/erka/AIInfinity/mysql-mcp-v4';
const MCP_PATTERN = MCP_ROOT;
const HEALTH_URL = 'http://127.0.0.1:8788/';
const AUDIT_PATH = '/Users/erka/AIInfinity/logs/mcp-v4-tunnel-operator.jsonl';

type Server = {
  registerTool: (
    name: string,
    config: any,
    handler: (input: any) => Promise<any>
  ) => void;
};

function textResult(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

function errorResult(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true };
}

async function audit(action: string, status: 'success' | 'failed', details: Record<string, unknown> = {}) {
  await mkdir(path.dirname(AUDIT_PATH), { recursive: true });
  await appendFile(
    AUDIT_PATH,
    JSON.stringify({ timestamp: new Date().toISOString(), action, status, ...details }) + '\n',
    { encoding: 'utf8', mode: 0o600 },
  );
}

async function matchingProcesses(search: string) {
  try {
    const { stdout } = await execFileAsync('/usr/bin/pgrep', ['-fl', search], {
      timeout: 5000,
      maxBuffer: 128 * 1024,
    });
    return stdout
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => {
        const match = line.match(/^(\d+)\s+(.*)$/);
        return match ? { pid: Number(match[1]), command: match[2] } : { pid: null, command: line };
      });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException & { code?: number | string }).code;
    if (String(code) === '1') return [];
    throw error;
  }
}

async function processCwd(pid: number) {
  try {
    const { stdout } = await execFileAsync('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], {
      timeout: 5000,
      maxBuffer: 128 * 1024,
    });
    const pathLine = stdout.split(/\r?\n/).find(line => line.startsWith('n'));
    return pathLine ? pathLine.slice(1) : '';
  } catch {
    return '';
  }
}

async function matchingMcpProcesses() {
  // このコードを実行しているNodeプロセス自身が、稼働中のMCP v4本体。
  // launchd/npx/tsxの起動形式に依存せず、確実なPIDを返す。
  let command = '';
  try {
    const result = await execFileAsync('/bin/ps', ['-p', String(process.pid), '-o', 'command='], {
      timeout: 5000,
      maxBuffer: 128 * 1024,
    });
    command = result.stdout.trim();
  } catch {}

  return [{
    pid: process.pid,
    command,
    cwd: process.cwd(),
  }];
}

async function portProcesses(port: number) {
  try {
    const { stdout } = await execFileAsync('/usr/sbin/lsof', [
      '-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'
    ], { timeout: 5000, maxBuffer: 128 * 1024 });
    const pids = [...new Set(
      stdout
        .split(/\r?\n/)
        .map(v => v.trim())
        .filter(Boolean)
        .map(Number)
        .filter(pid => Number.isInteger(pid) && pid > 1)
    )];
    const processes = [];
    for (const pid of pids) {
      try {
        const { stdout: command } = await execFileAsync('/bin/ps', ['-p', String(pid), '-o', 'command='], {
          timeout: 5000,
          maxBuffer: 128 * 1024,
        });
        processes.push({ pid, command: command.trim() });
      } catch {
        processes.push({ pid, command: '' });
      }
    }
    return processes;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException & { code?: number | string }).code;
    if (String(code) === '1') return [];
    throw error;
  }
}

async function healthStatus() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const response = await fetch(HEALTH_URL, { signal: controller.signal });
    clearTimeout(timer);
    return { reachable: true, http_status: response.status };
  } catch (error) {
    return {
      reachable: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function combinedStatus() {
  const [mcpProcesses, portOwners, profileProcesses, health] = await Promise.all([
    matchingMcpProcesses(),
    portProcesses(8788),
    matchingProcesses(PROFILE_PATH),
    healthStatus(),
  ]);
  const tunnelByPid = new Map<number | null, { pid: number | null; command: string }>();
  for (const item of [...portOwners, ...profileProcesses]) {
    tunnelByPid.set(item.pid, item);
  }
  const tunnelProcesses = [...tunnelByPid.values()];

  return {
    mcp: {
      root: MCP_ROOT,
      running: mcpProcesses.length > 0,
      process_count: mcpProcesses.length,
      processes: mcpProcesses,
    },
    tunnel: {
      profile: PROFILE_PATH,
      running: tunnelProcesses.length > 0,
      process_count: tunnelProcesses.length,
      processes: tunnelProcesses,
    },
    health,
  };
}

export function registerTunnelOperatorTools(server: Server) {
  server.registerTool('mcp_v4_tunnel', {
    title: 'AI Infinity MCP v4一括再起動',
    description: '固定パスのMCP v4本体と固定プロファイルai-infinity-v4.yamlのトンネルを、1回のrestartで順番に再起動します。状態確認も可能です。任意コマンド・引数・パスは指定できません。',
    inputSchema: z.object({
      action: z.enum(['status', 'restart']).describe('statusはMCP本体・トンネル・ヘルス確認、restartは応答後に両方を一括再起動'),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  }, async ({ action }) => {
    try {
      if (action === 'status') {
        return textResult({
          success: true,
          action,
          ...(await combinedStatus()),
        });
      }

      // 壊れたコードのまま稼働中MCPを停止しないよう、再起動前に必ず検証する。
      const typecheck = await execFileAsync('/usr/local/bin/npm', ['run', 'check'], {
        cwd: MCP_ROOT,
        timeout: 180000,
        maxBuffer: 2 * 1024 * 1024,
      });
      const toolcheck = await execFileAsync('/usr/local/bin/node', ['check-mcp-tools.mjs'], {
        cwd: MCP_ROOT,
        timeout: 180000,
        maxBuffer: 4 * 1024 * 1024,
      });
      const before = await combinedStatus();

      // 検索文字列によるpkillは、再起動ヘルパー自身を巻き込むため使用しない。
      // 応答前に確定したMCP PIDと8788 LISTEN PIDだけを数値指定で停止する。
      // 独立ヘルパーが最後まで動作し、launchd KeepAliveがトンネルとMCPを再生成する。
      const mcpPids = before.mcp.processes
        .map(item => item.pid)
        .filter((pid): pid is number => pid !== null && Number.isInteger(pid) && pid > 1);
      const tunnelPids = before.tunnel.processes
        .map(item => item.pid)
        .filter((pid): pid is number => pid !== null && Number.isInteger(pid) && pid > 1);
      if (tunnelPids.length === 0) {
        throw new Error('安全停止: v4トンネルPIDを特定できないため再起動しません');
      }
      const killList = (pids: number[]) => pids.length
        ? '/bin/kill ' + pids.join(' ') + ' 2>/dev/null || true'
        : ':';
      const restartCommand = [
        'sleep 2',
        killList(mcpPids),
        'sleep 1',
        killList(tunnelPids),
      ].join('; ');
      const helper = spawn('/bin/sh', ['-c', restartCommand, 'mcp-v4-combined-restart'], {
        detached: true,
        stdio: 'ignore',
        env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
      });
      helper.unref();

      await audit('combined_restart', 'success', {
        scheduled: true,
        delay_seconds: 2,
        mcp_previous_pids: before.mcp.processes.map(item => item.pid),
        tunnel_previous_pids: before.tunnel.processes.map(item => item.pid),
        health_before: before.health,
        typecheck: typecheck.stdout.trim() || 'passed',
        toolcheck: toolcheck.stdout.trim().split(/\r?\n/).slice(-5),
      });

      return textResult({
        success: true,
        action,
        scheduled: true,
        delay_seconds: 2,
        components: ['mcp_v4_server', 'v4_tunnel'],
        before,
        message: '応答後にMCP v4本体とv4トンネルを一括再起動します。再接続後、ChatGPT側でMCPを更新して新規スレッドを開いてください。',
      });
    } catch (error) {
      if (action === 'restart') {
        const commandError = error as Error & { stdout?: string | Buffer; stderr?: string | Buffer };
        const details = [
          commandError.message,
          commandError.stdout ? `stdout:\n${String(commandError.stdout).trim()}` : '',
          commandError.stderr ? `stderr:\n${String(commandError.stderr).trim()}` : '',
        ].filter(Boolean).join('\n\n');
        try { await audit('combined_restart', 'failed', { error: details }); } catch {}
        return errorResult(new Error(details));
      }
      return errorResult(error);
    }
  });
}
