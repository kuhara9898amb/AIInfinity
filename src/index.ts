import dotenv from 'dotenv';
dotenv.config({ override: true, quiet: true });
import mysql from 'mysql2/promise';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';
import { registerExternalMemoryTools } from './external-memory-tools.js';
import { registerProjectTools } from './project-tools.js';
import { registerVpsOperatorTools } from './vps-operator-tools.js';
import { registerMonkeyAiOperatorTools } from './monkeyai-operator-tools.js';
import { registerTunnelOperatorTools } from './tunnel-operator-tools.js';
import { registerSoreAiOperatorTools } from './soreai-operator-tools.js';
import { registerSugoiAiSiteShindanOperatorTools } from './sugoi-ai-site-shindan-operator-tools.js';
import { registerAiLeadCreatorOperatorTools } from './ai-lead-creator-operator-tools.js';
import { registerClaudeConsultTools } from './claude-consult-tools.js';
import { registerClaudeContentTools } from './claude-content-tools.js';
import { registerClaudeDevelopTools } from './claude-develop-tools.js';
import { registerProjectDatabaseProvisionTools } from './project-database-provision-tools.js';
import { access, appendFile, copyFile, mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

type JsonObject = Record<string, unknown>;

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT ?? 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 5,
  queueLimit: 0,
  multipleStatements: false,
});

const server = new McpServer({ name: 'ai-infinity-mcp-v4', version: '1.0.0' });
const N8N_BASE_URL = process.env.N8N_BASE_URL?.replace(/\/+$/, '');
const N8N_API_KEY = process.env.N8N_API_KEY;
const LARAVEL_ROOT = process.env.LARAVEL_ROOT;
const AUDIT_LOG = process.env.MCP_AUDIT_LOG ?? '/Users/erka/AIInfinity/logs/mcp-v4-audit.jsonl';
const MAX_FILE_SIZE = 1024 * 1024;

function textResult(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

function errorResult(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true };
}

async function audit(action: string, target: string, status: 'success' | 'rejected' | 'failed', details: JsonObject = {}) {
  await mkdir(path.dirname(AUDIT_LOG), { recursive: true });
  const safeDetails = JSON.parse(JSON.stringify(details, (key, value) =>
    /password|secret|token|api.?key|credential/i.test(key) ? '[REDACTED]' : value
  ));
  await appendFile(AUDIT_LOG, `${JSON.stringify({ timestamp: new Date().toISOString(), action, target, status, details: safeDetails })}\n`, { encoding: 'utf8', mode: 0o600 });
}

function identifier(value: string, label: string) {
  if (!/^[A-Za-z0-9_]+$/.test(value)) throw new Error(`${label}が不正です`);
  return `\`${value}\``;
}

const writeColumns: Record<string, Set<string>> = {
  projects: new Set(['project_code','name','objective','description','status','priority','current_agent_id','current_phase','workflow_version','started_at','completed_at']),
  agents: new Set(['agent_code','name_ja','name_en','role_code','role_name','description','sort_order','is_active']),
  prompts: new Set(['agent_id','prompt_type','name','version','content','change_summary']),
  tasks: new Set(['task_code','project_id','workflow_run_id','parent_task_id','assigned_agent_id','next_agent_id','task_type','title','goal','instructions','constraints_json','required_outputs_json','status','quality_threshold','revision_count','max_revisions','due_at','started_at','completed_at']),
  artifacts: new Set(['artifact_code','project_id','task_id','agent_run_id','created_by_agent_id','artifact_type','title','summary','content','content_json','version','status','quality_score','file_path','external_url']),
  reviews: new Set(['project_id','task_id','artifact_id','reviewer_agent_id','review_status','logic_score','business_value_score','reproducibility_score','completeness_score','handoff_score','total_score','strengths','issues','revision_instructions','review_json']),
  sns_posts: new Set(['platform','account_name','post_type','purpose','theme','target_audience','post_text','content_hash','selected_pattern','media_url','thumbnail_url','link_url','research_json','generation_json','quality_check_json','status','duplicate_check_status','duplicate_post_id','similarity_score','review_comment','scheduled_at']),
  sns_reply_candidates: new Set(['platform','account_name','agent_id','search_keyword','target_post_id','target_username','target_user_id','profile_text','target_post_text','target_post_url','target_post_published_at','follower_count','like_count','reply_count','matched_source','tone','decision','selection_reason','relevance_score','conversation_potential_score','relationship_potential_score','reply_value_score','risk_score','risk_reasons_json','rule_check_json','ai_reply_candidates_json','recommended_reply_index','selected_reply_type','selected_reply_text','status','review_comment','scheduled_at']),
};

