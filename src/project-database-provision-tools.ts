import * as z from 'zod/v4';
import path from 'node:path';
import crypto from 'node:crypto';
import mysql from 'mysql2/promise';
import { appendFile, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getProject, type ProjectKey } from './project-config.js';

const execFileAsync = promisify(execFile);
const AUDIT_LOG = process.env.MCP_AUDIT_LOG ?? '/Users/erka/AIInfinity/logs/mcp-v4-audit.jsonl';
const PHP_BIN = process.env.PHP_BIN ?? '/opt/homebrew/bin/php';
const DOCKER_CANDIDATES = ['/usr/local/bin/docker', '/opt/homebrew/bin/docker'];
const approvals = new Map<string, { project: ProjectKey; expiresAt: number }>();

type Server = { registerTool: (name: string, config: any, handler: (input: any) => Promise<any>) => void };

function result(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

function identifier(value: string) {
  if (!/^[A-Za-z0-9_]+$/.test(value)) throw new Error('不正なDB識別子です');
  return `\`${value}\``;
}

function sqlString(value: string) {
  if (!/^[A-Za-z0-9_%-]+$/.test(value)) throw new Error('不正なMySQLアカウント識別子です');
  return "'" + value.replaceAll("'", "''") + "'";
}

async function audit(action: string, target: string, status: 'success'|'failed', details: Record<string, unknown> = {}) {
  await mkdir(path.dirname(AUDIT_LOG), { recursive: true });
  const safe = JSON.parse(JSON.stringify(details, (key, value) =>
    /password|secret|token|api.?key|credential/i.test(key) ? '[REDACTED]' : value
  ));
  await appendFile(AUDIT_LOG, JSON.stringify({
    timestamp: new Date().toISOString(), action, target, status, details: safe
  }) + '\n', { encoding: 'utf8', mode: 0o600 });
}

async function dockerBin() {
  for (const candidate of DOCKER_CANDIDATES) {
    try {
      await execFileAsync(candidate, ['version', '--format', '{{.Client.Version}}'], { timeout: 10000 });
      return candidate;
    } catch {}
  }
  throw new Error('Docker CLIが見つかりません');
}

async function rootCredentials() {
  const docker = await dockerBin();
  const { stdout } = await execFileAsync(docker, ['ps', '--format', '{{.Names}}|{{.Image}}'], {
    timeout: 15000, maxBuffer: 256 * 1024
  });
  const candidates = stdout.split(/\r?\n/).map(v => v.trim()).filter(Boolean)
    .filter(v => /mysql|mariadb/i.test(v));
  if (candidates.length !== 1) {
    throw new Error(`安全停止: MySQLコンテナを一意に特定できません (${candidates.join(', ') || 'none'})`);
  }
  const container = candidates[0].split('|')[0];
  const inspected = await execFileAsync(docker, ['inspect', '--format', '{{range .Config.Env}}{{println .}}{{end}}', container], {
    timeout: 15000, maxBuffer: 512 * 1024
  });
  const env = new Map<string, string>();
  for (const line of inspected.stdout.split(/\r?\n/)) {
    const index = line.indexOf('=');
    if (index > 0) env.set(line.slice(0, index), line.slice(index + 1));
  }
  const password = env.get('MYSQL_ROOT_PASSWORD') ?? env.get('MARIADB_ROOT_PASSWORD') ?? '';
  if (!password) throw new Error('MySQL管理者資格情報を安全に取得できません');
  return { password };
}

async function adminConnection(project: ProjectKey) {
  const target = getProject(project);
  const root = await rootCredentials();
  return mysql.createConnection({
    host: target.db.host,
    port: target.db.port,
    user: 'root',
    password: root.password,
  });
}

function runtimeGrantSql(project: ProjectKey) {
  const target = getProject(project);
  return `GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES ON ${identifier(target.db.database)}.* TO ${sqlString(target.db.user)}@'%'`;
}

async function verifyRuntime(project: ProjectKey) {
  const target = getProject(project);
  const connection = await mysql.createConnection({
    host: target.db.host, port: target.db.port, database: target.db.database,
    user: target.db.user, password: target.db.password,
  });
  try {
    await connection.query('SELECT 1');
    const [grants] = await connection.query('SHOW GRANTS FOR CURRENT_USER');
    return { connected: true, grants };
  } finally {
    await connection.end();
  }
}

export function registerProjectDatabaseProvisionTools(server: Server) {
  const projectSchema = z.enum(['aiinfinity','dashboard98','sages','monkeyai','mcpv4','soreai','sugoi_ai_site_shindan']);

  server.registerTool('project_database_provision', {
    title: 'プロジェクトDB事前承認・安全構築',
    description: '登録済みプロジェクトのDB作成と対象DB限定の実行権限付与を、prepare/applyの二段階で行います。任意DB名・任意SQL・GRANT OPTION・DB削除は受け付けません。',
    inputSchema: z.object({
      action: z.enum(['prepare', 'apply', 'status', 'migrate']),
      project: projectSchema,
      approvalCode: z.string().optional(),
      reason: z.string().min(5).max(500),
    }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async ({ action, project, approvalCode, reason }) => {
    const target = getProject(project);
    try {
      if (action === 'prepare') {
        const code = crypto.randomBytes(24).toString('hex');
        approvals.set(code, { project, expiresAt: Date.now() + 60 * 60 * 1000 });
        await audit('project_database_provision.prepare', project, 'success', { reason, database: target.db.database });
        return result({
          success: true,
          approvalCode: code,
          expiresInMinutes: 60,
          approvalSummary: {
            project: target.label,
            database: target.db.database,
            runtimeUser: target.db.user,
            operations: ['CREATE DATABASE IF NOT EXISTS', '対象DB限定のSELECT/INSERT/UPDATE/DELETE/REFERENCES付与', '接続検証', '監査ログ保存'],
            prohibited: ['任意SQL', '全DB権限', 'GRANT OPTION', 'DB削除', 'ユーザー削除'],
            note: '承認後はapplyを実行し、許可済み範囲内で途中確認しません。'
          }
        });
      }

      if (action === 'status') {
        try {
          const verified = await verifyRuntime(project);
          return result({ success: true, project, database: target.db.database, ...verified });
        } catch (error) {
          return result({ success: true, project, database: target.db.database, connected: false, error: String(error) });
        }
      }

      const approval = approvalCode ? approvals.get(approvalCode) : undefined;
      if (!approval || approval.project !== project || approval.expiresAt < Date.now()) {
        throw new Error('有効な事前承認コードがありません。最初にprepareを実行し、ユーザー承認を得てください');
      }

      if (action === 'apply') {
        const connection = await adminConnection(project);
        try {
          await connection.query(`CREATE DATABASE IF NOT EXISTS ${identifier(target.db.database)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
          await connection.query(runtimeGrantSql(project));
        } finally {
          await connection.end();
        }
        approvals.delete(approvalCode!);
        const verified = await verifyRuntime(project);
        await audit('project_database_provision.apply', project, 'success', {
          reason, database: target.db.database, runtimeUser: target.db.user
        });
        return result({ success: true, project, database: target.db.database, runtimePrivileges: ['SELECT','INSERT','UPDATE','DELETE','REFERENCES'], ...verified });
      }

      const root = await rootCredentials();
      const { stdout, stderr } = await execFileAsync(PHP_BIN, ['artisan', 'migrate', '--force'], {
        cwd: target.laravelRoot, timeout: 180000, maxBuffer: 2 * 1024 * 1024,
        env: {
          ...process.env,
          DB_CONNECTION: 'mysql',
          DB_HOST: target.db.host,
          DB_PORT: String(target.db.port),
          DB_DATABASE: target.db.database,
          DB_USERNAME: 'root',
          DB_PASSWORD: root.password,
        }
      });
      approvals.delete(approvalCode!);
      await audit('project_database_provision.migrate', project, 'success', { reason, database: target.db.database });
      return result({ success: true, project, database: target.db.database, command: 'php artisan migrate --force', stdout, stderr });
    } catch (error) {
      await audit('project_database_provision.' + action, project, 'failed', { reason, error: String(error) });
      throw error;
    }
  });
}
