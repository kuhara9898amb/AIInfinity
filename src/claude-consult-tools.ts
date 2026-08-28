import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import mysql, { type Pool, type ResultSetHeader } from 'mysql2/promise';
import * as z from 'zod/v4';

const execFileAsync = promisify(execFile);
const CONSULT_ROOT = '/Users/erka/AIInfinity/claude-consult';
const AUDIT_PATH = '/Users/erka/AIInfinity/logs/claude-consult.jsonl';
const CLAUDE_CANDIDATES = [
  '/Users/erka/.local/bin/claude',
  '/opt/homebrew/bin/claude',
  '/usr/local/bin/claude',
];
const TIMEOUT_MS = 180_000;
const MAX_BUFFER = 2 * 1024 * 1024;
const consultationPool = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT ?? 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 2,
  queueLimit: 0,
  multipleStatements: false,
});

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
  return { content: [{ type: 'text' as const, text: 'Error: ' + message }], isError: true };
}

function redact(value: string) {
  return value
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[REDACTED_EMAIL]')
    .replace(/(?:sk-ant-|sk-|Bearer\s+)[A-Za-z0-9_\-.]+/gi, '[REDACTED_SECRET]')
    .slice(0, 4000);
}

async function audit(
  action: string,
  status: 'success' | 'rejected' | 'failed',
  details: Record<string, unknown> = {},
) {
  await mkdir(path.dirname(AUDIT_PATH), { recursive: true });
  await appendFile(
    AUDIT_PATH,
    JSON.stringify({ timestamp: new Date().toISOString(), action, status, ...details }) + '\n',
    { encoding: 'utf8', mode: 0o600 },
  );
}

async function resolveClaudeBin() {
  for (const candidate of CLAUDE_CANDIDATES) {
    try {
      await access(candidate);
      return candidate;
    } catch {}
  }
  throw new Error('Claude Codeが固定許可パスに見つかりません');
}

function childEnv() {
  const env = { ...process.env };
  const blocked = [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    'CLAUDE_CODE_USE_FOUNDRY',
  ];
  for (const key of blocked) delete env[key];
  env.PATH = '/Users/erka/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';
  return env;
}

function hasPaidProviderEnvironment() {
  return [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    'CLAUDE_CODE_USE_FOUNDRY',
  ].filter(key => Boolean(process.env[key]));
}

async function authStatus(claudeBin: string) {
  const { stdout } = await execFileAsync(claudeBin, ['auth', 'status', '--json'], {
    cwd: CONSULT_ROOT,
    env: childEnv(),
    timeout: 15_000,
    maxBuffer: 256 * 1024,
  });
  const raw = stdout.trim();
  const normalized = raw.toLowerCase();
  const subscriptionSignal = /(claude\.ai|subscription|oauth|\bpro\b|\bmax\b)/i.test(raw);
  const paidProviderSignal = /(api[_ -]?key|console|bedrock|vertex|foundry)/i.test(raw);
  return {
    subscriptionAuthenticated: subscriptionSignal && !paidProviderSignal,
    safeStatus: redact(raw),
    rawNormalized: normalized,
  };
}

function authMetadata(rawNormalized: string) {
  let authMethod: string | null = null;
  let subscriptionType: string | null = null;
  try {
    const parsed = JSON.parse(rawNormalized) as Record<string, unknown>;
    authMethod = typeof parsed.authmethod === 'string' ? parsed.authmethod : null;
    subscriptionType = typeof parsed.subscriptiontype === 'string' ? parsed.subscriptiontype : null;
  } catch {}
  return { authMethod, subscriptionType };
}

function rejectSecrets(question: string, context: string) {
  const combined = question + '\n' + context;
  const patterns = [
    /(?:sk-ant-|sk-)[A-Za-z0-9_\-.]{12,}/i,
    /Bearer\s+[A-Za-z0-9_\-.]{12,}/i,
    /(?:API_KEY|PASSWORD|SECRET|TOKEN)\s*[=:]\s*\S+/i,
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  ];
  if (patterns.some(pattern => pattern.test(combined))) {
    throw new Error('質問または参考情報に機密情報らしき文字列が含まれるため拒否しました');
  }
}

