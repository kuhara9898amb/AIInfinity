import * as z from 'zod/v4';
import path from 'node:path';
import { access, appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import mysql from 'mysql2/promise';

const execFileAsync = promisify(execFile);
const ROOT = process.env.SOREAI_LARAVEL_ROOT ?? '/Users/erka/SoreAI';
const DB_NAME = process.env.SOREAI_DB_NAME ?? 'sore_ai';
const AUDIT_LOG = process.env.MCP_AUDIT_LOG ?? '/Users/erka/AIInfinity/logs/mcp-v4-audit.jsonl';
const COMPOSER_BIN = process.env.COMPOSER_BIN ?? '/opt/homebrew/bin/composer';
const PHP_BIN = process.env.PHP_BIN ?? '/opt/homebrew/bin/php';
const WEB_HOST = process.env.SOREAI_WEB_HOST ?? '100.90.218.34';
const WEB_PORT = Number(process.env.SOREAI_WEB_PORT ?? '8099');
const WEB_LABEL = 'com.aiinfinity.soreai-dashboard';
const WEB_PLIST = '/Users/erka/Library/LaunchAgents/com.aiinfinity.soreai-dashboard.plist';
const LAUNCHCTL_BIN = '/bin/launchctl';

type Server = { registerTool: (name: string, config: any, handler: (input: any) => Promise<any>) => void };

function result(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

async function exists(target: string) {
  try { await access(target); return true; } catch { return false; }
}

async function audit(action: string, status: 'success'|'failed', details: Record<string, unknown> = {}) {
  await mkdir(path.dirname(AUDIT_LOG), { recursive: true });
  const safe = JSON.parse(JSON.stringify(details, (key, value) =>
    /password|secret|token|api.?key|credential/i.test(key) ? '[REDACTED]' : value
  ));
  await appendFile(AUDIT_LOG, JSON.stringify({
    timestamp: new Date().toISOString(), action, target: ROOT, status, details: safe
  }) + '\n', { encoding: 'utf8', mode: 0o600 });
}

function launchDomain() {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 501;
  return `gui/${uid}`;
}

function webPlist() {
  const escapedRoot = ROOT.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${WEB_LABEL}</string>
<key>ProgramArguments</key><array>
<string>${PHP_BIN}</string><string>artisan</string><string>serve</string>
<string>--host=${WEB_HOST}</string><string>--port=${WEB_PORT}</string>
</array>
<key>WorkingDirectory</key><string>${escapedRoot}</string>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>ProcessType</key><string>Background</string>
<key>ThrottleInterval</key><integer>10</integer>
<key>StandardOutPath</key><string>${escapedRoot}/storage/logs/soreai-dashboard.out.log</string>
<key>StandardErrorPath</key><string>${escapedRoot}/storage/logs/soreai-dashboard.err.log</string>
</dict></plist>
`;
}

async function webStatus() {
  let launchdLoaded = false;
  let launchdDetail = '';
  try {
    const { stdout } = await execFileAsync(LAUNCHCTL_BIN, ['print', `${launchDomain()}/${WEB_LABEL}`], {
      timeout: 10000, maxBuffer: 512 * 1024
    });
    launchdLoaded = true;
    launchdDetail = stdout.match(/state = ([^\n]+)/)?.[1]?.trim() ?? 'loaded';
  } catch {}

  let reachable = false;
  let httpStatus: number|null = null;
  try {
    const response = await fetch(`http://${WEB_HOST}:${WEB_PORT}/health`, { signal: AbortSignal.timeout(5000) });
    httpStatus = response.status;
    reachable = response.status === 200;
  } catch {}

  return {
    url: `http://${WEB_HOST}:${WEB_PORT}`,
    healthUrl: `http://${WEB_HOST}:${WEB_PORT}/health`,
    host: WEB_HOST,
    port: WEB_PORT,
    launchdLoaded,
    launchdState: launchdDetail || null,
    reachable,
    httpStatus,
    autoStart: true,
    keepAlive: true,
  };
}

async function installWebService(restart = false) {
  if (!(await exists(path.join(ROOT, 'artisan')))) throw new Error('それAIのartisanが存在しません');
  await mkdir(path.dirname(WEB_PLIST), { recursive: true });
  await mkdir(path.join(ROOT, 'storage/logs'), { recursive: true });

  if (await exists(WEB_PLIST)) {
    const before = await readFile(WEB_PLIST, 'utf8');
    await writeFile(`${WEB_PLIST}.backup-${Date.now()}`, before, { encoding: 'utf8', mode: 0o600 });
  }
  await writeFile(WEB_PLIST, webPlist(), { encoding: 'utf8', mode: 0o600 });

  const domain = launchDomain();
  if (restart) {
    try { await execFileAsync(LAUNCHCTL_BIN, ['bootout', `${domain}/${WEB_LABEL}`], { timeout: 15000 }); } catch {}
  }
  try {
    await execFileAsync(LAUNCHCTL_BIN, ['bootstrap', domain, WEB_PLIST], { timeout: 15000, maxBuffer: 512 * 1024 });
  } catch {
    await execFileAsync(LAUNCHCTL_BIN, ['kickstart', '-k', `${domain}/${WEB_LABEL}`], { timeout: 15000, maxBuffer: 512 * 1024 });
  }

  await new Promise(resolve => setTimeout(resolve, 1500));
  const current = await webStatus();
  if (!current.launchdLoaded || !current.reachable || current.httpStatus !== 200) {
    throw new Error(`それAI Web起動検証失敗: ${JSON.stringify(current)}`);
  }
  return current;
}

async function stopWebService() {
  const domain = launchDomain();
  try {
    await execFileAsync(LAUNCHCTL_BIN, ['bootout', `${domain}/${WEB_LABEL}`], { timeout: 15000, maxBuffer: 512 * 1024 });
  } catch {}
  await new Promise(resolve => setTimeout(resolve, 500));
  return webStatus();
}

async function status() {
  const rootExists = await exists(ROOT);
  const artisanExists = await exists(path.join(ROOT, 'artisan'));
  const envExists = await exists(path.join(ROOT, '.env'));
  let dbExists = false;
  try {
    const connection = await mysql.createConnection({
      host: process.env.SOREAI_DB_HOST ?? process.env.AI_INFINITY_DB_HOST ?? '127.0.0.1',
      port: Number(process.env.SOREAI_DB_PORT ?? process.env.AI_INFINITY_DB_PORT ?? '3307'),
      user: process.env.SOREAI_DB_USER ?? process.env.AI_INFINITY_DB_USER ?? '',
      password: process.env.SOREAI_DB_PASSWORD ?? process.env.AI_INFINITY_DB_PASSWORD ?? '',
    });
    const [rows] = await connection.query(
      'SELECT SCHEMA_NAME FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME = ?', [DB_NAME]
    );
    dbExists = Array.isArray(rows) && rows.length > 0;
    await connection.end();
  } catch {}
  return { root: ROOT, database: DB_NAME, rootExists, artisanExists, envExists, dbExists, web: await webStatus() };
}

async function bootstrap() {
  const before = await status();
  if (!before.artisanExists) {
    await mkdir(path.dirname(ROOT), { recursive: true });
    await execFileAsync(PHP_BIN, [COMPOSER_BIN, 'create-project', 'laravel/laravel', ROOT, '--no-interaction'], {
      timeout: 600000, maxBuffer: 4 * 1024 * 1024
    });
  }

  const dbHost = process.env.SOREAI_DB_HOST ?? process.env.AI_INFINITY_DB_HOST ?? '127.0.0.1';
  const dbPort = process.env.SOREAI_DB_PORT ?? process.env.AI_INFINITY_DB_PORT ?? '3307';
  const dbUser = process.env.SOREAI_DB_USER ?? process.env.AI_INFINITY_DB_USER ?? '';
  const dbPassword = process.env.SOREAI_DB_PASSWORD ?? process.env.AI_INFINITY_DB_PASSWORD ?? '';

  const connection = await mysql.createConnection({
    host: dbHost, port: Number(dbPort), user: dbUser, password: dbPassword
  });
  await connection.query(
    'CREATE DATABASE IF NOT EXISTS `sore_ai` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci'
  );
  await connection.end();

  const envPath = path.join(ROOT, '.env');
  let envText = await readFile(envPath, 'utf8');
  const setEnv = (key: string, value: string) => {
    const line = key + '=' + value;
    const re = new RegExp('^' + key + '=.*$', 'm');
    envText = re.test(envText) ? envText.replace(re, line) : envText + '\n' + line;
  };
  setEnv('APP_NAME', '"それAI"');
  setEnv('APP_TIMEZONE', 'Asia/Tokyo');
  setEnv('APP_URL', `http://${WEB_HOST}:${WEB_PORT}`);
  setEnv('DB_CONNECTION', 'mysql');
  setEnv('DB_HOST', dbHost);
  setEnv('DB_PORT', dbPort);
  setEnv('DB_DATABASE', DB_NAME);
  setEnv('DB_USERNAME', dbUser);
  setEnv('DB_PASSWORD', dbPassword);
  await writeFile(envPath, envText, { encoding: 'utf8', mode: 0o600 });

  if (!process.env.APP_KEY && !/^APP_KEY=base64:.+$/m.test(envText)) {
    await execFileAsync(PHP_BIN, ['artisan', 'key:generate', '--force'], {
      cwd: ROOT, timeout: 60000, maxBuffer: 1024 * 1024
    });
  }
  const web = await installWebService(true);
  await audit('soreai_operator.bootstrap', 'success', { database: DB_NAME, webUrl: web.url });
  return status();
}

export function registerSoreAiOperatorTools(server: Server) {
  server.registerTool('soreai_operator', {
    title: 'それAI限定オペレーター',
    description: 'それAI専用Laravel・DBの状態確認、初期構築、マイグレーション、Webサーバーの常時起動・停止・再起動・自動復帰を固定処理で実行します。',
    inputSchema: z.object({
      action: z.enum(['status', 'bootstrap', 'migrate', 'web_status', 'web_start', 'web_restart', 'web_stop']),
      reason: z.string().min(5).max(500),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ action, reason }) => {
    try {
      if (action === 'status') return result(await status());
      if (action === 'web_status') return result({ success: true, ...(await webStatus()) });
      if (action === 'web_start') {
        const web = await installWebService(false);
        await audit('soreai_operator.web_start', 'success', { reason, webUrl: web.url });
        return result({ success: true, ...web });
      }
      if (action === 'web_restart') {
        const web = await installWebService(true);
        await audit('soreai_operator.web_restart', 'success', { reason, webUrl: web.url });
        return result({ success: true, ...web });
      }
      if (action === 'web_stop') {
        const web = await stopWebService();
        await audit('soreai_operator.web_stop', 'success', { reason });
        return result({ success: true, ...web });
      }
      if (action === 'bootstrap') return result({ success: true, ...(await bootstrap()) });
      const current = await status();
      if (!current.artisanExists || !current.dbExists) {
        throw new Error('それAI基盤が未作成です。先にbootstrapを実行してください');
      }
      const { stdout, stderr } = await execFileAsync(PHP_BIN, ['artisan', 'migrate', '--force'], {
        cwd: ROOT, timeout: 180000, maxBuffer: 2 * 1024 * 1024
      });
      await audit('soreai_operator.migrate', 'success', { reason });
      return result({ success: true, stdout, stderr, web: await webStatus() });
    } catch (error) {
      await audit('soreai_operator.' + action, 'failed', { reason, error: String(error) });
      throw error;
    }
  });
}
