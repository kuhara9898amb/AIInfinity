import * as z from 'zod/v4';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  readdir,
  readFile,
  realpath,
  stat,
  writeFile,
  mkdir,
  copyFile,
} from 'node:fs/promises';

import {
  projects,
  getProject,
  createProjectPool,
  type ProjectKey,
} from './project-config.js';

type Server = {
  registerTool: (
    name: string,
    config: any,
    handler: (input: any) => Promise<any>
  ) => void;
};


const PROJECT_AUDIT_LOG =
  process.env.MCP_AUDIT_LOG ??
  '/Users/erka/AIInfinity/logs/mcp-v4-audit.jsonl';

async function projectAudit(
  action: string,
  target: string,
  status: 'success' | 'failed',
  details: Record<string, unknown> = {}
) {
  const { appendFile, mkdir } = await import('node:fs/promises');

  await mkdir(path.dirname(PROJECT_AUDIT_LOG), {
    recursive: true,
  });

  const safeDetails = JSON.parse(
    JSON.stringify(details, (key, value) =>
      /password|secret|token|api.?key|credential/i.test(key)
        ? '[REDACTED]'
        : value
    )
  );

  await appendFile(
    PROJECT_AUDIT_LOG,
    JSON.stringify({
      timestamp: new Date().toISOString(),
      action,
      target,
      status,
      details: safeDetails,
    }) + '\n',
    {
      encoding: 'utf8',
      mode: 0o600,
    }
  );
}

const projectSchema = z.enum([
  'aiinfinity',
  'dashboard98',
  'sages',
  'monkeyai',
  'mcpv4',
  'soreai',
  'sugoi_ai_site_shindan',
  'ai_lead_creator',
]);

const writableRoots = [
  'app',
  'resources',
  'routes',
  'config',
  'database/migrations',
  'tests',
  'public',
];

const allowedExtensions = [
  '.php',
  '.blade.php',
  '.js',
  '.ts',
  '.css',
  '.scss',
  '.json',
  '.md',
  '.yml',
  '.yaml',
  '.xml',
  '.txt',
];