const forbiddenStatus = new Set(['published','publishing','active']);

function validateWrite(table: string, values: JsonObject) {
  const allowed = writeColumns[table];
  if (!allowed) throw new Error(`書き込みが許可されていないテーブルです: ${table}`);
  const entries = Object.entries(values);
  if (!entries.length) throw new Error('valuesが空です');
  if (entries.length > 30) throw new Error('一度に更新できるカラムは30個までです');
  for (const [column, value] of entries) {
    if (!allowed.has(column)) throw new Error(`${table}.${column}への書き込みは禁止されています`);
    if (column === 'status' && forbiddenStatus.has(String(value))) throw new Error(`status=${value}への変更は専用承認フローが必要です`);
    if (typeof value === 'string' && value.length > 1_000_000) throw new Error(`${column}が1MBを超えています`);
  }
}

function sqlValue(value: unknown): any {
  if (value !== null && typeof value === 'object') return JSON.stringify(value);
  return value;
}

server.registerTool('mysql_list_tables', {
  title: 'MySQLテーブル一覧', description: 'AI InfinityのMySQLテーブル一覧を取得します。', inputSchema: z.object({}), annotations: { readOnlyHint: true }
}, async () => { const [rows] = await pool.query('SHOW TABLES'); return textResult(rows); });

server.registerTool('mysql_describe_table', {
  title: 'MySQLテーブル構造取得', description: '指定テーブルのカラム構造を取得します。', inputSchema: z.object({ tableName: z.string().regex(/^[A-Za-z0-9_]+$/) }), annotations: { readOnlyHint: true }
}, async ({ tableName }) => { const [rows] = await pool.query(`DESCRIBE ${identifier(tableName, 'tableName')}`); return textResult(rows); });