function extractClaudeResult(stdout: string) {
  const trimmed = stdout.trim();
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    return {
      response: typeof parsed.result === 'string' ? parsed.result : parsed,
      session_id: typeof parsed.session_id === 'string' ? parsed.session_id : null,
      usage: parsed.usage ?? null,
      cost_usd: parsed.total_cost_usd ?? null,
    };
  } catch {
    return { response: redact(trimmed), session_id: null, usage: null, cost_usd: null };
  }
}

async function saveConsultation(
  pool: Pool,
  input: {
    question: string;
    context: string;
    response: unknown;
    reason: string;
    durationMs: number;
    sessionId: string | null;
    usage: unknown;
    costUsd: unknown;
    authMethod: string | null;
    subscriptionType: string | null;
  },
) {
  const responseText = typeof input.response === 'string'
    ? input.response
    : JSON.stringify(input.response, null, 2);
  const numericCost = typeof input.costUsd === 'number' && Number.isFinite(input.costUsd)
    ? input.costUsd
    : null;
  const [result] = await pool.execute(
    `INSERT INTO claude_consultations (
      project_id, session_id, question, context, response, reason, duration_ms,
      subscription_authenticated, auth_method, subscription_type, tool_access,
      usage_json, estimated_cost_usd, status, consulted_at, created_at, updated_at
    ) VALUES (
      (SELECT id FROM projects WHERE project_code = ? OR id = 1 ORDER BY project_code = ? DESC LIMIT 1),
      ?, ?, ?, ?, ?, ?, 1, ?, ?, 'disabled', ?, ?, 'completed', NOW(), NOW(), NOW()
    )`,
    [
      'ai-infinity',
      'ai-infinity',
      input.sessionId,
      input.question,
      input.context || null,
      responseText,
      input.reason,
      input.durationMs,
      input.authMethod,
      input.subscriptionType,
      input.usage == null ? null : JSON.stringify(input.usage),
      numericCost,
    ],
  );
  return (result as ResultSetHeader).insertId;
}


const COUNCIL_GEMINI_WEBHOOK_PATH = 'ai-council-gemini-v4-8f3c21d7';
const COUNCIL_TIMEOUT_MS = 180_000;
const MAX_COUNCIL_RESPONSE_CHARS = 32_000;

function asNonEmptyText(value: unknown, label: string) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new Error(label + 'が空です');
  if (text.length > MAX_COUNCIL_RESPONSE_CHARS) throw new Error(label + 'が応答上限を超えました');
  return text;
}