const dbWriteColumns: Record<string, Set<string>> = {
  projects: new Set([
    'project_code','name','objective','description','status','priority',
    'current_agent_id','current_phase','workflow_version',
    'started_at','completed_at'
  ]),

  agents: new Set([
    'agent_code','name_ja','name_en','role_code','role_name',
    'description','sort_order','is_active'
  ]),

  prompts: new Set([
    'agent_id','prompt_type','name','version','content','change_summary'
  ]),

  tasks: new Set([
    'task_code','project_id','workflow_run_id','parent_task_id',
    'assigned_agent_id','next_agent_id','task_type','title','goal',
    'instructions','constraints_json','required_outputs_json','status',
    'quality_threshold','revision_count','max_revisions','due_at',
    'started_at','completed_at'
  ]),

  task_work_logs: new Set([
    'task_code','task_name','phase','worker_type','worker_name','status',
    'started_at','ended_at','duration_seconds','human_estimated_minutes',
    'outcome','meta'
  ]),

  goals: new Set([
    'parent_id','code','title','description','category','status','priority',
    'progress_percent','starts_on','due_on','completed_at'
  ]),

  kpis: new Set([
    'goal_id','code','name','unit','aggregation','baseline_value',
    'target_value','warning_threshold_percent','period_type','target_date',
    'status','display_order'
  ]),

  kpi_daily_snapshots: new Set([
    'kpi_id','snapshot_date','actual_value','target_value',
    'achievement_percent','change_from_previous','source','source_meta','note'
  ]),

  goal_progress_logs: new Set([
    'goal_id','progress_before','progress_after','change_reason','note',
    'recorded_by','recorded_at'
  ]),

  articles: new Set([
    'article_code','title','slug','summary','body','status','category',
    'primary_keyword','search_intent','target_audience','assigned_to',
    'priority','current_version','word_count','scheduled_at','published_at',
    'wp_post_id','wp_url'
  ]),

  article_versions: new Set([
    'article_id','version','title','summary','body','change_type',
    'change_summary','created_by','word_count'
  ]),

  article_tasks: new Set([
    'article_id','task_type','title','instructions','assigned_to','status',
    'due_at','completed_at'
  ]),

  article_publications: new Set([
    'article_id','platform','status','external_id','external_url',
    'scheduled_at','published_at','last_attempted_at','attempt_count',
    'error_message','response_meta'
  ]),

  article_metrics: new Set([
    'article_id','metric_date','pageviews','users','engagement_rate',
    'conversions','conversion_rate','search_clicks','search_impressions',
    'average_position','source'
  ]),

  article_reviews: new Set([
    'article_id','article_version','reviewer','review_type','status','score',
    'strengths','issues','revision_instructions','reviewed_at'
  ]),

  ai_meeting_runs: new Set([
    'run_code','meeting_date','meeting_type','status','progress_percent',
    'budget_limit_jpy','budget_warning_jpy','budget_target_jpy',
    'actual_cost_jpy','planned_rounds','completed_rounds','n8n_workflow_id',
    'n8n_execution_id','input_summary','final_summary','error_message',
    'scheduled_at','started_at','completed_at'
  ]),

  ai_meeting_agendas: new Set([
    'meeting_run_id','display_order','agenda_type','title','context',
    'related_kpi_ids','status','conclusion'
  ]),

  ai_meeting_messages: new Set([
    'meeting_run_id','agenda_id','round_number','sequence','agent','role',
    'provider','model','content','input_tokens','output_tokens','cache_tokens',
    'total_tokens','cost_usd','cost_jpy','exchange_rate','latency_ms','executed_at'
  ]),

  ai_meeting_reports: new Set([
    'meeting_run_id','report_type','title','executive_summary','key_findings',
    'risks','priority_actions','kpi_assessment','created_by'
  ]),

  ai_meeting_decisions: new Set([
    'meeting_run_id','agenda_id','decision_type','title','decision','reason',
    'owner_type','owner_name','due_on','status'
  ]),

  ai_meeting_tasks: new Set([
    'meeting_run_id','decision_id','task_code','title','instructions',
    'assignee_type','assignee_name','priority','status','due_at','completed_at'
  ]),

  ai_api_usage: new Set([
    'meeting_run_id','meeting_message_id','provider','model','purpose',
    'input_tokens','output_tokens','cache_read_tokens','cache_write_tokens',
    'total_tokens','input_cost_usd','output_cost_usd','total_cost_usd',
    'total_cost_jpy','exchange_rate','workflow_id','execution_id','node_id',
    'project_id','article_id','executed_at','usage_meta'
  ]),

  artifacts: new Set([
    'artifact_code','project_id','task_id','agent_run_id',
    'created_by_agent_id','artifact_type','title','summary','content',
    'content_json','version','status','quality_score',
    'file_path','external_url'
  ]),

  reviews: new Set([
    'project_id','task_id','artifact_id','reviewer_agent_id',
    'review_status','logic_score','business_value_score',
    'reproducibility_score','completeness_score','handoff_score',
    'total_score','strengths','issues','revision_instructions',
    'review_json'
  ]),

  sns_posts: new Set([
    'platform','account_name','post_type','purpose','theme',
    'target_audience','post_text','content_hash','selected_pattern',
    'media_url','thumbnail_url','link_url','research_json',
    'generation_json','quality_check_json','status',
    'duplicate_check_status','duplicate_post_id',
    'similarity_score','review_comment','scheduled_at'
  ]),

  sns_reply_candidates: new Set([
    'platform','account_name','agent_id','search_keyword',
    'target_post_id','target_username','target_user_id',
    'profile_text','target_post_text','target_post_url',
    'target_post_published_at','follower_count','like_count',
    'reply_count','matched_source','tone','decision',
    'selection_reason','relevance_score',
    'conversation_potential_score','relationship_potential_score',
    'reply_value_score','risk_score','risk_reasons_json',
    'rule_check_json','ai_reply_candidates_json',
    'recommended_reply_index','selected_reply_type',
    'selected_reply_text','status','review_comment','scheduled_at'
  ]),
};