server.registerTool('mysql_query', {
  title: 'MySQL読取SQL', description: 'SELECT、SHOW、DESCRIBE、EXPLAINのみ実行できます。', inputSchema: z.object({ sql: z.string().min(1) }), annotations: { readOnlyHint: true }
}, async ({ sql }) => {
  const cleaned = sql.trim();
  const command = cleaned.replace(/^\/\*[\s\S]*?\*\//, '').replace(/^--.*$/gm, '').trim().split(/\s+/)[0]?.toUpperCase();
  if (!command || !['SELECT','SHOW','DESCRIBE','DESC','EXPLAIN'].includes(command)) throw new Error('読み取り専用SQLのみ許可されています');
  if (cleaned.replace(/;\s*$/, '').includes(';')) throw new Error('複数SQLは禁止されています');
  const [rows] = await pool.query(cleaned);
  return textResult(Array.isArray(rows) && rows.length > 200 ? rows.slice(0, 200) : rows);
});

const valuesSchema = z.record(z.string().regex(/^[A-Za-z0-9_]+$/), z.unknown());

server.registerTool('mysql_insert_record', {
  title: 'MySQL安全INSERT', description: '許可テーブル・許可カラムに1レコードだけ追加します。公開・有効化操作はできません。',
  inputSchema: z.object({ tableName: z.string(), values: valuesSchema, reason: z.string().min(5).max(500) }),
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
}, async ({ tableName, values, reason }) => {
  try {
    validateWrite(tableName, values);
    const columns = Object.keys(values);
    const sql = `INSERT INTO ${identifier(tableName, 'tableName')} (${columns.map(c => identifier(c, 'column')).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`;
    const [result] = await pool.execute(sql, columns.map(c => sqlValue(values[c])));
    const meta = result as mysql.ResultSetHeader;
    await audit('mysql_insert_record', tableName, 'success', { reason, columns, insertId: meta.insertId, affectedRows: meta.affectedRows });
    return textResult({ success: true, tableName, insertId: meta.insertId, affectedRows: meta.affectedRows });
  } catch (error) { await audit('mysql_insert_record', tableName, 'failed', { reason, error: String(error) }); return errorResult(error); }
});

server.registerTool('mysql_update_record', {
  title: 'MySQL安全UPDATE', description: '主キーidを指定し、許可カラムだけを1レコード更新します。公開・有効化操作はできません。', inputSchema: z.object({ tableName: z.string(), id: z.number().int().positive(), values: valuesSchema, reason: z.string().min(5).max(500) }), annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
}, async ({ tableName, id, values, reason }) => {
  const connection = await pool.getConnection();
  try {
    validateWrite(tableName, values);
    await connection.beginTransaction();
    const [beforeRows] = await connection.execute(`SELECT * FROM ${identifier(tableName, 'tableName')} WHERE id = ? FOR UPDATE`, [id]);
    const before = Array.isArray(beforeRows) ? beforeRows[0] : null;
    if (!before) throw new Error(`id=${id}のレコードが存在しません`);
    const columns = Object.keys(values);
    const sql = `UPDATE ${identifier(tableName, 'tableName')} SET ${columns.map(c => `${identifier(c, 'column')} = ?`).join(', ')} WHERE id = ? LIMIT 1`;
    const [result] = await connection.execute(sql, [...columns.map(c => sqlValue(values[c])), id]);
    const meta = result as mysql.ResultSetHeader;
    if (meta.affectedRows > 1) throw new Error('複数行更新を検出したため中止しました');
    const [afterRows] = await connection.execute(`SELECT * FROM ${identifier(tableName, 'tableName')} WHERE id = ?`, [id]);
    await connection.commit();
    await audit('mysql_update_record', `${tableName}:${id}`, 'success', { reason, columns, before, after: Array.isArray(afterRows) ? afterRows[0] : null });
    return textResult({ success: true, tableName, id, affectedRows: meta.affectedRows, changedRows: meta.changedRows });
  } catch (error) { await connection.rollback(); await audit('mysql_update_record', `${tableName}:${id}`, 'failed', { reason, error: String(error) }); return errorResult(error); }
  finally { connection.release(); }
});

async function n8nRequest(method: 'GET'|'POST'|'PUT', apiPath: string, body?: unknown) {
  if (!N8N_BASE_URL || !N8N_API_KEY) throw new Error('N8N_BASE_URLまたはN8N_API_KEYが未設定です');
  const response = await fetch(`${N8N_BASE_URL}/api/v1${apiPath}`, {
    method, headers: { 'X-N8N-API-KEY': N8N_API_KEY, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const responseText = await response.text();
  if (!response.ok) throw new Error(`n8n API error ${response.status}: ${responseText.slice(0, 2000)}`);
  if (!responseText) return null;
  try { return JSON.parse(responseText); } catch { return responseText; }
}

async function n8nSetWorkflowActive(workflowId: string, active: boolean) {
  try {
    return await n8nRequest('POST', `/workflows/${encodeURIComponent(workflowId)}/${active ? 'activate' : 'deactivate'}`, {});
  } catch (error) {
    if (!String(error).includes('n8n API error 403')) throw error;
  }

  const dockerCandidates = ['/usr/local/bin/docker', '/opt/homebrew/bin/docker'];
  let dockerBin = '';
  for (const candidate of dockerCandidates) {
    try { await access(candidate); dockerBin = candidate; break; } catch {}
  }
  if (!dockerBin) throw new Error('n8n APIが403を返し、Docker CLIも見つかりません');

  const { stdout } = await execFileAsync(dockerBin, ['ps', '--format', '{{.Names}}'], {
    timeout: 15000, maxBuffer: 256 * 1024,
  });
  const containers = stdout.split(/\r?\n/).map(v => v.trim()).filter(v => /n8n/i.test(v));
  if (containers.length !== 1) {
    throw new Error(`安全停止: n8nコンテナを一意に特定できません (${containers.join(', ') || 'none'})`);
  }
  const container = containers[0];
  await execFileAsync(dockerBin, ['exec', container, 'n8n', 'update:workflow', `--id=${workflowId}`, `--active=${active ? 'true' : 'false'}`], {
    timeout: 120000, maxBuffer: 2 * 1024 * 1024,
  });
  await execFileAsync(dockerBin, ['restart', container], {
    timeout: 120000, maxBuffer: 512 * 1024,
  });

  if (!N8N_BASE_URL) throw new Error('N8N_BASE_URLが未設定です');
  let lastError = '';
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 2000));
    try {
      const workflow = await n8nRequest('GET', `/workflows/${encodeURIComponent(workflowId)}`) as JsonObject;
      if (Boolean(workflow.active) === active) return workflow;
      lastError = `active=${String(workflow.active)}`;
    } catch (error) {
      lastError = String(error);
    }
  }
  throw new Error(`n8n CLI変更後の状態確認に失敗しました: ${lastError}`);
}

server.registerTool('n8n_list_workflows', {
  title: 'n8n Workflow一覧', description: 'n8nのWorkflow一覧を取得します。', inputSchema: z.object({}), annotations: { readOnlyHint: true }
}, async () => { try { return textResult(await n8nRequest('GET', '/workflows')); } catch (e) { return errorResult(e); } });

server.registerTool('n8n_get_workflow', {
  title: 'n8n Workflow詳細', description: '指定したWorkflowを取得します。', inputSchema: z.object({ workflowId: z.string().min(1) }), annotations: { readOnlyHint: true }
}, async ({ workflowId }) => { try { return textResult(await n8nRequest('GET', `/workflows/${encodeURIComponent(workflowId)}`)); } catch (e) { return errorResult(e); } });

server.registerTool('n8n_list_executions', {
  title: 'n8n Execution一覧', description: 'n8nの実行履歴を取得します。', inputSchema: z.object({ workflowId: z.string().optional(), status: z.string().optional(), limit: z.number().int().min(1).max(100).default(20) }), annotations: { readOnlyHint: true }
}, async ({ workflowId, status, limit }) => { try { const p = new URLSearchParams({ limit: String(limit) }); if (workflowId) p.set('workflowId', workflowId); if (status) p.set('status', status); return textResult(await n8nRequest('GET', `/executions?${p}`)); } catch (e) { return errorResult(e); } });

server.registerTool('n8n_get_execution', {
  title: 'n8n Execution詳細', description: '指定Executionの詳細を取得します。', inputSchema: z.object({ executionId: z.string().min(1) }), annotations: { readOnlyHint: true }
}, async ({ executionId }) => { try { return textResult(await n8nRequest('GET', `/executions/${encodeURIComponent(executionId)}?includeData=true`)); } catch (e) { return errorResult(e); } });

const prohibitedNodeTypes = new Set([
  'n8n-nodes-base.executeCommand', 'n8n-nodes-base.ssh', 'n8n-nodes-base.ftp',
  'n8n-nodes-base.readWriteFile', 'n8n-nodes-base.localFileTrigger',
]);

const workflowSchema = z.object({
  name: z.string().min(1).max(200),
  nodes: z.array(z.record(z.string(), z.unknown())).max(100),
  connections: z.record(z.string(), z.unknown()),
  settings: z.record(z.string(), z.unknown()).optional(),
  staticData: z.unknown().optional(),
});

function safeWorkflow(input: z.infer<typeof workflowSchema>) {
  const workflow = workflowSchema.parse(input);
  for (const node of workflow.nodes) {
    const type = String(node.type ?? '');
    if (prohibitedNodeTypes.has(type)) throw new Error(`危険なn8nノードは禁止されています: ${type}`);
    if ('credentials' in node) {
      const credentials = node.credentials;
      if (!credentials || typeof credentials !== 'object') throw new Error('credentials指定が不正です');
      const serialized = JSON.stringify(credentials);
      if (/password|secret|token|api.?key/i.test(serialized)) throw new Error('Credentialの秘密値をWorkflowへ直接埋め込むことは禁止されています');
    }
  }
  return { name: workflow.name, nodes: workflow.nodes, connections: workflow.connections, settings: workflow.settings ?? {}, staticData: workflow.staticData ?? null };
}

server.registerTool('n8n_create_workflow', {
  title: 'n8n安全Workflow作成', description: '危険ノードを除外して、無効状態のWorkflowを新規作成します。Credential自体は作成・変更しません。', inputSchema: z.object({ workflow: workflowSchema, reason: z.string().min(5).max(500) }), annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
}, async ({ workflow, reason }) => { try { const body = safeWorkflow(workflow); const result = await n8nRequest('POST', '/workflows', body); await audit('n8n_create_workflow', body.name, 'success', { reason, nodeCount: body.nodes.length, workflowId: (result as JsonObject)?.id }); return textResult(result); } catch (e) { await audit('n8n_create_workflow', String(workflow?.name ?? ''), 'failed', { reason, error: String(e) }); return errorResult(e); } });

server.registerTool('n8n_update_workflow', {
  title: 'n8n安全Workflow更新', description: '既存Workflowをバックアップ後に更新します。有効化・削除・Credential変更は行いません。', inputSchema: z.object({ workflowId: z.string().min(1), workflow: workflowSchema, reason: z.string().min(5).max(500) }), annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
}, async ({ workflowId, workflow, reason }) => {
  try {
    const before = await n8nRequest('GET', `/workflows/${encodeURIComponent(workflowId)}`);
    const backupDir = path.join(path.dirname(AUDIT_LOG), 'n8n-workflow-backups'); await mkdir(backupDir, { recursive: true });
    await writeFile(path.join(backupDir, `${workflowId}-${Date.now()}.json`), JSON.stringify(before, null, 2), { encoding: 'utf8', mode: 0o600 });
    const body = safeWorkflow(workflow);
    const result = await n8nRequest('PUT', `/workflows/${encodeURIComponent(workflowId)}`, body);
    await audit('n8n_update_workflow', workflowId, 'success', { reason, nodeCount: body.nodes.length, name: body.name });
    return textResult(result);
  } catch (e) { await audit('n8n_update_workflow', workflowId, 'failed', { reason, error: String(e) }); return errorResult(e); }
});


const SOREAI_ARTICLE_IDEA_WORKFLOW_ID = 'ao6K6LNnAZUlDxZf';
const SOREAI_ARTICLE_IDEA_WEBHOOK_PATH = 'soreai/article-ideas/run-7f4d3a91';

async function soreAiArticleIdeasWorkflow() {
  const workflow = await n8nRequest('GET', `/workflows/${SOREAI_ARTICLE_IDEA_WORKFLOW_ID}`) as JsonObject;
  if (String(workflow.id ?? '') !== SOREAI_ARTICLE_IDEA_WORKFLOW_ID) throw new Error('許可済みWorkflowを確認できません');
  if (String(workflow.name ?? '') !== 'WF_SOREAI_06_ARTICLE_IDEA_COLLECT') throw new Error('Workflow名が許可済み定義と一致しません');
  const safe = safeWorkflow({
    name: String(workflow.name),
    nodes: Array.isArray(workflow.nodes) ? workflow.nodes as JsonObject[] : [],
    connections: workflow.connections && typeof workflow.connections === 'object' ? workflow.connections as JsonObject : {},
    settings: workflow.settings && typeof workflow.settings === 'object' ? workflow.settings as JsonObject : {},
    staticData: workflow.staticData,
  });
  const webhook = safe.nodes.find(node => String(node.id ?? '') === 'ideas-webhook');
  if (!webhook || String((webhook.parameters as JsonObject | undefined)?.path ?? '') !== SOREAI_ARTICLE_IDEA_WEBHOOK_PATH) {
    throw new Error('許可済みWebhook入口が見つかりません');
  }
  return workflow;
}

server.registerTool('soreai_article_ideas_operator', {
  title: 'それAI記事候補Workflow操作',
  description: '固定済みの記事候補収集Workflowだけを状態確認・有効化・停止・手動実行します。任意のWorkflow IDやURLは指定できません。',
  inputSchema: z.object({
    action: z.enum(['status', 'activate', 'deactivate', 'run']),
    reason: z.string().min(5).max(500),
  }),
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
}, async ({ action, reason }) => {
  try {
    let workflow = await soreAiArticleIdeasWorkflow();
    if (action === 'status') {
      return textResult({
        workflowId: SOREAI_ARTICLE_IDEA_WORKFLOW_ID,
        name: workflow.name,
        active: Boolean(workflow.active),
        updatedAt: workflow.updatedAt,
      });
    }

    if (action === 'activate' || action === 'deactivate') {
      workflow = await n8nSetWorkflowActive(SOREAI_ARTICLE_IDEA_WORKFLOW_ID, action === 'activate') as JsonObject;
      await audit('soreai_article_ideas_operator', SOREAI_ARTICLE_IDEA_WORKFLOW_ID, 'success', {
        action, reason, active: Boolean(workflow.active),
      });
      return textResult({
        success: true,
        action,
        workflowId: SOREAI_ARTICLE_IDEA_WORKFLOW_ID,
        active: Boolean(workflow.active),
      });
    }

    if (!workflow.active) {
      workflow = await n8nSetWorkflowActive(SOREAI_ARTICLE_IDEA_WORKFLOW_ID, true) as JsonObject;
    }
    if (!N8N_BASE_URL) throw new Error('N8N_BASE_URLが未設定です');

    const requestedAt = new Date();
    const response = await fetch(`${N8N_BASE_URL}/webhook/${SOREAI_ARTICLE_IDEA_WEBHOOK_PATH}`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'ai-infinity-mcp-v4', requestedAt: requestedAt.toISOString() }),
    });
    const responseText = await response.text();
    if (!response.ok) throw new Error(`n8n webhook error ${response.status}: ${responseText.slice(0, 1000)}`);

    let observedExecution: JsonObject | null = null;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 2000));
      const list = await n8nRequest('GET', `/executions?workflowId=${SOREAI_ARTICLE_IDEA_WORKFLOW_ID}&limit=10`) as JsonObject;
      const executions = Array.isArray(list.data) ? list.data as JsonObject[] : [];
      observedExecution = executions.find(execution => {
        const startedAt = Date.parse(String(execution.startedAt ?? ''));
        return Number.isFinite(startedAt) && startedAt >= requestedAt.getTime() - 5000;
      }) ?? null;
      if (observedExecution && ['success', 'error', 'canceled', 'crashed'].includes(String(observedExecution.status ?? ''))) break;
    }

    await audit('soreai_article_ideas_operator', SOREAI_ARTICLE_IDEA_WORKFLOW_ID, 'success', {
      action, reason, executionId: observedExecution?.id ?? null, status: observedExecution?.status ?? 'accepted',
    });
    return textResult({
      success: true,
      action: 'run',
      workflowId: SOREAI_ARTICLE_IDEA_WORKFLOW_ID,
      active: Boolean(workflow.active),
      webhookAccepted: true,
      execution: observedExecution ? {
        id: observedExecution.id,
        status: observedExecution.status,
        startedAt: observedExecution.startedAt,
        stoppedAt: observedExecution.stoppedAt,
      } : null,
      note: observedExecution ? undefined : '実行要求は受理されました。完了状態はn8n_list_executionsで確認できます。',
    });
  } catch (error) {
    await audit('soreai_article_ideas_operator', SOREAI_ARTICLE_IDEA_WORKFLOW_ID, 'failed', { action, reason, error: String(error) });
    return errorResult(error);
  }
});

