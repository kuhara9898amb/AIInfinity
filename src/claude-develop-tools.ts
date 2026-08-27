// @ts-nocheck
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access } from 'node:fs/promises';
import path from 'node:path';
import mysql from 'mysql2/promise';
import * as z from 'zod/v4';

const execFileAsync = promisify(execFile);
const CLAUDE_BIN = '/Users/erka/.local/bin/claude';
const PROJECTS = {
  aiinfinity: '/Users/erka/AIInfinity/dashboard',
  dashboard98: '/Users/erka/Dashboard98',
  sages: '/Users/erka/SAGES',
  monkeyai: '/Users/erka/MonkeyAI',
  mcpv4: '/Users/erka/AIInfinity/mysql-mcp-v4',
  soreai: '/Users/erka/SoreAI',
  sugoi_ai_site_shindan: '/Users/erka/SugoiAISiteShindan',
} as const;
type ProjectKey = keyof typeof PROJECTS;
type Server = { registerTool: (name: string, config: any, handler: (input: any) => Promise<any>) => void };

const pool = mysql.createPool({
  host: process.env.DB_HOST, port: Number(process.env.DB_PORT ?? 3306),
  user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
  waitForConnections: true, connectionLimit: 2, queueLimit: 0, multipleStatements: false,
});

function textResult(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}
function errorResult(error: unknown) {
  return { content: [{ type: 'text' as const, text: 'Error: ' + (error instanceof Error ? error.message : String(error)) }], isError: true };
}
function childEnv() {
  const env = { ...process.env };
  for (const key of ['ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','CLAUDE_CODE_USE_BEDROCK','CLAUDE_CODE_USE_VERTEX','CLAUDE_CODE_USE_FOUNDRY']) delete env[key];
  env.PATH = '/Users/erka/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';
  return env;
}
function rejectSecrets(task: string, context: string) {
  const value = task + '\n' + context;
  if ([
    /(?:sk-ant-|sk-)[A-Za-z0-9_\-.]{12,}/i,
    /Bearer\s+[A-Za-z0-9_\-.]{12,}/i,
    /(?:API_KEY|PASSWORD|SECRET|TOKEN)\s*[=:]\s*\S+/i,
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  ].some(pattern => pattern.test(value))) throw new Error('依頼または参考情報に機密情報らしき文字列が含まれるため拒否しました');
}
async function git(root: string, args: string[], timeout = 30_000) {
  const { stdout, stderr } = await execFileAsync('/usr/bin/git', args, { cwd: root, env: childEnv(), timeout, maxBuffer: 8 * 1024 * 1024 });
  return { stdout: stdout.trim(), stderr: stderr.trim() };
}
async function projectStatus(project: ProjectKey) {
  const root = PROJECTS[project];
  await access(root);
  await access(path.join(root, '.git'));
  const branch = await git(root, ['branch', '--show-current']);
  const status = await git(root, ['status', '--short']);
  const head = await git(root, ['rev-parse', 'HEAD']);
  return { project, root, branch: branch.stdout, head: head.stdout, clean: status.stdout.length === 0, status: status.stdout };
}
function parseClaude(stdout: string) {
  const parsed = JSON.parse(stdout.trim()) as Record<string, unknown>;
  return {
    response: typeof parsed.result === 'string' ? parsed.result : JSON.stringify(parsed.result ?? parsed, null, 2),
    sessionId: typeof parsed.session_id === 'string' ? parsed.session_id : null,
  };
}
async function updateRun(id: number, values: Record<string, unknown>) {
  const columns = Object.keys(values);
  const assignments = columns.map(column => String.fromCharCode(96) + column + String.fromCharCode(96) + ' = ?').join(', ');
  await pool.execute('UPDATE claude_development_runs SET ' + assignments + ', updated_at = NOW() WHERE id = ? LIMIT 1', [...columns.map(column => values[column]), id]);
}
async function verify(project: ProjectKey, root: string, files: string[]) {
  const checks: Array<Record<string, unknown>> = [];
  const diff = await git(root, ['diff', '--check']);
  checks.push({ check: 'git diff --check', success: true, output: diff.stdout });
  for (const file of files.filter(file => file.endsWith('.php'))) {
    const { stdout, stderr } = await execFileAsync('/opt/homebrew/bin/php', ['-l', file], { cwd: root, env: childEnv(), timeout: 30_000, maxBuffer: 512 * 1024 });
    checks.push({ check: 'php -l', file, success: true, output: (stdout + stderr).trim() });
  }
  if (project === 'mcpv4') {
    const { stdout, stderr } = await execFileAsync('/usr/local/bin/npm', ['run', 'check'], { cwd: root, env: childEnv(), timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
    checks.push({ check: 'npm run check', success: true, output: (stdout + stderr).trim() });
  }
  return checks;
}

export function registerClaudeDevelopTools(server: Server) {
  server.registerTool('claude_develop', {
    title: 'Claude Code安全開発実行',
    description: '登録済みローカルプロジェクト内でClaude Codeへ調査・実装を依頼します。Git cleanを必須とし、機密ファイル・本番反映・DB・外部通信・シェル操作を禁止します。結果と差分はDBへ保存します。',
    inputSchema: z.object({
      action: z.enum(['status','prepare','run','result']),
      project: z.enum(['aiinfinity','dashboard98','sages','monkeyai','mcpv4','soreai','sugoi_ai_site_shindan']).optional(),
      task: z.string().min(1).max(20_000).optional(),
      context: z.string().max(30_000).optional().default(''),
      acceptanceCriteria: z.string().max(10_000).optional().default(''),
      runId: z.number().int().positive().optional(),
      reason: z.string().min(5).max(500),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ action, project, task, context, acceptanceCriteria, runId, reason }) => {
    try {
      if (action === 'status') {
        await access(CLAUDE_BIN);
        const { stdout } = await execFileAsync(CLAUDE_BIN, ['--version'], { env: childEnv(), timeout: 15_000, maxBuffer: 128 * 1024 });
        const projects = await Promise.all((Object.keys(PROJECTS) as ProjectKey[]).map(async key => {
          try { return await projectStatus(key); } catch (error) { return { project: key, root: PROJECTS[key], available: false, error: String(error) }; }
        }));
        return textResult({ success: true, action, version: stdout.trim(), projects });
      }
      if (action === 'result') {
        if (!runId) throw new Error('action=resultではrunIdが必要です');
        const [rows] = await pool.execute('SELECT * FROM claude_development_runs WHERE id = ? LIMIT 1', [runId]);
        const resultRows = rows as any[];
        if (!resultRows[0]) throw new Error('指定runIdが見つかりません');
        return textResult({ success: true, action, run: resultRows[0] });
      }
      if (!project) throw new Error('projectが必要です');
      const before = await projectStatus(project);
      if (action === 'prepare') {
        return textResult({
          success: true, action, ...before, ready: before.clean,
          constraints: ['対象プロジェクト外の編集禁止','.env・秘密情報・.git・vendor・node_modules・ログの編集禁止','Bash・外部通信・DB・Docker・本番公開・Git commit/push禁止','Git cleanでない場合はrun拒否'],
        });
      }
      if (!task || !acceptanceCriteria) throw new Error('action=runではtaskとacceptanceCriteriaが必要です');
      rejectSecrets(task, context);
      if (!before.clean) throw new Error('未コミット変更があるため安全停止しました。既存変更を保護するため実行しません');

      const sql = 'INSERT INTO claude_development_runs (project_id,project_key,task,context,acceptance_criteria,git_before,status,started_at,created_at,updated_at) VALUES ((SELECT id FROM projects WHERE project_code = ? OR id = 1 ORDER BY project_code = ? DESC LIMIT 1),?,?,?,?,?,\'running\',NOW(),NOW(),NOW())';
      const [insert] = await pool.execute(sql, [project, project, project, task, context || null, acceptanceCriteria, JSON.stringify(before)]);
      const id = (insert as any).insertId as number;
      const startedAt = Date.now();
      const prompt = [
        'あなたはAI Infinity開発チームの主任開発者です。チャッピーがPM/SEとして確定した依頼を渡します。',
        '現在の作業ディレクトリ内だけを調査・編集してください。',
        '許可ツールはRead/Edit/Glob/Grepだけです。初版では新規ファイル作成も禁止です。シェル、外部通信、MCP、DB、Docker、本番公開、Git commit/pushは禁止です。',
        '.env、秘密情報、認証情報、秘密鍵、ログ、vendor、node_modules、.gitは閲覧・編集禁止です。',
        '既存実装を先に調査し、重複実装を避け、削除や大規模置換をせず最小差分で対応してください。',
        '完了時は結論、変更ファイル、実装内容、未検証事項、懸念点を具体的に返してください。',
        '', '【開発依頼】', task, '', '【完成条件】', acceptanceCriteria, context ? '\n【参考情報】\n' + context : '',
      ].join('\n');
      try {
        const { stdout } = await execFileAsync(CLAUDE_BIN, ['-p',prompt,'--output-format','json','--permission-mode','acceptEdits','--tools','Read,Edit,Glob,Grep','--max-turns','20','--no-session-persistence'], {
          cwd: before.root, env: childEnv(), timeout: 600_000, maxBuffer: 8 * 1024 * 1024,
        });
        const claude = parseClaude(stdout);
        const changed = await git(before.root, ['diff','--name-only']);
        const untracked = await git(before.root, ['ls-files','--others','--exclude-standard']);
        const files = Array.from(new Set([...changed.stdout.split(/\r?\n/),...untracked.stdout.split(/\r?\n/)].filter(Boolean)));
        const forbidden = files.filter(file => /(^|\/)(\.env(?:\.|$)|\.git(?:\/|$)|vendor(?:\/|$)|node_modules(?:\/|$)|storage\/logs(?:\/|$))/i.test(file));
        if (forbidden.length) {
          const tracked = forbidden.filter(file => !untracked.stdout.split(/\r?\n/).includes(file));
          if (tracked.length) await git(before.root, ['restore','--worktree','--staged','--',...tracked]);
          throw new Error('禁止ファイルへの変更を検出しました: ' + forbidden.join(', '));
        }
        const verification = await verify(project, before.root, files);
        const after = await projectStatus(project);
        const durationMs = Date.now() - startedAt;
        await updateRun(id, { session_id: claude.sessionId, result: claude.response, git_after: JSON.stringify(after), changed_files: JSON.stringify(files), verification: JSON.stringify(verification), status: 'completed', duration_ms: durationMs, completed_at: new Date() });
        return textResult({ success: true, action, runId: id, project, durationMs, changedFiles: files, verification, result: claude.response, historySaved: true, note: '本番公開・commit・pushは未実施。チャッピーの差分レビューが必要です。' });
      } catch (error) {
        await updateRun(id, { status: 'failed', duration_ms: Date.now() - startedAt, error_message: String(error).slice(0,4000), completed_at: new Date() });
        throw error;
      }
    } catch (error) { return errorResult(error); }
  });
}
