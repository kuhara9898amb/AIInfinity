import * as z from 'zod/v4';
import path from 'node:path';
import { access, appendFile, cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const ROOT = '/Users/erka/AILeadCreator';
const STAGING_ROOT = '/Users/erka/AIInfinity/staging/ai-lead-creator-laravel';
const COMPOSER_BIN = process.env.COMPOSER_BIN ?? '/opt/homebrew/bin/composer';
const PHP_BIN = process.env.PHP_BIN ?? '/opt/homebrew/bin/php';
const GIT_BIN = '/usr/bin/git';
const WEB_HOST = '100.90.218.34';
const WEB_PORT = 8110;
const WEB_LABEL = 'com.aiinfinity.ai-lead-creator';
const WEB_PLIST = '/Users/erka/Library/LaunchAgents/com.aiinfinity.ai-lead-creator.plist';
const LAUNCHCTL_BIN = '/bin/launchctl';
const AUDIT_LOG = process.env.MCP_AUDIT_LOG ?? '/Users/erka/AIInfinity/logs/mcp-v4-audit.jsonl';

type Server = { registerTool: (name: string, config: any, handler: (input: any) => Promise<any>) => void };

function result(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}
function errorResult(error: unknown) {
  return { content: [{ type: 'text' as const, text: 'Error: ' + (error instanceof Error ? error.message : String(error)) }], isError: true };
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
function setEnvValue(text: string, key: string, value: string) {
  const line = key + '=' + value;
  const re = new RegExp('^' + key + '=.*$', 'm');
  return re.test(text) ? text.replace(re, line) : text + '\n' + line;
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
  let launchdState: string|null = null;
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
    host: WEB_HOST, port: WEB_PORT, launchdLoaded, launchdState, reachable, httpStatus,
    autoStart: true, keepAlive: true
  };
}
async function status() {
  const artisanExists = await exists(path.join(ROOT, 'artisan'));
  const vendorReady = await exists(path.join(ROOT, 'vendor/autoload.php'));
  const stagingReady = await exists(path.join(STAGING_ROOT, 'vendor/autoload.php'));
  const stagingStarted = await exists(STAGING_ROOT);
  const gitReady = await exists(path.join(ROOT, '.git'));
  return {
    success: true,
    root: ROOT,
    artisanExists,
    vendorReady,
    stagingStarted,
    stagingReady,
    gitReady,
    externalSending: false,
    apiKeysInApp: false,
    web: await webStatus()
  };
}
async function installWebService(restart = false) {
  if (!(await exists(path.join(ROOT, 'artisan')))) throw new Error('AIリードクリエイターのartisanが存在しません');
  await mkdir(path.dirname(WEB_PLIST), { recursive: true });
  await mkdir(path.join(ROOT, 'storage/logs'), { recursive: true });
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
    throw new Error('Web起動検証失敗: ' + JSON.stringify(current));
  }
  return current;
}
async function stopWebService() {
  try {
    await execFileAsync(LAUNCHCTL_BIN, ['bootout', `${launchDomain()}/${WEB_LABEL}`], { timeout: 15000, maxBuffer: 512 * 1024 });
  } catch {}
  return webStatus();
}
async function startComposerInstall() {
  if (await exists(STAGING_ROOT)) {
    return { started: false, reason: 'staging_exists', ready: await exists(path.join(STAGING_ROOT, 'vendor/autoload.php')) };
  }
  await mkdir(path.dirname(STAGING_ROOT), { recursive: true, mode: 0o700 });
  const child = spawn(COMPOSER_BIN, ['create-project', 'laravel/laravel', STAGING_ROOT, '--no-interaction'], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, PATH: `/opt/homebrew/bin:${process.env.PATH ?? ''}` }
  });
  child.unref();
  await audit('ai_lead_creator_operator.composer_started', 'success', { pid: child.pid ?? null, staging: STAGING_ROOT });
  return { started: true, pid: child.pid ?? null, ready: false };
}
async function initializeGit() {
  if (await exists(path.join(ROOT, '.git'))) return;
  await execFileAsync(GIT_BIN, ['init'], { cwd: ROOT, timeout: 30000, maxBuffer: 512 * 1024 });
  await execFileAsync(GIT_BIN, ['branch', '-M', 'main'], { cwd: ROOT, timeout: 30000, maxBuffer: 512 * 1024 });
  const { stdout } = await execFileAsync(GIT_BIN, ['ls-files', '--others', '--exclude-standard'], {
    cwd: ROOT, timeout: 30000, maxBuffer: 2 * 1024 * 1024
  });
  const files = stdout.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
  const forbidden = files.filter(file =>
    /(^|\/)(\.env(?:\.|$)|vendor(?:\/|$)|node_modules(?:\/|$)|storage\/logs(?:\/|$)|.*\.(?:pem|key|p12|pfx|sqlite)$)/i.test(file)
  );
  if (forbidden.length) throw new Error('Git初期化時に禁止ファイルを検出しました: ' + forbidden.join(', '));
  if (!files.length) throw new Error('Git初期化対象ファイルがありません');
  await execFileAsync(GIT_BIN, ['add', '--', ...files], { cwd: ROOT, timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
  await execFileAsync(GIT_BIN, ['commit', '-m', 'Initial AI Lead Creator local MVP'], {
    cwd: ROOT, timeout: 120000, maxBuffer: 4 * 1024 * 1024
  });
}
async function finishBootstrap() {
  if (!(await exists(path.join(STAGING_ROOT, 'vendor/autoload.php')))) {
    return { installing: true, ...(await startComposerInstall()) };
  }
  await mkdir(ROOT, { recursive: true, mode: 0o700 });
  await cp(STAGING_ROOT, ROOT, {
    recursive: true,
    force: false,
    errorOnExist: false,
    filter: source => {
      const relative = path.relative(STAGING_ROOT, source);
      return ![
        '.env',
        'routes/web.php',
        'resources/views/welcome.blade.php',
        'resources/project.json'
      ].includes(relative);
    }
  });
  const envExample = await readFile(path.join(ROOT, '.env.example'), 'utf8');
  let envText = envExample;
  envText = setEnvValue(envText, 'APP_NAME', '"AIリードクリエイター"');
  envText = setEnvValue(envText, 'APP_ENV', 'local');
  envText = setEnvValue(envText, 'APP_DEBUG', 'true');
  envText = setEnvValue(envText, 'APP_URL', `http://${WEB_HOST}:${WEB_PORT}`);
  envText = setEnvValue(envText, 'APP_TIMEZONE', 'Asia/Tokyo');
  envText = setEnvValue(envText, 'DB_CONNECTION', 'sqlite');
  envText = setEnvValue(envText, 'QUEUE_CONNECTION', 'sync');
  await writeFile(path.join(ROOT, '.env'), envText, { encoding: 'utf8', mode: 0o600 });
  await writeFile(path.join(ROOT, 'database/database.sqlite'), '', { encoding: 'utf8', mode: 0o600 });
  await execFileAsync(PHP_BIN, ['artisan', 'key:generate', '--force'], { cwd: ROOT, timeout: 60000, maxBuffer: 1024 * 1024 });
  let routes = await readFile(path.join(ROOT, 'routes/web.php'), 'utf8');
  if (!routes.includes("Route::get('/health'")) {
    routes += "\nRoute::get('/health', fn () => response()->json(['status' => 'ok', 'service' => 'ai-lead-creator']));\n";
    await writeFile(path.join(ROOT, 'routes/web.php'), routes, { encoding: 'utf8', mode: 0o600 });
  }
  await execFileAsync(PHP_BIN, ['artisan', 'config:clear'], { cwd: ROOT, timeout: 30000, maxBuffer: 512 * 1024 });
  await execFileAsync(PHP_BIN, ['artisan', 'route:list', '--path=health'], { cwd: ROOT, timeout: 30000, maxBuffer: 1024 * 1024 });
  await initializeGit();
  const web = await installWebService(true);
  await audit('ai_lead_creator_operator.bootstrap', 'success', { webUrl: web.url, gitInitialized: true, apiKeysCopied: 0 });
  return status();
}
export function registerAiLeadCreatorOperatorTools(server: Server) {
  server.registerTool('ai_lead_creator_operator', {
    title: 'AIリードクリエイター限定オペレーター',
    description: 'AIリードクリエイター専用の固定Laravelルート、固定ポート8110、Git初期化、Web常時起動だけを安全に管理します。外部送信・AI APIキー・任意コマンドは扱いません。',
    inputSchema: z.object({
      action: z.enum(['status','bootstrap','web_status','web_start','web_restart','web_stop']),
      reason: z.string().min(5).max(500)
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ action, reason }) => {
    try {
      if (action === 'status') return result(await status());
      if (action === 'web_status') return result({ success: true, ...(await webStatus()) });
      if (action === 'web_start') return result({ success: true, ...(await installWebService(false)) });
      if (action === 'web_restart') return result({ success: true, ...(await installWebService(true)) });
      if (action === 'web_stop') return result({ success: true, ...(await stopWebService()) });
      if (action === 'bootstrap') return result({ success: true, ...(await finishBootstrap()) });
      throw new Error('未対応actionです');
    } catch (error) {
      try { await audit('ai_lead_creator_operator.' + action, 'failed', { reason, error: String(error).slice(0, 2000) }); } catch {}
      return errorResult(error);
    }
  });
}