if (!LARAVEL_ROOT) throw new Error('LARAVEL_ROOTが設定されていません');
const laravelRootRealPath = await realpath(LARAVEL_ROOT);
const deniedNames = new Set(['.env','.env.backup','.env.production','.git','vendor','node_modules','storage']);
const allowedExtensions = new Set(['.php','.js','.ts','.css','.scss','.json','.md','.yml','.yaml','.xml','.txt']);
const writableRoots = ['app','resources','routes','config','database/migrations','tests','public'];

function hasAllowedExtension(filePath: string) { const lower = filePath.toLowerCase(); return lower.endsWith('.blade.php') || allowedExtensions.has(path.extname(lower)); }
function containsDeniedPath(relativePath: string) { return relativePath.split(/[\\/]+/).filter(Boolean).some(part => deniedNames.has(part) || part.startsWith('.env')); }
function normalizeRelativePath(requestedPath: string) {
  const normalized = requestedPath.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized || normalized === '.') return '.';
  if (normalized.includes('\0') || normalized.split('/').includes('..') || containsDeniedPath(normalized)) throw new Error('不正または禁止されたパスです');
  return normalized;
}
function isWritablePath(relativePath: string) { return writableRoots.some(root => relativePath === root || relativePath.startsWith(`${root}/`)); }
function ensureInsideRoot(candidate: string) { const relative = path.relative(laravelRootRealPath, candidate); if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Laravelプロジェクト外は操作できません'); return relative.replace(/\\/g, '/'); }

async function resolveExistingLaravelPath(requestedPath: string) {
  const normalized = normalizeRelativePath(requestedPath); const resolved = await realpath(path.resolve(laravelRootRealPath, normalized)); const relative = ensureInsideRoot(resolved);
  if (containsDeniedPath(relative)) throw new Error('禁止されたパスです'); return { resolved, relative: relative || '.' };
}

async function collectLaravelFiles(directory: string, depth: number, maximumDepth: number, files: string[]) {
  if (depth > maximumDepth || files.length >= 500) return;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (files.length >= 500 || deniedNames.has(entry.name) || entry.isSymbolicLink()) continue;
    const absolute = path.join(directory, entry.name); const relative = ensureInsideRoot(absolute);
    if (entry.isDirectory()) await collectLaravelFiles(absolute, depth + 1, maximumDepth, files);
    else if (entry.isFile() && hasAllowedExtension(relative)) files.push(relative);
  }
}

