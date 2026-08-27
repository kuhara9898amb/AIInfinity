import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import * as z from 'zod/v4';

const execFileAsync = promisify(execFile);
const CONTENT_ROOT = '/Users/erka/AIInfinity/claude-content';
const AUDIT_PATH = '/Users/erka/AIInfinity/logs/claude-content.jsonl';
const CLAUDE_CANDIDATES = [
  '/Users/erka/.local/bin/claude',
  '/opt/homebrew/bin/claude',
  '/usr/local/bin/claude',
];
const BLOCKED_ENV = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
];

type Server = {
  registerTool: (name: string, config: any, handler: (input: any) => Promise<any>) => void;
};

type FreeNoteArticle = {
  title: string;
  body: string;
  summary: string;
  thumbnail_copy: string;
  thumbnail_subcopy: string;
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

async function audit(action: string, status: 'success' | 'rejected' | 'failed', details: Record<string, unknown>) {
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
  for (const key of BLOCKED_ENV) delete env[key];
  env.PATH = '/Users/erka/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';
  return env;
}

function paidProviderEnvironment() {
  return BLOCKED_ENV.filter(key => Boolean(process.env[key]));
}

async function authStatus(claudeBin: string) {
  const { stdout } = await execFileAsync(claudeBin, ['auth', 'status', '--json'], {
    cwd: CONTENT_ROOT,
    env: childEnv(),
    timeout: 15000,
    maxBuffer: 256 * 1024,
  });
  const raw = stdout.trim();
  const subscriptionSignal = /(claude\.ai|subscription|oauth|\bpro\b|\bmax\b)/i.test(raw);
  const paidProviderSignal = /(api[_ -]?key|console|bedrock|vertex|foundry)/i.test(raw);
  return {
    subscriptionAuthenticated: subscriptionSignal && !paidProviderSignal,
    safeStatus: redact(raw),
  };
}

function rejectSecrets(value: string) {
  const patterns = [
    /(?:sk-ant-|sk-)[A-Za-z0-9_\-.]{12,}/i,
    /Bearer\s+[A-Za-z0-9_\-.]{12,}/i,
    /(?:API_KEY|PASSWORD|SECRET|TOKEN)\s*[=:]\s*\S+/i,
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  ];
  if (patterns.some(pattern => pattern.test(value))) {
    throw new Error('入力に機密情報らしき文字列が含まれるため拒否しました');
  }
}

function extractResult(stdout: string) {
  const parsed = JSON.parse(stdout.trim()) as Record<string, unknown>;
  if (typeof parsed.result !== 'string' || !parsed.result.trim()) {
    throw new Error('Claude Codeの結果本文が空です');
  }
  return {
    response: parsed.result,
    sessionId: typeof parsed.session_id === 'string' ? parsed.session_id : null,
    usage: parsed.usage ?? null,
    costUsdReference: parsed.total_cost_usd ?? null,
  };
}

function parseArticle(raw: string): FreeNoteArticle {
  const normalized = raw.trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '');
  const parsed = JSON.parse(normalized) as Partial<FreeNoteArticle>;
  for (const key of ['title', 'body', 'summary', 'thumbnail_copy', 'thumbnail_subcopy'] as const) {
    if (typeof parsed[key] !== 'string' || !parsed[key]?.trim()) {
      throw new Error('生成JSONに必須項目がありません: ' + key);
    }
  }
  const article = parsed as FreeNoteArticle;
  const bodyChars = Array.from(article.body.replace(/\s/g, '')).length;
  if (bodyChars < 1200 || bodyChars > 3200) throw new Error('本文文字数が許容範囲外です: ' + bodyChars + '字');
  if (Array.from(article.summary).length > 120) throw new Error('summaryが120文字を超えています');
  if (Array.from(article.thumbnail_copy).length > 18) throw new Error('thumbnail_copyが18文字を超えています');
  if (Array.from(article.thumbnail_subcopy).length > 25) throw new Error('thumbnail_subcopyが25文字を超えています');
  return article;
}

function buildPrompt(input: {
  theme: string;
  candidateTitle: string;
  summary: string;
  targetReader: string;
  facts: string;
}) {
  return [
    'あなたは日本語の無料note記事を制作するプロ編集者です。',
    '入力だけを根拠に、自然な会話調の完成原稿を作ってください。',
    '確認できない体験談、実績、効果数値、人物談、統計は捏造しません。',
    'JSON以外は出力しないでください。',
    '',
    '【テーマ】', input.theme,
    '【候補タイトル】', input.candidateTitle,
    '【概要】', input.summary,
    '【想定読者】', input.targetReader,
    '【使用してよい事実】', input.facts,
    '',
    '【必須条件】',
    '- 本文は日本語2,000〜2,800文字を目標、絶対上限3,200文字',
    '- 冒頭で読者の悩みと読むメリットを示す',
    '- 大見出しは「## 」、小見出しは「### 」',
    '- 具体例、箇条書き、実践手順を含める',
    '- 最後に自然なまとめを置く',
    '- 有料記事への誘導、架空特典、保証、次回予告を書かない',
    '- タイトルを本文先頭に重複表示しない',
    '',
    '次のJSONのみ返してください:',
    '{"title":"独自タイトル","body":"Markdown本文","summary":"120文字以内の要約","thumbnail_copy":"18文字以内","thumbnail_subcopy":"25文字以内"}',
  ].join('\n');
}

