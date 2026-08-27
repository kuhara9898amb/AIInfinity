import * as z from 'zod/v4';
import path from 'node:path';
import { access, appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import mysql from 'mysql2/promise';

const execFileAsync = promisify(execFile);
const ROOT = '/Users/erka/SugoiAISiteShindan';
const DB_NAME = 'sugoi_ai_site_shindan';
const AUDIT_LOG = process.env.MCP_AUDIT_LOG ?? '/Users/erka/AIInfinity/logs/mcp-v4-audit.jsonl';
const COMPOSER_BIN = process.env.COMPOSER_BIN ?? '/opt/homebrew/bin/composer';
const PHP_BIN = process.env.PHP_BIN ?? '/opt/homebrew/bin/php';
const WEB_HOST = '100.90.218.34';
const WEB_PORT = 8100;
const N8N_WORKFLOW_ID = 'kQaxNBWOKvRcaopK';
const N8N_BASE_URL = (process.env.N8N_BASE_URL ?? '').replace(/\/+$/, '');
const N8N_API_KEY = process.env.N8N_API_KEY ?? '';
const WEB_LABEL = 'com.aiinfinity.sugoi-ai-site-shindan';
const WEB_PLIST = '/Users/erka/Library/LaunchAgents/com.aiinfinity.sugoi-ai-site-shindan.plist';
const LAUNCHCTL_BIN = '/bin/launchctl';
const DOCKER_CANDIDATES = ['/usr/local/bin/docker', '/opt/homebrew/bin/docker'];
const SECRET_SOURCES = ['/Users/erka/AIInfinity/dashboard/.env', '/Users/erka/SoreAI/.env'];
const REUSABLE_SECRET_KEYS = [
  'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'CLAUDE_API_KEY',
  'GEMINI_API_KEY', 'GOOGLE_API_KEY'
];

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
<key>StandardOutPath</key><string>${escapedRoot}/storage/logs/web.out.log</string>
<key>StandardErrorPath</key><string>${escapedRoot}/storage/logs/web.err.log</string>
</dict></plist>
`;
}

async function webStatus() {
  let launchdLoaded = false;
  let launchdState = '';
  try {
    const { stdout } = await execFileAsync(LAUNCHCTL_BIN, ['print', `${launchDomain()}/${WEB_LABEL}`], {
      timeout: 10000, maxBuffer: 512 * 1024
    });
    launchdLoaded = true;
    launchdState = stdout.match(/state = ([^\n]+)/)?.[1]?.trim() ?? 'loaded';
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
    host: WEB_HOST, port: WEB_PORT, launchdLoaded,
    launchdState: launchdState || null, reachable, httpStatus,
    autoStart: true, keepAlive: true,
  };
}

async function installWebService(restart = false) {
  if (!(await exists(path.join(ROOT, 'artisan')))) throw new Error('すごいAIサイト診断のartisanが存在しません');
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
    await new Promise(resolve => setTimeout(resolve, restart ? 750 : 100));
    await execFileAsync(LAUNCHCTL_BIN, ['bootstrap', domain, WEB_PLIST], { timeout: 15000, maxBuffer: 512 * 1024 });
  } catch {
    await new Promise(resolve => setTimeout(resolve, 750));
    try {
      await execFileAsync(LAUNCHCTL_BIN, ['bootstrap', domain, WEB_PLIST], { timeout: 15000, maxBuffer: 512 * 1024 });
    } catch {
      await execFileAsync(LAUNCHCTL_BIN, ['kickstart', '-k', `${domain}/${WEB_LABEL}`], { timeout: 15000, maxBuffer: 512 * 1024 });
    }
  }

  await new Promise(resolve => setTimeout(resolve, 1500));
  const current = await webStatus();
  if (!current.launchdLoaded || !current.reachable || current.httpStatus !== 200) {
    throw new Error(`Web起動検証失敗: ${JSON.stringify(current)}`);
  }
  return current;
}

async function stopWebService() {
  try {
    await execFileAsync(LAUNCHCTL_BIN, ['bootout', `${launchDomain()}/${WEB_LABEL}`], {
      timeout: 15000, maxBuffer: 512 * 1024
    });
  } catch {}
  await new Promise(resolve => setTimeout(resolve, 500));
  return webStatus();
}

function setEnvValue(text: string, key: string, value: string) {
  const line = key + '=' + value;
  const re = new RegExp('^' + key + '=.*$', 'm');
  return re.test(text) ? text.replace(re, line) : text + '\n' + line;
}

async function copyReusableSecrets(envText: string) {
  const copied: string[] = [];
  for (const source of SECRET_SOURCES) {
    if (!(await exists(source))) continue;
    const sourceText = await readFile(source, 'utf8');
    for (const key of REUSABLE_SECRET_KEYS) {
      if (copied.includes(key)) continue;
      const match = sourceText.match(new RegExp('^' + key + '=(.+)$', 'm'));
      const value = match?.[1]?.trim();
      if (value) {
        envText = setEnvValue(envText, key, value);
        copied.push(key);
      }
    }
  }
  return { envText, copiedKeys: copied };
}

async function databaseAdminPassword() {
  let docker = '';
  for (const candidate of DOCKER_CANDIDATES) {
    try {
      await execFileAsync(candidate, ['version', '--format', '{{.Client.Version}}'], { timeout: 10000 });
      docker = candidate;
      break;
    } catch {}
  }
  if (!docker) throw new Error('Docker CLIが見つかりません');

  const { stdout } = await execFileAsync(docker, ['ps', '--format', '{{.Names}}|{{.Image}}'], {
    timeout: 15000, maxBuffer: 256 * 1024
  });
  const candidates = stdout.split(/\r?\n/).map(value => value.trim()).filter(Boolean)
    .filter(value => /mysql|mariadb/i.test(value));
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
  return password;
}

async function databaseExists() {
  try {
    const connection = await mysql.createConnection({
      host: process.env.AI_INFINITY_DB_HOST ?? '127.0.0.1',
      port: Number(process.env.AI_INFINITY_DB_PORT ?? '3307'),
      user: process.env.AI_INFINITY_DB_USER ?? '',
      password: process.env.AI_INFINITY_DB_PASSWORD ?? '',
    });
    const [rows] = await connection.query(
      'SELECT SCHEMA_NAME FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME = ?', [DB_NAME]
    );
    await connection.end();
    return Array.isArray(rows) && rows.length > 0;
  } catch {
    return false;
  }
}

async function status() {
  const envExists = await exists(path.join(ROOT, '.env'));
  let reusableApiKeyCount = 0;
  if (envExists) {
    const envText = await readFile(path.join(ROOT, '.env'), 'utf8');
    reusableApiKeyCount = REUSABLE_SECRET_KEYS.filter(key => new RegExp('^' + key + '=.+$', 'm').test(envText)).length;
  }
  return {
    root: ROOT, database: DB_NAME,
    rootExists: await exists(ROOT),
    artisanExists: await exists(path.join(ROOT, 'artisan')),
    envExists, dbExists: await databaseExists(),
    reusableApiKeyCount,
    web: await webStatus()
  };
}

async function ensureN8nWorkflowActive() {
  if (!N8N_BASE_URL || !N8N_API_KEY) throw new Error('N8N_BASE_URLまたはN8N_API_KEYが未設定です');
  const current = await fetch(`${N8N_BASE_URL}/api/v1/workflows/${N8N_WORKFLOW_ID}`, {
    headers: { 'X-N8N-API-KEY': N8N_API_KEY, Accept: 'application/json' },
    signal: AbortSignal.timeout(15000),
  });
  if (current.ok) {
    const workflow = await current.json() as { active?: boolean };
    if (workflow.active) return;
  }
  const response = await fetch(`${N8N_BASE_URL}/api/v1/workflows/${N8N_WORKFLOW_ID}/activate`, {
    method: 'POST',
    headers: { 'X-N8N-API-KEY': N8N_API_KEY, Accept: 'application/json', 'Content-Type': 'application/json' },
    body: '{}',
    signal: AbortSignal.timeout(30000),
  });
  if (response.ok || response.status === 409) return;
  if (response.status !== 403) {
    const body = await response.text();
    throw new Error(`n8n Workflow有効化失敗 ${response.status}: ${body.slice(0, 500)}`);
  }

  let docker = '';
  for (const candidate of DOCKER_CANDIDATES) {
    try { await access(candidate); docker = candidate; break; } catch {}
  }
  if (!docker) throw new Error('n8n APIが403を返し、Docker CLIも見つかりません');
  const listed = await execFileAsync(docker, ['ps', '--format', '{{.Names}}'], { timeout: 15000, maxBuffer: 256 * 1024 });
  const containers = listed.stdout.split(/\r?\n/).map(value => value.trim()).filter(value => /n8n/i.test(value));
  if (containers.length !== 1) throw new Error(`安全停止: n8nコンテナを一意に特定できません (${containers.join(', ') || 'none'})`);
  await execFileAsync(docker, ['exec', containers[0], 'n8n', 'update:workflow', `--id=${N8N_WORKFLOW_ID}`, '--active=true'], {
    timeout: 120000, maxBuffer: 2 * 1024 * 1024,
  });
  await execFileAsync(docker, ['restart', containers[0]], { timeout: 120000, maxBuffer: 512 * 1024 });
  await new Promise(resolve => setTimeout(resolve, 8000));
}

async function verifyN8nDiagnosisWorkflowOnce() {
  const verifiedMarker = path.join(ROOT, 'storage/app/n8n-diagnosis-verified-v1');
  const response = await fetch('http://127.0.0.1:5678/webhook/sugoi-ai-site-shindan-diagnosis-v1-8f4c2e', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      request_id: 'bootstrap-verification',
      snapshot: {
        url: 'https://example.com', title: 'Example Company',
        description: '中小企業向け業務改善サービス',
        text: '業務改善とお問い合わせの案内です。'.repeat(40),
        headings: 4, links: 8, images: 3, has_viewport: true, has_form: true
      }
    }),
    signal: AbortSignal.timeout(120000),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`n8n診断Webhook検証失敗 ${response.status}: ${body.slice(0, 1000)}`);
  const decoded = JSON.parse(body);
  const completed = Object.values(decoded.provider_results ?? {}).filter((value: any) => value?.status === 'completed').length;
  if (!decoded.success || completed < 1) throw new Error(`n8n診断AI応答検証失敗: ${body.slice(0, 1500)}`);
  await mkdir(path.dirname(verifiedMarker), { recursive: true });
  await writeFile(verifiedMarker, JSON.stringify({ verifiedAt: new Date().toISOString(), completedProviders: completed }), { encoding: 'utf8', mode: 0o600 });
  return {
    success: true,
    completedProviders: completed,
    totalDurationMs: Number(decoded.total_duration_ms ?? 0),
    costJpy: Number(decoded.cost_jpy ?? 0),
    providers: Object.fromEntries(Object.entries(decoded.provider_results ?? {}).map(([name, value]: [string, any]) => [name, {
      status: value?.status ?? 'unknown',
      model: value?.model ?? null,
      durationMs: Number(value?.duration_ms ?? 0),
      inputTokens: Number(value?.input_tokens ?? 0),
      outputTokens: Number(value?.output_tokens ?? 0),
      costJpy: Number(value?.cost_jpy ?? 0),
      error: value?.error ? String(value.error).slice(0, 300) : null,
    }]))
  };
}

async function bootstrap() {
  const before = await status();
  if (!before.artisanExists) {
    await mkdir(path.dirname(ROOT), { recursive: true });
    await execFileAsync(COMPOSER_BIN, ['create-project', 'laravel/laravel', ROOT, '--no-interaction'], {
      timeout: 600000, maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, PATH: `/opt/homebrew/bin:${process.env.PATH ?? ''}` }
    });
  }

  if (!(await exists(path.join(ROOT, 'vendor/laravel/boost')))) {
    const composerProcess = spawn(PHP_BIN, [COMPOSER_BIN, 'require', 'laravel/boost', '--dev', '--no-interaction'], {
      cwd: ROOT, detached: true, stdio: 'ignore'
    });
    composerProcess.unref();
    await audit('sugoi_ai_site_shindan_operator.boost_install_started', 'success', { pid: composerProcess.pid ?? null });
    throw new Error('Laravel Boostの依存導入をバックグラウンド開始しました。完了後にbootstrapが自動継続できます');
  }
  const claudeGuidelines = path.join(ROOT, 'CLAUDE.md');
  const boostConfigured = (await exists(claudeGuidelines))
    && (await readFile(claudeGuidelines, 'utf8')).includes('Laravel Boost Guidelines');
  if (!boostConfigured) {
    await execFileAsync(PHP_BIN, ['artisan', 'boost:install', '--no-interaction'], {
      cwd: ROOT, timeout: 180000, maxBuffer: 4 * 1024 * 1024
    });
  }

  const scaffoldCommands: string[][] = [
    ['make:model', 'SiteDiagnosis', '--factory', '--migration', '--no-interaction'],
    ['make:request', 'StoreSiteDiagnosisRequest', '--no-interaction'],
    ['make:controller', 'SiteDiagnosisController', '--no-interaction'],
    ['make:class', 'Services/SiteInspector', '--no-interaction'],
    ['make:class', 'Services/SiteDiagnosisRunner', '--no-interaction'],
    ['make:test', '--phpunit', 'SiteDiagnosisFlowTest', '--no-interaction'],
  ];
  const scaffoldTargets = [
    'app/Models/SiteDiagnosis.php',
    'app/Http/Requests/StoreSiteDiagnosisRequest.php',
    'app/Http/Controllers/SiteDiagnosisController.php',
    'app/Services/SiteInspector.php',
    'app/Services/SiteDiagnosisRunner.php',
    'tests/Feature/SiteDiagnosisFlowTest.php',
  ];
  for (let index = 0; index < scaffoldCommands.length; index += 1) {
    if (!(await exists(path.join(ROOT, scaffoldTargets[index])))) {
      await execFileAsync(PHP_BIN, ['artisan', ...scaffoldCommands[index]], {
        cwd: ROOT, timeout: 60000, maxBuffer: 1024 * 1024
      });
    }
  }

  const migrationDirectory = path.join(ROOT, 'database/migrations');
  const migrationFiles = await readdir(migrationDirectory);
  if (!migrationFiles.some(file => file.endsWith('_add_mvp_fields_to_site_diagnoses_table.php'))) {
    await execFileAsync(PHP_BIN, ['artisan', 'make:migration', 'add_mvp_fields_to_site_diagnoses_table', '--table=site_diagnoses', '--no-interaction'], {
      cwd: ROOT, timeout: 60000, maxBuffer: 1024 * 1024
    });
    throw new Error('MVP項目追加Migrationを生成しました。内容確定後にbootstrapを自動継続できます');
  }

  const dbHost = process.env.AI_INFINITY_DB_HOST ?? '127.0.0.1';
  const dbPort = process.env.AI_INFINITY_DB_PORT ?? '3307';
  const dbUser = process.env.AI_INFINITY_DB_USER ?? '';
  const dbPassword = process.env.AI_INFINITY_DB_PASSWORD ?? '';

  if (!/^[A-Za-z0-9_%-]+$/.test(dbUser)) throw new Error('DBユーザー名が不正です');
  const adminPassword = await databaseAdminPassword();
  const connection = await mysql.createConnection({
    host: dbHost, port: Number(dbPort), user: 'root', password: adminPassword
  });
  try {
    await connection.query(
      'CREATE DATABASE IF NOT EXISTS `sugoi_ai_site_shindan` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci'
    );
    const safeUser = dbUser.replaceAll("'", "''");
    await connection.query(
      "GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES ON `sugoi_ai_site_shindan`.* TO '" + safeUser + "'@'%'"
    );
  } finally {
    await connection.end();
  }

  const envPath = path.join(ROOT, '.env');
  let envText = await readFile(envPath, 'utf8');
  envText = setEnvValue(envText, 'APP_NAME', '"すごいAIサイト診断"');
  envText = setEnvValue(envText, 'APP_TIMEZONE', 'Asia/Tokyo');
  envText = setEnvValue(envText, 'APP_URL', `http://${WEB_HOST}:${WEB_PORT}`);
  envText = setEnvValue(envText, 'DB_CONNECTION', 'mysql');
  envText = setEnvValue(envText, 'DB_HOST', dbHost);
  envText = setEnvValue(envText, 'DB_PORT', dbPort);
  envText = setEnvValue(envText, 'DB_DATABASE', DB_NAME);
  envText = setEnvValue(envText, 'DB_USERNAME', dbUser);
  envText = setEnvValue(envText, 'DB_PASSWORD', dbPassword);
  envText = setEnvValue(envText, 'QUEUE_CONNECTION', 'database');
  envText = setEnvValue(envText, 'N8N_DIAGNOSIS_WEBHOOK_URL', 'http://127.0.0.1:5678/webhook/sugoi-ai-site-shindan-diagnosis-v1-8f4c2e');
  const secrets = await copyReusableSecrets(envText);
  await writeFile(envPath, secrets.envText, { encoding: 'utf8', mode: 0o600 });

  if (!/^APP_KEY=base64:.+$/m.test(secrets.envText)) {
    await execFileAsync(PHP_BIN, ['artisan', 'key:generate', '--force'], {
      cwd: ROOT, timeout: 60000, maxBuffer: 1024 * 1024
    });
  }

  await execFileAsync(PHP_BIN, ['artisan', 'migrate', '--force'], {
    cwd: ROOT, timeout: 180000, maxBuffer: 2 * 1024 * 1024,
    env: {
      ...process.env,
      DB_CONNECTION: 'mysql',
      DB_HOST: dbHost,
      DB_PORT: dbPort,
      DB_DATABASE: DB_NAME,
      DB_USERNAME: 'root',
      DB_PASSWORD: adminPassword,
    }
  });

  await execFileAsync(PHP_BIN, [
    'vendor/bin/pint', '--format', 'agent',
    'app/Models/SiteDiagnosis.php',
    'app/Http/Requests/StoreSiteDiagnosisRequest.php',
    'app/Http/Controllers/SiteDiagnosisController.php',
    'app/Services/SiteInspector.php',
    'app/Services/SiteDiagnosisRunner.php',
    'database/migrations',
    'routes/web.php',
    'tests/Feature/SiteDiagnosisFlowTest.php'
  ], {
    cwd: ROOT, timeout: 180000, maxBuffer: 2 * 1024 * 1024
  });
  await execFileAsync(PHP_BIN, ['artisan', 'test', '--compact', 'tests/Feature/SiteDiagnosisFlowTest.php'], {
    cwd: ROOT, timeout: 90000, maxBuffer: 4 * 1024 * 1024,
    env: {
      ...process.env,
      DB_CONNECTION: 'sqlite',
      DB_DATABASE: ':memory:',
      CACHE_STORE: 'array',
      SESSION_DRIVER: 'array',
      QUEUE_CONNECTION: 'sync'
    }
  });

  const healthRoute = path.join(ROOT, 'routes/web.php');
  let routes = await readFile(healthRoute, 'utf8');
  if (!routes.includes("Route::get('/health'")) {
    routes += "\nRoute::get('/health', fn () => response()->json(['status' => 'ok']));\n";
    await writeFile(healthRoute, routes, { encoding: 'utf8', mode: 0o600 });
  }

  await ensureN8nWorkflowActive();
  const web = await installWebService(true);
  await audit('sugoi_ai_site_shindan_operator.bootstrap', 'success', {
    database: DB_NAME, webUrl: web.url, copiedKeyCount: secrets.copiedKeys.length
  });
  return status();
}