server.registerTool('laravel_list_files', {
  title: 'Laravelファイル一覧', description: '安全な範囲のファイル一覧を取得します。', inputSchema: z.object({ directory: z.string().default('.'), maxDepth: z.number().int().min(0).max(6).default(3) }), annotations: { readOnlyHint: true }
}, async ({ directory, maxDepth }) => { try { const target = await resolveExistingLaravelPath(directory); if (!(await stat(target.resolved)).isDirectory()) throw new Error('ディレクトリではありません'); const files:string[]=[]; await collectLaravelFiles(target.resolved,0,maxDepth,files); files.sort(); return textResult({ directory:target.relative,count:files.length,truncated:files.length>=500,files }); } catch(e){ return errorResult(e); } });

server.registerTool('laravel_read_file', {
  title: 'Laravelファイル読み取り', description: '許可されたLaravelファイルを読み取ります。', inputSchema: z.object({ filePath: z.string().min(1) }), annotations: { readOnlyHint: true }
}, async ({ filePath }) => { try { const target=await resolveExistingLaravelPath(filePath); if(!hasAllowedExtension(target.relative)) throw new Error('許可されていない形式です'); const info=await stat(target.resolved); if(!info.isFile()||info.size>MAX_FILE_SIZE) throw new Error('ファイルではないか1MBを超えています'); return textResult({filePath:target.relative,size:info.size,content:await readFile(target.resolved,'utf8')}); } catch(e){return errorResult(e);} });