const forbiddenDbStatus =
  new Set(['published','publishing','active']);

function validateProjectDbWrite(
  table: string,
  values: Record<string, unknown>
) {
  const allowed = dbWriteColumns[table];

  if (!allowed) {
    throw new Error(
      `書込みが許可されていないテーブルです: ${table}`
    );
  }

  const entries = Object.entries(values);

  if (!entries.length) {
    throw new Error('valuesが空です');
  }

  if (entries.length > 30) {
    throw new Error(
      '一度に更新できるカラムは30個までです'
    );
  }

  for (const [column, value] of entries) {

    if (!allowed.has(column)) {
      throw new Error(
        `${table}.${column}への書込みは禁止されています`
      );
    }

    if (
      column === 'status' &&
      forbiddenDbStatus.has(String(value))
    ) {
      throw new Error(
        `status=${value}への変更は専用承認フローが必要です`
      );
    }

    if (
      typeof value === 'string' &&
      value.length > 1_000_000
    ) {
      throw new Error(
        `${column}が1MBを超えています`
      );
    }
  }
}

function sqlValue(value: unknown): any {
  if (
    value !== null &&
    typeof value === 'object'
  ) {
    return JSON.stringify(value);
  }

  return value;
}


function writableRootsForProject(
  projectKey: ProjectKey
): string[] {
  return projectKey === 'mcpv4'
    ? ['src']
    : writableRoots;
}