export function registerClaudeContentTools(server: Server) {
  server.registerTool('claude_content_generate', {
    title: 'Claude Code成果物生成',
    description: 'Claude Pro/Max認証だけで無料note記事を固定JSON形式で生成・検査します。外部ツール、ファイル編集、公開、DB更新は行いません。',
    inputSchema: z.object({
      action: z.enum(['status', 'generate_free_note']),
      theme: z.string().min(1).max(500).optional(),
      candidateTitle: z.string().min(1).max(500).optional(),
      summary: z.string().max(3000).optional().default(''),
      targetReader: z.string().min(1).max(1000).optional(),
      facts: z.string().min(1).max(20000).optional(),
      reason: z.string().min(5).max(500),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  }, async ({ action, theme, candidateTitle, summary, targetReader, facts, reason }) => {
    try {
      await mkdir(CONTENT_ROOT, { recursive: true });
      const claudeBin = await resolveClaudeBin();
      const version = await execFileAsync(claudeBin, ['--version'], {
        cwd: CONTENT_ROOT,
        env: childEnv(),
        timeout: 15000,
        maxBuffer: 128 * 1024,
      });
      const paidEnvironment = paidProviderEnvironment();
      const auth = await authStatus(claudeBin);
      const ready = paidEnvironment.length === 0 && auth.subscriptionAuthenticated;

      if (action === 'status') {
        await audit('status', 'success', { reason, ready, version: version.stdout.trim() });
        return textResult({
          success: true,
          action,
          version: version.stdout.trim(),
          paidProviderEnvironmentPresent: paidEnvironment,
          subscriptionAuthenticated: auth.subscriptionAuthenticated,
          authStatus: auth.safeStatus,
          ready,
          supportedContentTypes: ['free_note'],
        });
      }

      if (!theme || !candidateTitle || !targetReader || !facts) {
        throw new Error('generate_free_noteではtheme、candidateTitle、targetReader、factsが必要です');
      }
      rejectSecrets([theme, candidateTitle, summary, targetReader, facts].join('\n'));
      if (!ready) {
        await audit(action, 'rejected', { reason, paidProviderEnvironment: paidEnvironment, auth: auth.safeStatus });
        throw new Error('Claude Pro/Max認証のみの安全な実行経路を確認できません');
      }

      const prompt = buildPrompt({ theme, candidateTitle, summary, targetReader, facts });
      const promptHash = crypto.createHash('sha256').update(prompt).digest('hex');
      const startedAt = Date.now();
      const { stdout, stderr } = await execFileAsync(claudeBin, [
        '-p', prompt,
        '--output-format', 'json',
        '--permission-mode', 'dontAsk',
        '--tools', '',
        '--max-turns', '1',
        '--no-session-persistence',
      ], {
        cwd: CONTENT_ROOT,
        env: childEnv(),
        timeout: 240000,
        maxBuffer: 4 * 1024 * 1024,
      });
      const result = extractResult(stdout);
      const article = parseArticle(result.response);
      const durationMs = Date.now() - startedAt;
      const bodyCharCount = Array.from(article.body.replace(/\s/g, '')).length;
      await audit(action, 'success', {
        reason, promptHash, durationMs, bodyCharCount, sessionId: result.sessionId, stderr: redact(stderr),
      });
      return textResult({
        success: true,
        action,
        provider: 'claude_code_subscription',
        subscriptionAuthenticated: true,
        paidProviderEnvironmentPresent: [],
        toolAccess: 'disabled',
        durationMs,
        validation: {
          jsonValid: true,
          bodyCharCount,
          bodyMin: 1200,
          bodyTargetMin: 2000,
          bodyTargetMax: 2800,
          bodyHardMax: 3200,
        },
        article,
        sessionId: result.sessionId,
        usage: result.usage,
        costUsdReference: result.costUsdReference,
        note: 'costUsdReferenceは参考換算値で、APIキー等の従量課金経路は使用していません。',
      });
    } catch (error) {
      try { await audit(action, 'failed', { reason, error: redact(String(error)) }); } catch {}
      return errorResult(error);
    }
  });
}