server.registerTool('laravel_write_file', {
  title: 'Laravel安全ファイル作成・更新', description: '許可ディレクトリ内のファイルだけを作成・更新します。既存ファイルは自動バックアップします。削除はできません。', inputSchema: z.object({ filePath:z.string().min(1), content:z.string().max(MAX_FILE_SIZE), reason:z.string().min(5).max(500) }), annotations:{readOnlyHint:false,destructiveHint:true,idempotentHint:true,openWorldHint:false}
}, async({filePath,content,reason})=>{
  let relative=filePath;
  try{
    relative=normalizeRelativePath(filePath); const candidate=path.resolve(laravelRootRealPath,relative);
    ensureInsideRoot(candidate); if(!isWritablePath(relative)) throw new Error(`書き込み可能範囲外です。許可: ${writableRoots.join(', ')}`); if(!hasAllowedExtension(relative)) throw new Error('許可されていない形式です');
    await mkdir(path.dirname(candidate),{recursive:true}); let existed=false; let oldHash:null|string=null;
    try{ const resolved=await realpath(candidate); ensureInsideRoot(resolved); const info=await stat(resolved); if(!info.isFile()) throw new Error('対象が通常ファイルではありません'); existed=true; const old=await readFile(resolved); oldHash=crypto.createHash('sha256').update(old).digest('hex'); const backupDir=path.join(path.dirname(AUDIT_LOG),'laravel-file-backups',relative); await mkdir(path.dirname(backupDir),{recursive:true}); await copyFile(resolved,`${backupDir}.${Date.now()}.bak`); }catch(e){ if((e as NodeJS.ErrnoException).code!=='ENOENT' && !String(e).includes('realpath')) throw e; }
    await writeFile(candidate,content,{encoding:'utf8',mode:0o600}); const newHash=crypto.createHash('sha256').update(content).digest('hex'); await audit('laravel_write_file',relative,'success',{reason,existed,oldHash,newHash,size:Buffer.byteLength(content)}); return textResult({success:true,filePath:relative,created:!existed,updated:existed,newHash});
  }catch(e){await audit('laravel_write_file',relative,'failed',{reason,error:String(e)});return errorResult(e);}
});