function isWritablePath(
  projectKey: ProjectKey,
  relativePath: string
): boolean {
  const normalized = relativePath.replace(/^\.\//, '');
  const allowedRoots =
    writableRootsForProject(projectKey);

  return allowedRoots.some(
    root =>
      normalized === root ||
      normalized.startsWith(root + '/')
  );
}

const forbiddenReadSegments = new Set([
  '.git',
  'vendor',
  'node_modules',
  'storage',
]);

function assertSafeReadPath(relativePath: string): void {
  const normalized = relativePath
    .replace(/\\/g, '/')
    .replace(/^\.\//, '');

  const segments = normalized.split('/').filter(Boolean);

  for (const segment of segments) {
    const lower = segment.toLowerCase();

    if (
      lower === '.env' ||
      lower.startsWith('.env.') ||
      forbiddenReadSegments.has(lower)
    ) {
      throw new Error(
        '機密情報を含む可能性があるパスへのアクセスは禁止されています'
      );
    }
  }
}

function hasAllowedExtension(filePath: string): boolean {
  const lower = filePath.toLowerCase();

  return allowedExtensions.some(ext =>
    lower.endsWith(ext)
  );
}


function result(data: unknown) {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}

function identifier(value: string): string {
  if (!/^[A-Za-z0-9_]+$/.test(value)) {
    throw new Error(`不正な識別子です: ${value}`);
  }

  return `\`${value}\``;
}

async function safePath(
  projectKey: ProjectKey,
  relativePath: string,
  allowMissing = false
) {
  const project = getProject(projectKey);

  let root: string;
  let createdRoot = false;
  try {
    root = await realpath(project.laravelRoot);
  } catch (error: any) {
    if (!allowMissing || error?.code !== 'ENOENT') throw error;
    await mkdir(project.laravelRoot, { recursive: true, mode: 0o700 });
    root = await realpath(project.laravelRoot);
    createdRoot = true;
  }
  const candidate = path.resolve(root, relativePath || '.');

  if (
    candidate !== root &&
    !candidate.startsWith(root + path.sep)
  ) {
    throw new Error('プロジェクトルート外へのアクセスは禁止されています');
  }

  if (createdRoot) {
    return { root, candidate };
  }

  try {
    const realCandidate = await realpath(candidate);

    if (
      realCandidate !== root &&
      !realCandidate.startsWith(root + path.sep)
    ) {
      throw new Error(
        'symlink経由のプロジェクトルート外アクセスは禁止されています'
      );
    }

    return {
      root,
      candidate: realCandidate,
    };
  } catch (error: any) {
    if (!allowMissing || error?.code !== 'ENOENT') {
      throw error;
    }

    const parent = path.dirname(candidate);
    const realParent = await realpath(parent);

    if (
      realParent !== root &&
      !realParent.startsWith(root + path.sep)
    ) {
      throw new Error(
        'symlink経由のプロジェクトルート外書込みは禁止されています'
      );
    }

    return {
      root,
      candidate,
    };
  }
}

export function registerProjectTools(server: Server) {

  server.registerTool(
    'project_list',
    {
      title: '統合プロジェクト一覧',
      description:
        'AI Infinity MCP v4で操作可能なプロジェクト一覧を取得します。',
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
      },
    },
    async () => {
      return result(
        Object.values(projects).map(project => ({
          key: project.key,
          label: project.label,
          laravelRoot: project.laravelRoot,
          database: project.db.database,
        }))
      );
    }
  );

  server.registerTool(
    'project_db_tables',
    {
      title: 'プロジェクトDBテーブル一覧',
      description:
        '指定プロジェクトのMySQLテーブル一覧を取得します。',
      inputSchema: z.object({
        project: projectSchema,
      }),
      annotations: {
        readOnlyHint: true,
      },
    },
    async ({ project }) => {
      const pool = createProjectPool(project);

      try {
        const [rows] = await pool.query('SHOW TABLES');

        return result(rows);
      } finally {
        await pool.end();
      }
    }
  );

  server.registerTool(
    'project_db_query',
    {
      title: 'プロジェクトDB安全SELECT',
      description:
        '指定プロジェクトにSELECT / SHOW / DESCRIBE / EXPLAINのみ実行します。',
      inputSchema: z.object({
        project: projectSchema,
        sql: z.string().min(1).max(20000),
      }),
      annotations: {
        readOnlyHint: true,
      },
    },
    async ({ project, sql }) => {

      const normalized = sql
        .trim()
        .replace(/^\(+/, '')
        .toUpperCase();

      const allowed = [
        'SELECT',
        'SHOW',
        'DESCRIBE',
        'DESC',
        'EXPLAIN',
      ];

      if (!allowed.some(prefix => normalized.startsWith(prefix))) {
        throw new Error(
          'SELECT / SHOW / DESCRIBE / EXPLAIN以外は禁止されています'
        );
      }

      const sqlWithoutTrailingSemicolon =
        sql.trim().replace(/;\s*$/, '');

      if (sqlWithoutTrailingSemicolon.includes(';')) {
        throw new Error(
          '複数SQLの実行は禁止されています'
        );
      }

      const pool = createProjectPool(project);

      try {
        const [rows] = await pool.query(sql);

        return result(rows);
      } finally {
        await pool.end();
      }
    }
  );

  server.registerTool(
    'project_file_list',
    {
      title: 'プロジェクトファイル一覧',
      description:
        '指定Laravelプロジェクト内のファイルを安全に一覧取得します。',
      inputSchema: z.object({
        project: projectSchema,
        directory: z.string().default('.'),
      }),
      annotations: {
        readOnlyHint: true,
      },
    },
    async ({ project, directory }) => {

      const { candidate } =
        await safePath(project, directory);

      const entries = await readdir(candidate, {
        withFileTypes: true,
      });

      return result(
        entries.map(entry => ({
          name: entry.name,
          type: entry.isDirectory()
            ? 'directory'
            : 'file',
        }))
      );
    }
  );

  server.registerTool(
    'project_file_read',
    {
      title: 'プロジェクトファイル読込',
      description:
        '指定Laravelプロジェクト内のテキストファイルを安全に読み取ります。',
      inputSchema: z.object({
        project: projectSchema,
        filePath: z.string().min(1),
      }),
      annotations: {
        readOnlyHint: true,
      },
    },
    async ({ project, filePath }) => {

      assertSafeReadPath(filePath);

      const { candidate } =
        await safePath(project, filePath);

      const info = await stat(candidate);

      if (!info.isFile()) {
        throw new Error(
          '指定されたパスはファイルではありません'
        );
      }

      if (info.size > 1024 * 1024) {
        throw new Error(
          '1MBを超えるファイルは読み取れません'
        );
      }

      const content =
        await readFile(candidate, 'utf8');

      return result({
        project,
        filePath,
        size: info.size,
        content,
      });
    }
  );

  server.registerTool(
    'project_file_write',
    {
      title: 'プロジェクトファイル安全書込み',
      description:
        '指定プロジェクトの許可ディレクトリ内のテキストファイルだけを、変更前バックアップ付きで作成・更新します。',
      inputSchema: z.object({
        project: projectSchema,
        filePath: z.string().min(1),
        content: z.string().max(1024 * 1024),
        reason: z.string().min(5).max(500),
      }),
    },
    async ({ project, filePath, content, reason }) => {

      const normalized =
        filePath.replace(/^\.?\//, '');

      if (!isWritablePath(project, normalized)) {
        throw new Error(
          `書込み可能範囲外です。許可: ${writableRootsForProject(project).join(', ')}`
        );
      }

      if (!hasAllowedExtension(normalized)) {
        throw new Error(
          '許可されていないファイル形式です'
        );
      }

      const { root, candidate } =
        await safePath(project, normalized, true);

      let existed = false;
      let oldHash: string | null = null;

      try {
        const info = await stat(candidate);

        if (!info.isFile()) {
          throw new Error(
            '既存対象が通常ファイルではありません'
          );
        }

        existed = true;

        const old = await readFile(candidate);

        oldHash = crypto
          .createHash('sha256')
          .update(old)
          .digest('hex');

        const backupRoot = path.join(
          root,
          'storage',
          'mcp-v4-backups'
        );

        const backupPath = path.join(
          backupRoot,
          normalized +
            '.' +
            Date.now() +
            '.bak'
        );

        await mkdir(
          path.dirname(backupPath),
          { recursive: true }
        );

        await copyFile(
          candidate,
          backupPath
        );

      } catch (error: any) {

        if (
          error?.code !== 'ENOENT' &&
          !String(error).includes(
            '通常ファイルではありません'
          )
        ) {
          throw error;
        }

        if (
          String(error).includes(
            '通常ファイルではありません'
          )
        ) {
          throw error;
        }

        await mkdir(
          path.dirname(candidate),
          { recursive: true }
        );
      }

      try {

        await writeFile(
          candidate,
          content,
          {
            encoding: 'utf8',
            mode: 0o600,
          }
        );

      } catch (error) {

        await projectAudit(
          'project_file_write',
          `${project}:${normalized}`,
          'failed',
          {
            reason,
            project,
            filePath: normalized,
            error: String(error),
          }
        );

        throw error;
      }

      const newHash = crypto
        .createHash('sha256')
        .update(content)
        .digest('hex');

      await projectAudit(
        'project_file_write',
        `${project}:${normalized}`,
        'success',
        {
          reason,
          project,
          filePath: normalized,
          created: !existed,
          updated: existed,
          oldHash,
          newHash,
        }
      );

      return result({
        success: true,
        project,
        filePath: normalized,
        reason,
        created: !existed,
        updated: existed,
        oldHash,
        newHash,
      });
    }
  );


  server.registerTool(
    'project_db_insert',
    {
      title: 'プロジェクトDB安全INSERT',
      description:
        '指定プロジェクトの許可テーブル・許可カラムへ1レコードだけ追加します。',
      inputSchema: z.object({
        project: projectSchema,
        tableName: z.string().regex(/^[A-Za-z0-9_]+$/),
        values: z.record(
          z.string().regex(/^[A-Za-z0-9_]+$/),
          z.unknown()
        ),
        reason: z.string().min(5).max(500),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ project, tableName, values, reason }) => {

      validateProjectDbWrite(
        tableName,
        values
      );

      const pool =
        createProjectPool(project);

      try {

        const columns =
          Object.keys(values);

        const sql =
          `INSERT INTO ${identifier(tableName)} (` +
          columns
            .map(column => identifier(column))
            .join(', ') +
          `) VALUES (` +
          columns
            .map(() => '?')
            .join(', ') +
          `)`;

        const [out]: any =
          await pool.execute(
            sql,
            columns.map(column =>
              sqlValue(values[column])
            )
          );

        await projectAudit(
          'project_db_insert',
          `${project}:${tableName}`,
          'success',
          {
            reason,
            project,
            tableName,
            columns,
            insertId: out.insertId,
            affectedRows: out.affectedRows,
          }
        );

        return result({
          success: true,
          project,
          tableName,
          reason,
          insertId: out.insertId,
          affectedRows: out.affectedRows,
        });

      } catch (error) {

        await projectAudit(
          'project_db_insert',
          `${project}:${tableName}`,
          'failed',
          {
            reason,
            project,
            tableName,
            error: String(error),
          }
        );

        throw error;

      } finally {
        await pool.end();
      }
    }
  );


  server.registerTool(
    'project_db_update',
    {
      title: 'プロジェクトDB安全UPDATE',
      description:
        '指定プロジェクトの許可テーブル・許可カラムを主キーid指定で1レコードだけ更新します。',
      inputSchema: z.object({
        project: projectSchema,
        tableName: z.string().regex(/^[A-Za-z0-9_]+$/),
        id: z.number().int().positive(),
        values: z.record(
          z.string().regex(/^[A-Za-z0-9_]+$/),
          z.unknown()
        ),
        reason: z.string().min(5).max(500),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({
      project,
      tableName,
      id,
      values,
      reason
    }) => {

      validateProjectDbWrite(
        tableName,
        values
      );

      const pool =
        createProjectPool(project);

      const connection =
        await pool.getConnection();

      try {

        await connection.beginTransaction();

        const [beforeRows]: any =
          await connection.execute(
            `SELECT * FROM ${identifier(tableName)}
             WHERE id = ?
             FOR UPDATE`,
            [id]
          );

        const before =
          Array.isArray(beforeRows)
            ? beforeRows[0]
            : null;

        if (!before) {
          throw new Error(
            `id=${id}のレコードが存在しません`
          );
        }

        const columns =
          Object.keys(values);

        const sql =
          `UPDATE ${identifier(tableName)}
           SET ` +
          columns
            .map(
              column =>
                `${identifier(column)} = ?`
            )
            .join(', ') +
          ` WHERE id = ? LIMIT 1`;

        const [out]: any =
          await connection.execute(
            sql,
            [
              ...columns.map(column =>
                sqlValue(values[column])
              ),
              id
            ]
          );

        if (out.affectedRows > 1) {
          throw new Error(
            '複数行更新を検出したため中止しました'
          );
        }

        const [afterRows]: any =
          await connection.execute(
            `SELECT * FROM ${identifier(tableName)}
             WHERE id = ?`,
            [id]
          );

        await connection.commit();

        await projectAudit(
          'project_db_update',
          `${project}:${tableName}:${id}`,
          'success',
          {
            reason,
            project,
            tableName,
            id,
            columns,
            affectedRows: out.affectedRows,
            changedRows: out.changedRows,
          }
        );

        return result({
          success: true,
          project,
          tableName,
          id,
          reason,
          affectedRows: out.affectedRows,
          changedRows: out.changedRows,
          before,
          after:
            Array.isArray(afterRows)
              ? afterRows[0]
              : null,
        });

      } catch (error) {

        await connection.rollback();

        await projectAudit(
          'project_db_update',
          `${project}:${tableName}:${id}`,
          'failed',
          {
            reason,
            project,
            tableName,
            id,
            error: String(error),
          }
        );

        throw error;

      } finally {

        connection.release();
        await pool.end();
      }
    }
  );

}