async function callCouncilGemini(input: {
  topic: string;
  chairMessage: string;
  transcript: string;
  claudeResponse: string;
}) {
  const baseUrl = String(process.env.N8N_BASE_URL ?? '').replace(/\/+$/, '');
  if (!baseUrl) throw new Error('N8N_BASE_URLが未設定です');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), COUNCIL_TIMEOUT_MS);
  try {
    const response = await fetch(baseUrl + '/webhook/' + COUNCIL_GEMINI_WEBHOOK_PATH, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        topic: input.topic,
        chair_message: input.chairMessage,
        transcript: input.transcript,
        claude_response: input.claudeResponse,
        max_output_tokens: 1400,
      }),
      signal: controller.signal,
    });
    const body = await response.text();
    if (body.length > MAX_COUNCIL_RESPONSE_CHARS * 2) throw new Error('Gemini応答が上限を超えました');
    if (!response.ok) throw new Error('Gemini n8n Webhook error: HTTP ' + response.status);
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(body) as Record<string, unknown>;
    } catch {
      throw new Error('Gemini n8n Webhookが不正なJSONを返しました');
    }
    return {
      provider: 'gemini_api_via_n8n',
      mode: 'api',
      model: typeof payload.model === 'string' ? payload.model : 'gemini',
      content: asNonEmptyText(payload.content, 'Gemini回答'),
      usage: payload.usage ?? null,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function registerClaudeConsultTools(server: Server) {
  server.registerTool('claude_consult', {
    title: 'Claude Code即時相談',
    description: 'サブMac上のClaude Codeへ相談専用の質問を1回送り、回答を取得し、質問と回答の履歴をAI Infinity DBへ保存します。ファイル編集・コマンド・MCP等のツール利用は禁止し、Claude Pro/Maxのサブスク認証を確認できる場合だけ実行します。statusで事前確認できます。',
    inputSchema: z.object({
      action: z.enum(['status', 'ask']),
      question: z.string().min(1).max(10_000).optional(),
      context: z.string().max(20_000).optional().default(''),
      reason: z.string().min(5).max(500),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  }, async ({ action, question, context, reason }) => {
    try {
      await mkdir(CONSULT_ROOT, { recursive: true });
      const claudeBin = await resolveClaudeBin();
      const version = await execFileAsync(claudeBin, ['--version'], {
        cwd: CONSULT_ROOT,
        env: childEnv(),
        timeout: 15_000,
        maxBuffer: 128 * 1024,
      });
      const paidEnvironment = hasPaidProviderEnvironment();
      const auth = await authStatus(claudeBin);

      if (action === 'status') {
        await audit('status', 'success', {
          reason,
          claudeBin,
          version: version.stdout.trim(),
          paidProviderEnvironmentPresent: paidEnvironment,
          subscriptionAuthenticated: auth.subscriptionAuthenticated,
        });
        return textResult({
          success: true,
          action,
          claudeBin,
          version: version.stdout.trim(),
          paidProviderEnvironmentPresent: paidEnvironment,
          subscriptionAuthenticated: auth.subscriptionAuthenticated,
          authStatus: auth.safeStatus,
          ready: paidEnvironment.length === 0 && auth.subscriptionAuthenticated,
          conversationHistoryStorage: 'ai_infinity.claude_consultations',
        });
      }

      if (!question) throw new Error('action=askではquestionが必要です');
      rejectSecrets(question, context);
      if (paidEnvironment.length > 0) {
        await audit('ask', 'rejected', { reason, paidProviderEnvironmentPresent: paidEnvironment });
        throw new Error('APIキー等の従量課金経路がMCP環境に存在するため、安全のため実行を拒否しました');
      }
      if (!auth.subscriptionAuthenticated) {
        await audit('ask', 'rejected', { reason, authStatus: auth.safeStatus });
        throw new Error('Claude Pro/Maxのサブスク認証を確認できないため実行を拒否しました。先にstatusを確認してください');
      }

      const prompt = [
        'あなたは久原央士（くはっち）の開発チームに所属する主任開発者・技術相談役です。',
        'チャッピー（ChatGPT/Codex）がPM/SEとして相談します。',
        '今回は相談専用です。ファイル変更、コマンド実行、外部通信、MCP操作は行わず、与えられた情報だけで意見を返してください。',
        '結論、理由、懸念点、推奨案、チャッピーまたはくはっちへ確認すべき点を日本語で簡潔に回答してください。',
        '',
        '【相談】',
        question,
        context ? '\n【参考情報】\n' + context : '',
      ].join('\n');

      const hash = crypto.createHash('sha256').update(prompt).digest('hex');
      const startedAt = Date.now();
      const { stdout, stderr } = await execFileAsync(claudeBin, [
        '-p',
        prompt,
        '--output-format', 'json',
        '--permission-mode', 'dontAsk',
        '--tools', '',
        '--max-turns', '1',
        '--no-session-persistence',
      ], {
        cwd: CONSULT_ROOT,
        env: childEnv(),
        timeout: TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
      });
      const result = extractClaudeResult(stdout);
      const durationMs = Date.now() - startedAt;
      const authMeta = authMetadata(auth.rawNormalized);
      const consultationId = await saveConsultation(consultationPool, {
        question,
        context,
        response: result.response,
        reason,
        durationMs,
        sessionId: result.session_id,
        usage: result.usage,
        costUsd: result.cost_usd,
        authMethod: authMeta.authMethod,
        subscriptionType: authMeta.subscriptionType,
      });

      await audit('ask', 'success', {
        reason,
        promptHash: hash,
        questionLength: question.length,
        contextLength: context.length,
        durationMs,
        consultationId,
        stderr: redact(stderr),
      });

      return textResult({
        success: true,
        action,
        subscriptionAuthenticated: true,
        toolAccess: 'disabled',
        durationMs,
        historySaved: true,
        consultationId,
        ...result,
      });
    } catch (error) {
      try { await audit(action, 'failed', { reason, error: redact(String(error)) }); } catch {}
      return errorResult(error);
    }

  });

  server.registerTool('ai_council', {
    title: '3AI会議ターン',
    description: 'チャッピーを議長とし、クロちゃんはClaude Code CLI、Geminiはn8n Credential経由APIで1ラウンドの意見を取得します。APIキーや任意URL・任意コマンドは受け付けません。',
    inputSchema: z.object({
      action: z.enum(['status', 'round']),
      topic: z.string().min(1).max(6_000).optional(),
      chairMessage: z.string().min(1).max(6_000).optional(),
      transcript: z.string().max(20_000).optional().default(''),
      reason: z.string().min(5).max(500),
    }).strict(),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  }, async ({ action, topic, chairMessage, transcript, reason }) => {
    try {
      await mkdir(CONSULT_ROOT, { recursive: true });
      const claudeBin = await resolveClaudeBin();
      const version = await execFileAsync(claudeBin, ['--version'], {
        cwd: CONSULT_ROOT,
        env: childEnv(),
        timeout: 15_000,
        maxBuffer: 128 * 1024,
      });
      const paidEnvironment = hasPaidProviderEnvironment();
      const auth = await authStatus(claudeBin);
      const n8nConfigured = Boolean(String(process.env.N8N_BASE_URL ?? '').trim());

      if (action === 'status') {
        return textResult({
          success: true,
          action,
          ready: paidEnvironment.length === 0 && auth.subscriptionAuthenticated && n8nConfigured,
          claude: {
            provider: 'claude_code',
            mode: 'cli_subscription',
            version: version.stdout.trim(),
            subscriptionAuthenticated: auth.subscriptionAuthenticated,
            paidProviderEnvironmentPresent: paidEnvironment,
            toolAccess: 'disabled',
          },
          gemini: {
            provider: 'gemini',
            mode: 'api_via_n8n_credential',
            n8nConfigured,
            webhookPath: COUNCIL_GEMINI_WEBHOOK_PATH,
          },
        });
      }

      if (!topic || !chairMessage) throw new Error('action=roundではtopicとchairMessageが必要です');
      rejectSecrets(topic + '\n' + chairMessage, transcript);
      if (paidEnvironment.length > 0) throw new Error('Claude API従量課金経路が存在するため実行を拒否しました');
      if (!auth.subscriptionAuthenticated) throw new Error('Claude Pro/Maxサブスク認証を確認できません');
      if (!n8nConfigured) throw new Error('N8N_BASE_URLが未設定です');

      const claudePrompt = [
        'あなたは3AI会議の技術・リスク担当「クロちゃん」です。',
        '相談専用です。ツール、ファイル、コマンド、外部通信は一切使わず、提示された情報だけで回答してください。',
        '議長チャッピーの案を鵜呑みにせず、反対意見、見落とし、改善案、実行条件を日本語で明確に述べてください。',
        '',
        '【議題】',
        topic,
        '',
        '【議長チャッピーの発言】',
        chairMessage,
        transcript ? '\n【これまでの会議】\n' + transcript : '',
      ].join('\n');

      const startedAt = Date.now();
      const { stdout, stderr } = await execFileAsync(claudeBin, [
        '-p', claudePrompt,
        '--output-format', 'json',
        '--permission-mode', 'dontAsk',
        '--tools', '',
        '--max-turns', '1',
        '--no-session-persistence',
      ], {
        cwd: CONSULT_ROOT,
        env: childEnv(),
        timeout: TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
      });
      const claudeRaw = extractClaudeResult(stdout);
      const claudeContent = asNonEmptyText(
        typeof claudeRaw.response === 'string' ? claudeRaw.response : JSON.stringify(claudeRaw.response),
        'Claude回答',
      );
      const gemini = await callCouncilGemini({
        topic,
        chairMessage,
        transcript,
        claudeResponse: claudeContent,
      });
      const durationMs = Date.now() - startedAt;
      await audit('ai_council_round', 'success', {
        reason,
        topicHash: crypto.createHash('sha256').update(topic).digest('hex'),
        durationMs,
        claudeStderr: redact(stderr),
      });
      return textResult({
        success: true,
        action,
        chair: { provider: 'chatgpt', mode: 'current_session', content: chairMessage },
        claude: {
          provider: 'claude_code',
          mode: 'cli_subscription',
          model: 'Claude Code',
          content: claudeContent,
          usage: claudeRaw.usage,
          costUsd: claudeRaw.cost_usd,
          toolAccess: 'disabled',
        },
        gemini,
        durationMs,
      });
    } catch (error) {
      try { await audit('ai_council_' + action, 'failed', { reason, error: redact(String(error)) }); } catch {}
      return errorResult(new Error(redact(String(error))));
    }
  });
}