server.registerTool('laravel_migration_status', {
  title: 'Laravel Migration状態確認', description: 'LaravelプロジェクトのMigration状態を読み取り専用で確認します。', inputSchema: z.object({}), annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
}, async () => {
  try {
    const { stdout, stderr } = await execFileAsync('/opt/homebrew/bin/php', ['artisan', 'migrate:status'], { cwd: laravelRootRealPath, timeout: 60000, maxBuffer: 1024 * 1024, env: { ...process.env, DB_CONNECTION: 'mysql', DB_HOST: process.env.AI_INFINITY_DB_HOST ?? '127.0.0.1', DB_PORT: process.env.AI_INFINITY_DB_PORT ?? '3307', DB_DATABASE: process.env.AI_INFINITY_DB_NAME ?? process.env.DB_NAME ?? 'ai_infinity', DB_USERNAME: process.env.AI_INFINITY_DB_USER ?? process.env.DB_USER ?? '', DB_PASSWORD: process.env.AI_INFINITY_DB_PASSWORD ?? process.env.DB_PASSWORD ?? '' } });
    await audit('laravel_migration_status', laravelRootRealPath, 'success');
    return textResult({ success: true, stdout, stderr });
  } catch (error) {
    await audit('laravel_migration_status', laravelRootRealPath, 'failed', { error: String(error) });
    return errorResult(error);
  }
});