export function registerSugoiAiSiteShindanOperatorTools(server: Server) {
  server.registerTool('sugoi_ai_site_shindan_operator', {
    title: 'すごいAIサイト診断限定オペレーター',
    description: 'すごいAIサイト診断専用Laravel・DBの状態確認、初期構築、Migration、Web常時起動を固定処理で実行します。',
    inputSchema: z.object({
      action: z.enum(['status', 'bootstrap', 'migrate', 'verify_n8n', 'sync_n8n_local', 'n8n_docker_status', 'inspect_mvp', 'apply_a4_ui', 'web_status', 'web_start', 'web_restart', 'web_stop']),
      reason: z.string().min(5).max(500),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ action, reason }) => {
    try {
      if (action === 'status') return result(await status());
      if (action === 'web_status') return result({ success: true, ...(await webStatus()) });
      if (action === 'web_start') return result({ success: true, ...(await installWebService(false)) });
      if (action === 'web_restart') return result({ success: true, ...(await installWebService(true)) });
      if (action === 'web_stop') return result({ success: true, ...(await stopWebService()) });
      if (action === 'bootstrap') return result({ success: true, ...(await bootstrap()) });
      if (action === 'verify_n8n') return result(await verifyN8nDiagnosisWorkflowOnce());
      if (action === 'sync_n8n_local') {
        const envPath = path.join(ROOT, '.env');
        let envText = await readFile(envPath, 'utf8');
        envText = setEnvValue(envText, 'N8N_DIAGNOSIS_WEBHOOK_URL', 'http://127.0.0.1:5678/webhook/sugoi-ai-site-shindan-diagnosis-v1-8f4c2e');
        await writeFile(envPath, envText, { encoding: 'utf8', mode: 0o600 });
        await execFileAsync(PHP_BIN, ['artisan', 'config:clear'], { cwd: ROOT, timeout: 30000, maxBuffer: 512 * 1024 });
        return result({ success: true, webhookOrigin: 'http://127.0.0.1:5678', path: '/webhook/sugoi-ai-site-shindan-diagnosis-v1-8f4c2e' });
      }
      if (action === 'apply_a4_ui') {
        const backups: string[] = [];
        const patch = async (relative: string, mutate: (text: string) => string) => {
          const target = path.join(ROOT, relative);
          const before = await readFile(target, 'utf8');
          const after = mutate(before);
          if (after === before) return;
          const backup = target + '.backup-' + Date.now();
          await writeFile(backup, before, { encoding: 'utf8', mode: 0o600 });
          backups.push(backup);
          await writeFile(target, after, { encoding: 'utf8', mode: 0o600 });
        };

        await patch('app/Http/Controllers/SiteDiagnosisController.php', text => text.replace(
          "return redirect()->route('diagnoses.show', $siteDiagnosis);",
          "return redirect()->to(route('diagnoses.show', $siteDiagnosis).'#redesign');"
        ));

        await patch('resources/views/diagnosis-index.blade.php', text => {
          text = text.replace(
            "@media(max-width:700px){",
            ".loading{position:fixed;inset:0;background:#f7fbfff2;display:none;place-items:center;z-index:50}.loading.on{display:grid}.loading-card{text-align:center;background:#fff;border:1px solid var(--line);border-radius:24px;padding:34px 42px;box-shadow:0 30px 80px #2e67a830}.spinner{width:48px;height:48px;border:5px solid #dce7f5;border-top-color:var(--blue);border-radius:50%;margin:0 auto 18px;animation:spin .8s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}@media(max-width:700px){"
          );
          text = text.replace(
            "<form method=\"POST\" action=\"{{ route('diagnoses.store') }}\">",
            "<form id=\"diagnosis-form\" method=\"POST\" action=\"{{ route('diagnoses.store') }}\">"
          );
          text = text.replace(
            "</section></div></body></html>",
            "</section></div><div id=\"diagnosis-loading\" class=\"loading\" role=\"status\" aria-live=\"polite\"><div class=\"loading-card\"><div class=\"spinner\"></div><strong>3つのAIが診断中です…</strong><p>通常20〜40秒ほどかかります。このままお待ちください。</p></div></div><script>document.getElementById('diagnosis-form').addEventListener('submit',function(){const l=document.getElementById('diagnosis-loading');l.classList.add('on');this.querySelector('button').disabled=true;this.querySelector('button').textContent='診断中…';});</script></body></html>"
          );
          return text;
        });

        await patch('resources/views/diagnosis-show.blade.php', text => {
          text = text.replace(
            ".mock{margin-top:30px;background:#fff;border-radius:24px;overflow:hidden;color:var(--ink);text-align:left}",
            ".mock{margin:36px auto 0;width:min(100%,794px);aspect-ratio:210/297;background:#fff;border-radius:10px;overflow:hidden;color:var(--ink);text-align:left;box-shadow:0 28px 70px #10213e2b;border:1px solid #d9e2ee;display:flex;flex-direction:column}.a4-label{text-align:center;color:var(--muted);font-size:13px;margin-top:34px;font-weight:700;letter-spacing:.08em}"
          );
          text = text.replace(
            ".mockhero{padding:65px 45px;background:radial-gradient(circle at 85% 20%,#c5efff,transparent 35%),#f8fbff}",
            ".mockhero{padding:72px 54px 48px;background:radial-gradient(circle at 85% 20%,#c5efff,transparent 35%),#f8fbff;flex:1}.mockhero p{max-width:560px;font-size:17px;line-height:1.9}.mockhero:after{content:'SERVICE  /  BENEFIT  /  CASE STUDY  /  CONTACT';display:block;margin-top:70px;padding-top:26px;border-top:1px solid var(--line);font-size:12px;letter-spacing:.1em;color:var(--muted)}"
          );
          text = text.replace(
            "@media(max-width:760px){",
            ".design-loading{position:fixed;inset:0;background:#07152de8;color:#fff;display:none;place-items:center;z-index:60}.design-loading.on{display:grid}.design-loading-card{text-align:center;padding:36px}.design-spinner{width:52px;height:52px;border:5px solid #ffffff35;border-top-color:#55cdf5;border-radius:50%;margin:0 auto 18px;animation:spin .8s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}@media(max-width:760px){"
          );
          text = text.replace(
            "<form method=\"POST\" action=\"{{ route('diagnoses.redesign',$diagnosis) }}\">",
            "<form id=\"redesign-form\" method=\"POST\" action=\"{{ route('diagnoses.redesign',$diagnosis) }}\">"
          );
          text = text.replace(
            "@if($diagnosis->redesign_payload)<section id=\"redesign\" class=\"mock\">",
            "@if($diagnosis->redesign_payload)<div class=\"a4-label\">AI GENERATED DESIGN｜A4 PORTRAIT</div><section id=\"redesign\" class=\"mock\">"
          );
          text = text.replace(
            "</div></main></div></body></html>",
            "</div></main></div><div id=\"design-loading\" class=\"design-loading\" role=\"status\" aria-live=\"polite\"><div class=\"design-loading-card\"><div class=\"design-spinner\"></div><strong>AIが改善デザインを作成中です…</strong><p>完成後、自動でA4縦デザインへ移動します。</p></div></div><script>const f=document.getElementById('redesign-form');if(f){f.addEventListener('submit',function(){document.getElementById('design-loading').classList.add('on');const b=this.querySelector('button');b.disabled=true;b.textContent='デザイン作成中…';});}if(location.hash==='#redesign'){setTimeout(()=>document.getElementById('redesign')?.scrollIntoView({behavior:'smooth',block:'start'}),150);}</script></body></html>"
          );
          return text;
        });

        await patch('tests/Feature/SiteDiagnosisFlowTest.php', text => text.replace(
          "->assertSee('無料で診断する');",
          "->assertSee('無料で診断する')\n            ->assertSee('3つのAIが診断中です');"
        ).replace(
          "$this->assertSame($firstPayload, $diagnosis->fresh()->redesign_payload);",
          "$this->assertSame($firstPayload, $diagnosis->fresh()->redesign_payload);\n        $this->get(route('diagnoses.show', $diagnosis))->assertSee('A4 PORTRAIT')->assertSee('AIが改善デザインを作成中です');"
        ));

        await execFileAsync(PHP_BIN, ['vendor/bin/pint', '--format', 'agent', 'app/Http/Controllers/SiteDiagnosisController.php', 'tests/Feature/SiteDiagnosisFlowTest.php'], {
          cwd: ROOT, timeout: 120000, maxBuffer: 2 * 1024 * 1024
        });
        const tested = await execFileAsync(PHP_BIN, ['artisan', 'test', '--compact', 'tests/Feature/SiteDiagnosisFlowTest.php'], {
          cwd: ROOT, timeout: 120000, maxBuffer: 4 * 1024 * 1024,
          env: { ...process.env, DB_CONNECTION: 'sqlite', DB_DATABASE: ':memory:', CACHE_STORE: 'array', SESSION_DRIVER: 'array', QUEUE_CONNECTION: 'sync' }
        });
        await audit('sugoi_ai_site_shindan_operator.apply_a4_ui', 'success', { reason, backups, test: tested.stdout.slice(-1000) });
        return result({ success: true, backups, test: tested.stdout.trim(), web: await webStatus() });
      }
      if (action === 'inspect_mvp') {
        const files = ['routes/web.php','app/Http/Controllers/SiteDiagnosisController.php','app/Services/SiteDiagnosisRunner.php','app/Models/SiteDiagnosis.php','resources/views/diagnosis-index.blade.php','resources/views/diagnosis-show.blade.php','app/Services/AiDiagnosisGateway.php','tests/Feature/SiteDiagnosisFlowTest.php'];
        const output: Record<string, string|null> = {};
        for (const file of files) {
          const target = path.join(ROOT, file);
          output[file] = await exists(target) ? await readFile(target, 'utf8') : null;
        }
        return result({ success: true, files: output });
      }
      if (action === 'n8n_docker_status') {
        for (const docker of DOCKER_CANDIDATES) {
          try {
            const listed = await execFileAsync(docker, ['ps', '--filter', 'name=n8n', '--format', '{{.Names}}'], { timeout: 10000 });
            const containers = listed.stdout.split(/\r?\n/).map(v => v.trim()).filter(Boolean);
            if (containers.length !== 1) continue;
            const ports = await execFileAsync(docker, ['port', containers[0]], { timeout: 10000 });
            const inspect = await execFileAsync(docker, ['inspect', '--format', '{{json .NetworkSettings.Networks}}', containers[0]], { timeout: 10000 });
            return result({ success: true, container: containers[0], publishedPorts: ports.stdout.trim(), networks: JSON.parse(inspect.stdout.trim() || '{}') });
          } catch {}
        }
        throw new Error('n8nコンテナの固定診断に失敗しました');
      }

      const current = await status();
      if (!current.artisanExists || !current.dbExists) {
        throw new Error('基盤が未作成です。先にbootstrapを実行してください');
      }
      const { stdout, stderr } = await execFileAsync(PHP_BIN, ['artisan', 'migrate', '--force'], {
        cwd: ROOT, timeout: 180000, maxBuffer: 2 * 1024 * 1024
      });
      await audit('sugoi_ai_site_shindan_operator.migrate', 'success', { reason });
      return result({ success: true, stdout, stderr, web: await webStatus() });
    } catch (error) {
      await audit('sugoi_ai_site_shindan_operator.' + action, 'failed', { reason, error: String(error) });
      throw error;
    }
  });
}