server.registerTool('laravel_run_migrations', {
  title: 'Laravel Migration実行', description: 'Laravelプロジェクトに対して php artisan migrate --force のみを実行します。任意コマンドは実行できません。', inputSchema: z.object({ reason: z.string().min(5).max(500) }), annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
}, async ({ reason }) => {
  try {
    const { stdout, stderr } = await execFileAsync('/opt/homebrew/bin/php', ['artisan', 'migrate', '--force'], { cwd: laravelRootRealPath, timeout: 120000, maxBuffer: 2 * 1024 * 1024, env: { ...process.env, DB_CONNECTION: 'mysql', DB_HOST: process.env.AI_INFINITY_DB_HOST ?? '127.0.0.1', DB_PORT: process.env.AI_INFINITY_DB_PORT ?? '3307', DB_DATABASE: process.env.AI_INFINITY_DB_NAME ?? process.env.DB_NAME ?? 'ai_infinity', DB_USERNAME: process.env.AI_INFINITY_DB_USER ?? process.env.DB_USER ?? '', DB_PASSWORD: process.env.AI_INFINITY_DB_PASSWORD ?? process.env.DB_PASSWORD ?? '' } });
    await audit('laravel_run_migrations', laravelRootRealPath, 'success', { reason });
    return textResult({ success: true, command: 'php artisan migrate --force', stdout, stderr });
  } catch (error) {
    const executionError = error as { message?: string; stdout?: string; stderr?: string };
    const detail = [
      executionError.message ?? String(error),
      executionError.stdout ? 'STDOUT:\n' + executionError.stdout : '',
      executionError.stderr ? 'STDERR:\n' + executionError.stderr : '',
    ].filter(Boolean).join('\n');
    await audit('laravel_run_migrations', laravelRootRealPath, 'failed', { reason, error: detail });
    return errorResult(new Error(detail));
  }
});

registerExternalMemoryTools(server, pool);
registerProjectTools(server);
registerVpsOperatorTools(server);
registerMonkeyAiOperatorTools(server);
registerTunnelOperatorTools(server);
registerSoreAiOperatorTools(server);
registerSugoiAiSiteShindanOperatorTools(server);
registerAiLeadCreatorOperatorTools(server);
registerClaudeConsultTools(server);
registerClaudeContentTools(server);
registerClaudeDevelopTools(server);
registerProjectDatabaseProvisionTools(server);
try { const connection=await pool.getConnection(); await connection.ping(); connection.release(); console.error('MySQL connection: OK'); }
catch(error){ console.error('MySQL connection: FAILED',error); process.exit(1); }

export { server, pool };

// http-entry.ts imports `server` from this module to serve it over HTTP as well;
// only run the stdio transport when this file is executed directly (unchanged behavior for run-mcp-v4.sh).
const isMainModule = Boolean(process.argv[1]) && fileURLToPath(import.meta.url) === path.resolve(process.argv[1] as string);
if (isMainModule) {
  console.error('AI Infinity MCP v4 Server starting...');
  await serveStdio(()=>server);
}
