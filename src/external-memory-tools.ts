import * as z from 'zod/v4';

const OWNER = 'kuhara_hisashi';

type Pool = {
  query: (sql: string, values?: unknown[]) => Promise<[any, any]>;
  getConnection: () => Promise<any>;
};

type Server = {
  registerTool: (name: string, config: any, handler: (input: any) => Promise<any>) => void;
};

const jsonArray = z.array(z.unknown()).optional();
const nullableId = z.number().int().positive().nullable().optional();
const nullableText = z.string().nullable().optional();
const nullableDateTime = z.string().nullable().optional();

const CACHE_TTL_MS = 30_000;
const responseCache = new Map<string, { createdAt: number; expiresAt: number; value: unknown }>();

function cacheGet(key: string): unknown | undefined {
  const entry = responseCache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    responseCache.delete(key);
    return undefined;
  }
  return entry.value;
}

function cacheSet(key: string, value: unknown): void {
  const createdAt = Date.now();
  responseCache.set(key, {
    createdAt,
    expiresAt: createdAt + CACHE_TTL_MS,
    value,
  });
  if (responseCache.size > 200) {
    const firstKey = responseCache.keys().next().value;
    if (firstKey) responseCache.delete(firstKey);
  }
}

function withCacheHit(key: string, value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, any>;
    const entry = responseCache.get(key);
    const previousSqlMs = Number(record._meta?.sql_ms ?? 0);
    return {
      ...record,
      _meta: {
        ...(record._meta ?? {}),
        sql_ms: 0,
        original_sql_ms: previousSqlMs,
        cache: 'hit',
        cache_age_ms: entry ? Math.max(0, Date.now() - entry.createdAt) : null,
      },
    };
  }
  return value;
}

function withServerTiming(value: unknown, serverMs: number): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, any>;
    return {
      ...record,
      _meta: {
        ...(record._meta ?? {}),
        server_ms: serverMs,
      },
    };
  }
  return value;
}

function result(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

function failure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true };
}

function encodeJson(value: unknown) {
  return value === undefined ? undefined : value === null ? null : JSON.stringify(value);
}

function code(prefix: string) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function register(server: Server, name: string, title: string, description: string, schema: any, readOnly: boolean, handler: (input: any) => Promise<unknown>) {
  server.registerTool(name, {
    title,
    description,
    inputSchema: schema,
    annotations: readOnly ? { readOnlyHint: true } : { readOnlyHint: false, destructiveHint: false },
  }, async input => {
    const startedAt = performance.now();
    try {
      const handledData = await handler(input);
      const serverMs = Math.round((performance.now() - startedAt) * 100) / 100;
      const data = withServerTiming(handledData, serverMs);
      const serializedSize = JSON.stringify(data).length;
      console.error(JSON.stringify({
        type: 'mcp_tool_metric',
        tool: name,
        total_ms: Math.round((performance.now() - startedAt) * 100) / 100,
        result_chars: serializedSize,
        success: true,
      }));
      return result(data);
    } catch (error) {
      console.error(JSON.stringify({
        type: 'mcp_tool_metric',
        tool: name,
        total_ms: Math.round((performance.now() - startedAt) * 100) / 100,
        result_chars: 0,
        success: false,
      }));
      return failure(error);
    }
  });
}

async function one(pool: Pool, sql: string, values: unknown[] = []) {
  const [rows] = await pool.query(sql, values);
  return Array.isArray(rows) ? rows[0] ?? null : rows;
}

async function updateById(pool: Pool, table: string, id: number, allowed: Set<string>, input: Record<string, any>, jsonFields: Set<string> = new Set()) {
  const entries = Object.entries(input).filter(([key, value]) => key !== 'id' && allowed.has(key) && value !== undefined);
  if (!entries.length) throw new Error('更新項目がありません');
  const sets = entries.map(([key]) => `\`${key}\` = ?`).join(', ');
  const values = entries.map(([key, value]) => jsonFields.has(key) ? encodeJson(value) : value);
  const [out] = await pool.query(`UPDATE \`${table}\` SET ${sets}, updated_at = NOW() WHERE id = ? AND owner_key = ?`, [...values, id, OWNER]);
  if (!out.affectedRows) throw new Error('対象データが見つかりません');
  return one(pool, `SELECT * FROM \`${table}\` WHERE id = ? AND owner_key = ?`, [id, OWNER]);
}

export function registerExternalMemoryTools(server: any, pool: any) {
  register(server, 'get_bootstrap_context', '起動コンテキスト取得', '新しい会話の開始時に必要な重要情報だけを軽量取得します。標準は各3件、30秒キャッシュです。', z.object({ limitPerSection: z.number().int().min(1).max(10).default(3) }), true, async ({ limitPerSection }) => {
    const cacheKey = `bootstrap:${limitPerSection}`;
    const cached = cacheGet(cacheKey);
    if (cached) return withCacheHit(cacheKey, cached);

    const sqlStartedAt = performance.now();
    const [memories, tasks, goals, people, conversations] = await Promise.all([
      pool.query(`SELECT id,project_id,category,title,COALESCE(summary,LEFT(content,240)) AS summary,importance,updated_at FROM knowledge_memories WHERE owner_key=? AND status='active' AND (effective_until IS NULL OR effective_until>NOW()) ORDER BY importance DESC,updated_at DESC LIMIT ?`, [OWNER, limitPerSection]),
      pool.query(`SELECT id,project_id,category,title,LEFT(description,240) AS summary,status,priority,due_at,updated_at FROM user_tasks WHERE owner_key=? AND status IN ('pending','in_progress','blocked') AND archived_at IS NULL ORDER BY FIELD(priority,'urgent','high','medium','low'),due_at IS NULL,due_at LIMIT ?`, [OWNER, limitPerSection]),
      pool.query(`SELECT id,project_id,category,title,LEFT(description,240) AS summary,status,priority,target_date,progress_percent,updated_at FROM user_goals WHERE owner_key=? AND status='active' AND archived_at IS NULL ORDER BY FIELD(priority,'urgent','high','medium','low'),target_date IS NULL,target_date LIMIT ?`, [OWNER, limitPerSection]),
      pool.query(`SELECT id,full_name AS title,company_name,position_name,LEFT(profile,240) AS summary,importance,last_contacted_on,updated_at FROM people WHERE owner_key=? AND status='active' ORDER BY importance DESC,last_contacted_on DESC LIMIT ?`, [OWNER, limitPerSection]),
      pool.query(`SELECT id,project_id,title,LEFT(summary,240) AS summary,COALESCE(conversation_ended_at,updated_at) AS context_at,updated_at FROM conversation_summaries WHERE owner_key=? AND status='active' ORDER BY COALESCE(conversation_ended_at,updated_at) DESC LIMIT ?`, [OWNER, limitPerSection]),
    ]);
    const value = {
      owner_key: OWNER,
      memories: memories[0],
      tasks: tasks[0],
      goals: goals[0],
      people: people[0],
      conversation_summaries: conversations[0],
      _meta: {
        sql_ms: Math.round((performance.now() - sqlStartedAt) * 100) / 100,
        cache: 'miss',
        limit_per_section: limitPerSection,
      },
    };
    cacheSet(cacheKey, value);
    return value;
  });

  register(server, 'search_personal_context', '個人コンテキスト検索', '個人記憶、タスク、目標、人物、面談履歴、会話要約をキーワード横断検索します。', z.object({ query: z.string().min(1), limit: z.number().int().min(1).max(50).default(20) }), true, async ({ query, limit }) => {
    const q = `%${query}%`;
    const searches = await Promise.all([
      pool.query(`SELECT 'memory' AS context_type,id,title,summary,content,updated_at FROM knowledge_memories WHERE owner_key=? AND status='active' AND (title LIKE ? OR summary LIKE ? OR content LIKE ? OR tags_json LIKE ?) ORDER BY importance DESC,updated_at DESC LIMIT ?`, [OWNER,q,q,q,q,limit]),
      pool.query(`SELECT 'task' AS context_type,id,title,description AS summary,notes AS content,updated_at FROM user_tasks WHERE owner_key=? AND archived_at IS NULL AND (title LIKE ? OR description LIKE ? OR notes LIKE ? OR tags_json LIKE ?) ORDER BY updated_at DESC LIMIT ?`, [OWNER,q,q,q,q,limit]),
      pool.query(`SELECT 'goal' AS context_type,id,title,description AS summary,NULL AS content,updated_at FROM user_goals WHERE owner_key=? AND archived_at IS NULL AND (title LIKE ? OR description LIKE ? OR tags_json LIKE ?) ORDER BY updated_at DESC LIMIT ?`, [OWNER,q,q,q,limit]),
      pool.query(`SELECT 'person' AS context_type,id,full_name AS title,profile AS summary,relationship_notes AS content,updated_at FROM people WHERE owner_key=? AND status='active' AND (full_name LIKE ? OR display_name LIKE ? OR name_kana LIKE ? OR aliases_json LIKE ? OR company_name LIKE ? OR profile LIKE ? OR relationship_notes LIKE ? OR tags_json LIKE ?) ORDER BY importance DESC,updated_at DESC LIMIT ?`, [OWNER,q,q,q,q,q,q,q,q,limit]),
      pool.query(`SELECT 'interaction' AS context_type,id,COALESCE(title,interaction_type) AS title,summary,conversation_details AS content,updated_at FROM person_interactions WHERE owner_key=? AND (title LIKE ? OR summary LIKE ? OR conversation_details LIKE ? OR topics_json LIKE ?) ORDER BY interacted_at DESC LIMIT ?`, [OWNER,q,q,q,q,limit]),
      pool.query(`SELECT 'conversation' AS context_type,id,title,summary,NULL AS content,updated_at FROM conversation_summaries WHERE owner_key=? AND status='active' AND (title LIKE ? OR summary LIKE ? OR topics_json LIKE ? OR decisions_json LIKE ?) ORDER BY updated_at DESC LIMIT ?`, [OWNER,q,q,q,q,limit]),
    ]);
    return searches.flatMap(x => x[0]).slice(0, limit);
  });

  register(server, 'search_context', '軽量統合コンテキスト検索', '記憶・タスク・目標・人物・接触履歴・会話要約を横断し、本文を除いた上位候補だけ返します。標準5件、30秒キャッシュです。includeTopDetail=trueなら検索1位の詳細も同じ1回の呼び出しで返します。', z.object({ query: z.string().min(1).max(500), limit: z.number().int().min(1).max(10).default(5), includeTopDetail: z.boolean().default(false) }), true, async ({ query, limit, includeTopDetail }) => {
    const normalizedQuery = query.trim();
    const cacheKey = `search_context:${normalizedQuery.toLowerCase()}:${limit}:${includeTopDetail ? 'detail' : 'summary'}`;
    const cached = cacheGet(cacheKey);
    if (cached) return withCacheHit(cacheKey, cached);

    const q = `%${normalizedQuery}%`;
    const perTypeLimit = Math.min(limit, 5);
    const sqlStartedAt = performance.now();
    const searches = await Promise.all([
      pool.query(`SELECT 'memory' AS context_type,id,title,LEFT(COALESCE(summary,content),240) AS summary,updated_at,importance AS relevance FROM knowledge_memories WHERE owner_key=? AND status='active' AND (title LIKE ? OR summary LIKE ? OR content LIKE ? OR tags_json LIKE ?) ORDER BY importance DESC,updated_at DESC LIMIT ?`, [OWNER,q,q,q,q,perTypeLimit]),
      pool.query(`SELECT 'task' AS context_type,id,title,LEFT(COALESCE(description,notes),240) AS summary,updated_at,CASE priority WHEN 'urgent' THEN 5 WHEN 'high' THEN 4 WHEN 'medium' THEN 3 ELSE 2 END AS relevance FROM user_tasks WHERE owner_key=? AND archived_at IS NULL AND (title LIKE ? OR description LIKE ? OR notes LIKE ? OR tags_json LIKE ?) ORDER BY relevance DESC,updated_at DESC LIMIT ?`, [OWNER,q,q,q,q,perTypeLimit]),
      pool.query(`SELECT 'goal' AS context_type,id,title,LEFT(description,240) AS summary,updated_at,CASE priority WHEN 'urgent' THEN 5 WHEN 'high' THEN 4 WHEN 'medium' THEN 3 ELSE 2 END AS relevance FROM user_goals WHERE owner_key=? AND archived_at IS NULL AND (title LIKE ? OR description LIKE ? OR tags_json LIKE ?) ORDER BY relevance DESC,updated_at DESC LIMIT ?`, [OWNER,q,q,q,perTypeLimit]),
      pool.query(`SELECT 'person' AS context_type,id,full_name AS title,LEFT(CONCAT_WS(' / ',company_name,profile),240) AS summary,updated_at,importance AS relevance FROM people WHERE owner_key=? AND status='active' AND (full_name LIKE ? OR display_name LIKE ? OR name_kana LIKE ? OR aliases_json LIKE ? OR company_name LIKE ? OR profile LIKE ? OR relationship_notes LIKE ? OR tags_json LIKE ?) ORDER BY importance DESC,updated_at DESC LIMIT ?`, [OWNER,q,q,q,q,q,q,q,q,perTypeLimit]),
      pool.query(`SELECT 'interaction' AS context_type,id,COALESCE(title,interaction_type) AS title,LEFT(summary,240) AS summary,updated_at,importance AS relevance FROM person_interactions WHERE owner_key=? AND (title LIKE ? OR summary LIKE ? OR conversation_details LIKE ? OR topics_json LIKE ?) ORDER BY importance DESC,interacted_at DESC LIMIT ?`, [OWNER,q,q,q,q,perTypeLimit]),
      pool.query(`SELECT 'conversation' AS context_type,id,title,LEFT(summary,240) AS summary,updated_at,3 AS relevance FROM conversation_summaries WHERE owner_key=? AND status='active' AND (title LIKE ? OR summary LIKE ? OR topics_json LIKE ? OR decisions_json LIKE ?) ORDER BY updated_at DESC LIMIT ?`, [OWNER,q,q,q,q,perTypeLimit]),
    ]);
    const items = searches
      .flatMap((entry: any) => entry[0])
      .sort((a: any, b: any) => Number(b.relevance) - Number(a.relevance) || String(b.updated_at).localeCompare(String(a.updated_at)))
      .slice(0, limit);
    let topDetail: { context_type: string; item: unknown } | null = null;
    if (includeTopDetail && items.length > 0) {
      const tables: Record<string, string> = {
        memory: 'knowledge_memories',
        task: 'user_tasks',
        goal: 'user_goals',
        person: 'people',
        interaction: 'person_interactions',
        conversation: 'conversation_summaries',
      };
      const top = items[0];
      const table = tables[top.context_type];
      const item = await one(pool, `SELECT * FROM \`${table}\` WHERE id=? AND owner_key=? LIMIT 1`, [top.id, OWNER]);
      topDetail = item ? { context_type: top.context_type, item } : null;
    }
    const value = {
      query: normalizedQuery,
      items,
      top_detail: topDetail,
      _meta: {
        sql_ms: Math.round((performance.now() - sqlStartedAt) * 100) / 100,
        cache: 'miss',
        returned: items.length,
      },
    };
    cacheSet(cacheKey, value);
    return value;
  });


  register(server, 'get_task_context', '軽量タスクコンテキスト取得', 'タスクの一覧検索またはID指定の詳細取得を1回で行います。一覧は本文を省略し標準5件、30秒キャッシュです。', z.object({
    id: z.number().int().positive().optional(),
    query: z.string().max(500).optional(),
    status: z.enum(['pending','in_progress','blocked','completed','cancelled']).optional(),
    limit: z.number().int().min(1).max(10).default(5),
  }), true, async ({ id, query, status, limit }) => {
    const normalizedQuery = query?.trim() ?? '';
    const cacheKey = `get_task_context:${id ?? 'list'}:${normalizedQuery.toLowerCase()}:${status ?? 'active'}:${limit}`;
    const cached = cacheGet(cacheKey);
    if (cached) return withCacheHit(cacheKey, cached);

    const sqlStartedAt = performance.now();
    let value: Record<string, any>;
    if (id) {
      const item = await one(pool, `SELECT * FROM user_tasks WHERE id=? AND owner_key=? LIMIT 1`, [id, OWNER]);
      if (!item) throw new Error('対象タスクが見つかりません');
      value = { mode: 'detail', item };
    } else {
      let sql = `SELECT id,project_id,category,title,LEFT(COALESCE(description,notes),240) AS summary,status,priority,due_at,updated_at FROM user_tasks WHERE owner_key=? AND archived_at IS NULL`;
      const values: unknown[] = [OWNER];
      if (status) {
        sql += ' AND status=?';
        values.push(status);
      } else {
        sql += ` AND status IN ('pending','in_progress','blocked')`;
      }
      if (normalizedQuery) {
        const q = `%${normalizedQuery}%`;
        sql += ' AND (title LIKE ? OR description LIKE ? OR notes LIKE ? OR tags_json LIKE ?)';
        values.push(q, q, q, q);
      }
      sql += ` ORDER BY FIELD(priority,'urgent','high','medium','low'),due_at IS NULL,due_at,updated_at DESC LIMIT ?`;
      values.push(limit);
      const [items] = await pool.query(sql, values);
      value = { mode: 'list', query: normalizedQuery || null, status: status ?? 'active', items };
    }
    value._meta = {
      sql_ms: Math.round((performance.now() - sqlStartedAt) * 100) / 100,
      cache: 'miss',
      returned: value.items?.length ?? 1,
    };
    cacheSet(cacheKey, value);
    return value;
  });

  register(server, 'fetch_context', 'コンテキスト詳細取得', 'search_contextで選ばれた種類とIDを指定し、必要な1レコードの詳細だけ取得します。', z.object({
    contextType: z.enum(['memory','task','goal','person','interaction','conversation']),
    id: z.number().int().positive(),
  }), true, async ({ contextType, id }) => {
    const tables: Record<string, string> = {
      memory: 'knowledge_memories',
      task: 'user_tasks',
      goal: 'user_goals',
      person: 'people',
      interaction: 'person_interactions',
      conversation: 'conversation_summaries',
    };
    const table = tables[contextType];
    const cacheKey = `fetch_context:${contextType}:${id}`;
    const cached = cacheGet(cacheKey);
    if (cached) return withCacheHit(cacheKey, cached);
    const sqlStartedAt = performance.now();
    const item = await one(pool, `SELECT * FROM \`${table}\` WHERE id=? AND owner_key=? LIMIT 1`, [id, OWNER]);
    if (!item) throw new Error('対象コンテキストが見つかりません');
    const value = {
      context_type: contextType,
      item,
      _meta: {
        sql_ms: Math.round((performance.now() - sqlStartedAt) * 100) / 100,
        cache: 'miss',
      },
    };
    cacheSet(cacheKey, value);
    return value;
  });

  register(server, 'save_memory', '記憶保存', '確定した特性、趣味嗜好、回答の好み、禁止事項、決定事項などを外部記憶へ保存します。', z.object({ memoryKey: z.string().min(1).max(191).optional(), category: z.string().min(1).max(50), title: z.string().min(1), summary: nullableText, content: z.string().min(1), tags: jsonArray, projectId: nullableId, importance: z.number().int().min(1).max(5).default(3), confidence: z.number().min(0).max(100).default(100), sourceType: z.string().max(50).default('conversation'), sourceReference: nullableText, effectiveFrom: nullableDateTime, effectiveUntil: nullableDateTime }), false, async input => {
    const memoryKey = input.memoryKey ?? code('memory');
    const [out] = await pool.query(`INSERT INTO knowledge_memories (owner_key,memory_key,category,title,summary,content,tags_json,project_id,importance,confidence,source_type,source_reference,status,version,effective_from,effective_until,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'active',1,?,?,NOW(),NOW())`, [OWNER,memoryKey,input.category,input.title,input.summary ?? null,input.content,encodeJson(input.tags),input.projectId ?? null,input.importance,input.confidence,input.sourceType,input.sourceReference ?? null,input.effectiveFrom ?? null,input.effectiveUntil ?? null]);
    return one(pool, 'SELECT * FROM knowledge_memories WHERE id=? AND owner_key=?', [out.insertId,OWNER]);
  });

  register(server, 'update_memory', '記憶更新', '既存記憶を更新し、更新前の内容をバージョン履歴に保存します。', z.object({ id: z.number().int().positive(), category: z.string().max(50).optional(), title: z.string().optional(), summary: nullableText, content: z.string().optional(), tags: jsonArray, projectId: nullableId, importance: z.number().int().min(1).max(5).optional(), confidence: z.number().min(0).max(100).optional(), status: z.enum(['active','archived','superseded']).optional(), effectiveFrom: nullableDateTime, effectiveUntil: nullableDateTime, changeReason: nullableText }), false, async input => {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [rows] = await conn.query('SELECT * FROM knowledge_memories WHERE id=? AND owner_key=? FOR UPDATE',[input.id,OWNER]);
      const current = rows[0]; if (!current) throw new Error('対象記憶が見つかりません');
      await conn.query(`INSERT INTO knowledge_memory_versions (knowledge_memory_id,version,title,summary,content,tags_json,category,importance,confidence,status,change_reason,changed_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,NOW(),NOW())`, [current.id,current.version,current.title,current.summary,current.content,encodeJson(current.tags_json),current.category,current.importance,current.confidence,current.status,input.changeReason ?? null,'chatgpt']);
      const map:any = { category:input.category,title:input.title,summary:input.summary,content:input.content,tags_json:encodeJson(input.tags),project_id:input.projectId,importance:input.importance,confidence:input.confidence,status:input.status,effective_from:input.effectiveFrom,effective_until:input.effectiveUntil };
      const entries=Object.entries(map).filter(([,v])=>v!==undefined); const sets=entries.map(([k])=>`\`${k}\`=?`).join(', ');
      await conn.query(`UPDATE knowledge_memories SET ${sets ? sets+',' : ''} version=version+1,updated_at=NOW() WHERE id=? AND owner_key=?`,[...entries.map(([,v])=>v),input.id,OWNER]);
      await conn.commit(); return one(pool,'SELECT * FROM knowledge_memories WHERE id=? AND owner_key=?',[input.id,OWNER]);
    } catch(e){ await conn.rollback(); throw e; } finally { conn.release(); }
  });

  register(server, 'archive_memory', '記憶アーカイブ', '不要または過去になった記憶を削除せずアーカイブします。', z.object({ id:z.number().int().positive(), reason:nullableText }), false, async ({id,reason}) => {
    const current=await one(pool,'SELECT * FROM knowledge_memories WHERE id=? AND owner_key=?',[id,OWNER]); if(!current) throw new Error('対象記憶が見つかりません');
    await pool.query(`INSERT INTO knowledge_memory_versions (knowledge_memory_id,version,title,summary,content,tags_json,category,importance,confidence,status,change_reason,changed_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,NOW(),NOW())`,[current.id,current.version,current.title,current.summary,current.content,encodeJson(current.tags_json),current.category,current.importance,current.confidence,current.status,reason ?? 'archived','chatgpt']);
    await pool.query(`UPDATE knowledge_memories SET status='archived',version=version+1,effective_until=COALESCE(effective_until,NOW()),updated_at=NOW() WHERE id=? AND owner_key=?`,[id,OWNER]); return {id,status:'archived'};
  });

  register(server,'list_user_tasks','個人タスク一覧','久原央士の個人タスクを状態、カテゴリ、期限で取得します。',z.object({status:z.string().optional(),category:z.string().optional(),dueBefore:nullableDateTime,includeArchived:z.boolean().default(false),limit:z.number().int().min(1).max(100).default(50)}),true,async i=>{
    let sql='SELECT * FROM user_tasks WHERE owner_key=?'; const v:any[]=[OWNER]; if(i.status){sql+=' AND status=?';v.push(i.status)} if(i.category){sql+=' AND category=?';v.push(i.category)} if(i.dueBefore){sql+=' AND due_at<=?';v.push(i.dueBefore)} if(!i.includeArchived)sql+=' AND archived_at IS NULL'; sql+=` ORDER BY FIELD(priority,'urgent','high','medium','low'),due_at IS NULL,due_at,created_at DESC LIMIT ?`;v.push(i.limit); return (await pool.query(sql,v))[0];
  });
  register(server,'save_user_task','個人タスク保存','新しい個人タスクを保存します。AI実行タスク用tasksテーブルとは分離されています。',z.object({taskCode:z.string().max(100).optional(),projectId:nullableId,category:nullableText,title:z.string().min(1),description:nullableText,status:z.enum(['pending','in_progress','blocked','completed','cancelled']).default('pending'),priority:z.enum(['low','medium','high','urgent']).default('medium'),dueAt:nullableDateTime,tags:jsonArray,sourceType:z.string().max(50).default('conversation'),sourceReference:nullableText,notes:nullableText}),false,async i=>{const c=i.taskCode??code('task');const [o]=await pool.query(`INSERT INTO user_tasks (owner_key,task_code,project_id,category,title,description,status,priority,due_at,tags_json,source_type,source_reference,notes,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,NOW(),NOW())`,[OWNER,c,i.projectId??null,i.category??null,i.title,i.description??null,i.status,i.priority,i.dueAt??null,encodeJson(i.tags),i.sourceType,i.sourceReference??null,i.notes??null]);return one(pool,'SELECT * FROM user_tasks WHERE id=? AND owner_key=?',[o.insertId,OWNER])});
  const taskFields=new Set(['project_id','category','title','description','status','priority','due_at','started_at','completed_at','archived_at','tags_json','source_type','source_reference','notes']);
  register(server,'update_user_task','個人タスク更新','既存の個人タスクを更新します。',z.object({id:z.number().int().positive(),project_id:nullableId,category:nullableText,title:z.string().optional(),description:nullableText,status:z.enum(['pending','in_progress','blocked','completed','cancelled']).optional(),priority:z.enum(['low','medium','high','urgent']).optional(),due_at:nullableDateTime,started_at:nullableDateTime,completed_at:nullableDateTime,archived_at:nullableDateTime,tags_json:jsonArray,source_type:z.string().optional(),source_reference:nullableText,notes:nullableText}),false,i=>updateById(pool,'user_tasks',i.id,taskFields,i,new Set(['tags_json'])));
  register(server,'complete_user_task','個人タスク完了','個人タスクを完了状態にして完了日時を記録します。',z.object({id:z.number().int().positive(),notes:nullableText}),false,async({id,notes})=>{const [o]=await pool.query(`UPDATE user_tasks SET status='completed',completed_at=NOW(),notes=COALESCE(?,notes),updated_at=NOW() WHERE id=? AND owner_key=?`,[notes??null,id,OWNER]);if(!o.affectedRows)throw new Error('対象タスクが見つかりません');return one(pool,'SELECT * FROM user_tasks WHERE id=? AND owner_key=?',[id,OWNER])});

  register(server,'list_goals','目標一覧','久原央士の目標と進捗を取得します。',z.object({status:z.string().optional(),category:z.string().optional(),limit:z.number().int().min(1).max(100).default(50)}),true,async i=>{let s='SELECT * FROM user_goals WHERE owner_key=? AND archived_at IS NULL';const v:any[]=[OWNER];if(i.status){s+=' AND status=?';v.push(i.status)}if(i.category){s+=' AND category=?';v.push(i.category)}s+=` ORDER BY FIELD(priority,'urgent','high','medium','low'),target_date IS NULL,target_date LIMIT ?`;v.push(i.limit);return(await pool.query(s,v))[0]});
  register(server,'save_goal','目標保存','新しい目標、数値目標、成功条件を保存します。',z.object({goalCode:z.string().max(100).optional(),projectId:nullableId,category:nullableText,title:z.string().min(1),description:nullableText,status:z.enum(['active','paused','completed','cancelled']).default('active'),priority:z.enum(['low','medium','high','urgent']).default('medium'),targetValue:z.number().nullable().optional(),targetUnit:nullableText,currentValue:z.number().nullable().optional(),progressPercent:z.number().int().min(0).max(100).default(0),startDate:nullableText,targetDate:nullableText,successCriteria:jsonArray,tags:jsonArray}),false,async i=>{const c=i.goalCode??code('goal');const[o]=await pool.query(`INSERT INTO user_goals (owner_key,goal_code,project_id,category,title,description,status,priority,target_value,target_unit,current_value,progress_percent,start_date,target_date,success_criteria_json,tags_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NOW(),NOW())`,[OWNER,c,i.projectId??null,i.category??null,i.title,i.description??null,i.status,i.priority,i.targetValue??null,i.targetUnit??null,i.currentValue??null,i.progressPercent,i.startDate??null,i.targetDate??null,encodeJson(i.successCriteria),encodeJson(i.tags)]);return one(pool,'SELECT * FROM user_goals WHERE id=? AND owner_key=?',[o.insertId,OWNER])});
  const goalFields=new Set(['project_id','category','title','description','status','priority','target_value','target_unit','current_value','progress_percent','start_date','target_date','completed_at','archived_at','success_criteria_json','tags_json']);
  register(server,'update_goal','目標更新','目標の内容、進捗、期限、状態を更新します。',z.object({id:z.number().int().positive(),project_id:nullableId,category:nullableText,title:z.string().optional(),description:nullableText,status:z.enum(['active','paused','completed','cancelled']).optional(),priority:z.enum(['low','medium','high','urgent']).optional(),target_value:z.number().nullable().optional(),target_unit:nullableText,current_value:z.number().nullable().optional(),progress_percent:z.number().int().min(0).max(100).optional(),start_date:nullableText,target_date:nullableText,completed_at:nullableDateTime,archived_at:nullableDateTime,success_criteria_json:jsonArray,tags_json:jsonArray}),false,i=>updateById(pool,'user_goals',i.id,goalFields,i,new Set(['success_criteria_json','tags_json'])));

  register(server,'get_project_context','プロジェクト文脈取得','指定project_idに紐づく記憶、タスク、目標、人物との接触履歴、会話要約を取得します。',z.object({projectId:z.number().int().positive(),limit:z.number().int().min(1).max(100).default(30)}),true,async({projectId,limit})=>{const tables=['knowledge_memories','user_tasks','user_goals','person_interactions','conversation_summaries'];const all=await Promise.all(tables.map(t=>pool.query(`SELECT * FROM \`${t}\` WHERE owner_key=? AND project_id=? ORDER BY updated_at DESC LIMIT ?`,[OWNER,projectId,limit])));return Object.fromEntries(tables.map((t,n)=>[t,all[n][0]]))});
  register(server,'save_conversation_summary','会話要約保存','スレッドの要約、決定事項、アクション、未解決事項を保存または同じconversation_keyで更新します。',z.object({conversationKey:z.string().min(1).max(191),projectId:nullableId,title:z.string().min(1),summary:z.string().min(1),topics:jsonArray,decisions:jsonArray,actionItems:jsonArray,unresolvedItems:jsonArray,status:z.enum(['active','archived']).default('active'),conversationStartedAt:nullableDateTime,conversationEndedAt:nullableDateTime}),false,async i=>{await pool.query(`INSERT INTO conversation_summaries (owner_key,conversation_key,project_id,title,summary,topics_json,decisions_json,action_items_json,unresolved_items_json,status,conversation_started_at,conversation_ended_at,last_synced_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,NOW(),NOW(),NOW()) ON DUPLICATE KEY UPDATE project_id=VALUES(project_id),title=VALUES(title),summary=VALUES(summary),topics_json=VALUES(topics_json),decisions_json=VALUES(decisions_json),action_items_json=VALUES(action_items_json),unresolved_items_json=VALUES(unresolved_items_json),status=VALUES(status),conversation_started_at=VALUES(conversation_started_at),conversation_ended_at=VALUES(conversation_ended_at),last_synced_at=NOW(),updated_at=NOW()`,[OWNER,i.conversationKey,i.projectId??null,i.title,i.summary,encodeJson(i.topics),encodeJson(i.decisions),encodeJson(i.actionItems),encodeJson(i.unresolvedItems),i.status,i.conversationStartedAt??null,i.conversationEndedAt??null]);return one(pool,'SELECT * FROM conversation_summaries WHERE owner_key=? AND conversation_key=?',[OWNER,i.conversationKey])});

  register(server,'search_people','人物検索','氏名、別名、会社、プロフィール、関係メモ、タグから人物を検索します。',z.object({query:z.string().min(1),limit:z.number().int().min(1).max(100).default(20)}),true,async({query,limit})=>{const q=`%${query}%`;return(await pool.query(`SELECT * FROM people WHERE owner_key=? AND status='active' AND (full_name LIKE ? OR display_name LIKE ? OR name_kana LIKE ? OR aliases_json LIKE ? OR company_name LIKE ? OR profile LIKE ? OR relationship_notes LIKE ? OR tags_json LIKE ?) ORDER BY importance DESC,last_contacted_on DESC LIMIT ?`,[OWNER,q,q,q,q,q,q,q,q,limit]))[0]});
  register(server,'get_person','人物詳細取得','人物の詳細と最近の接触履歴を取得します。',z.object({id:z.number().int().positive(),interactionLimit:z.number().int().min(1).max(100).default(20)}),true,async({id,interactionLimit})=>{const p=await one(pool,'SELECT * FROM people WHERE id=? AND owner_key=?',[id,OWNER]);if(!p)throw new Error('対象人物が見つかりません');const [x]=await pool.query('SELECT * FROM person_interactions WHERE person_id=? AND owner_key=? ORDER BY interacted_at DESC LIMIT ?',[id,OWNER,interactionLimit]);return{person:p,interactions:x}});
  register(server,'save_person','人物保存','人脈情報を新規保存します。',z.object({personCode:z.string().max(100).optional(),fullName:z.string().min(1),displayName:nullableText,nameKana:nullableText,aliases:jsonArray,companyName:nullableText,departmentName:nullableText,positionName:nullableText,relationshipType:nullableText,importance:z.number().int().min(1).max(5).default(3),relationshipStrength:z.number().int().min(1).max(5).default(3),email:nullableText,phone:nullableText,snsAccounts:jsonArray,location:nullableText,profile:nullableText,personalityNotes:nullableText,relationshipNotes:nullableText,interests:jsonArray,skills:jsonArray,tags:jsonArray,firstMetOn:nullableText,lastContactedOn:nullableText,nextContactOn:nullableText,sourceType:z.string().max(50).default('conversation'),sourceReference:nullableText}),false,async i=>{const c=i.personCode??code('person');const[o]=await pool.query(`INSERT INTO people (owner_key,person_code,full_name,display_name,name_kana,aliases_json,company_name,department_name,position_name,relationship_type,importance,relationship_strength,email,phone,sns_accounts_json,location,profile,personality_notes,relationship_notes,interests_json,skills_json,tags_json,status,first_met_on,last_contacted_on,next_contact_on,source_type,source_reference,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'active',?,?,?,?,?,NOW(),NOW())`,[OWNER,c,i.fullName,i.displayName??null,i.nameKana??null,encodeJson(i.aliases),i.companyName??null,i.departmentName??null,i.positionName??null,i.relationshipType??null,i.importance,i.relationshipStrength,i.email??null,i.phone??null,encodeJson(i.snsAccounts),i.location??null,i.profile??null,i.personalityNotes??null,i.relationshipNotes??null,encodeJson(i.interests),encodeJson(i.skills),encodeJson(i.tags),i.firstMetOn??null,i.lastContactedOn??null,i.nextContactOn??null,i.sourceType,i.sourceReference??null]);return one(pool,'SELECT * FROM people WHERE id=? AND owner_key=?',[o.insertId,OWNER])});
  const personFields=new Set(['full_name','display_name','name_kana','aliases_json','company_name','department_name','position_name','relationship_type','importance','relationship_strength','email','phone','sns_accounts_json','location','profile','personality_notes','relationship_notes','interests_json','skills_json','tags_json','status','first_met_on','last_contacted_on','next_contact_on','source_type','source_reference']);
  register(server,'update_person','人物更新','既存の人物情報を更新します。',z.object({id:z.number().int().positive(),full_name:z.string().optional(),display_name:nullableText,name_kana:nullableText,aliases_json:jsonArray,company_name:nullableText,department_name:nullableText,position_name:nullableText,relationship_type:nullableText,importance:z.number().int().min(1).max(5).optional(),relationship_strength:z.number().int().min(1).max(5).optional(),email:nullableText,phone:nullableText,sns_accounts_json:jsonArray,location:nullableText,profile:nullableText,personality_notes:nullableText,relationship_notes:nullableText,interests_json:jsonArray,skills_json:jsonArray,tags_json:jsonArray,status:z.enum(['active','archived']).optional(),first_met_on:nullableText,last_contacted_on:nullableText,next_contact_on:nullableText,source_type:z.string().optional(),source_reference:nullableText}),false,i=>updateById(pool,'people',i.id,personFields,i,new Set(['aliases_json','sns_accounts_json','interests_json','skills_json','tags_json'])));
  register(server,'save_person_interaction','人物接触履歴保存','いつ、どこで、誰と会い、何を話し、何を決めたかを保存します。',z.object({personId:z.number().int().positive(),projectId:nullableId,interactionType:z.string().max(50).default('meeting'),interactedAt:z.string().min(1),location:nullableText,title:nullableText,summary:z.string().min(1),conversationDetails:nullableText,topics:jsonArray,decisions:jsonArray,followUpItems:jsonArray,participants:jsonArray,impressionNotes:nullableText,importance:z.number().int().min(1).max(5).default(3),nextFollowUpAt:nullableDateTime,sourceType:z.string().max(50).default('conversation'),sourceReference:nullableText}),false,async i=>{const p=await one(pool,'SELECT id FROM people WHERE id=? AND owner_key=?',[i.personId,OWNER]);if(!p)throw new Error('対象人物が見つかりません');const[o]=await pool.query(`INSERT INTO person_interactions (owner_key,person_id,project_id,interaction_type,interacted_at,location,title,summary,conversation_details,topics_json,decisions_json,follow_up_items_json,participants_json,impression_notes,importance,next_follow_up_at,source_type,source_reference,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NOW(),NOW())`,[OWNER,i.personId,i.projectId??null,i.interactionType,i.interactedAt,i.location??null,i.title??null,i.summary,i.conversationDetails??null,encodeJson(i.topics),encodeJson(i.decisions),encodeJson(i.followUpItems),encodeJson(i.participants),i.impressionNotes??null,i.importance,i.nextFollowUpAt??null,i.sourceType,i.sourceReference??null]);await pool.query('UPDATE people SET first_met_on=COALESCE(first_met_on,DATE(?)),last_contacted_on=GREATEST(COALESCE(last_contacted_on,DATE(?)),DATE(?)),next_contact_on=COALESCE(DATE(?),next_contact_on),updated_at=NOW() WHERE id=? AND owner_key=?',[i.interactedAt,i.interactedAt,i.interactedAt,i.nextFollowUpAt??null,i.personId,OWNER]);return one(pool,'SELECT * FROM person_interactions WHERE id=? AND owner_key=?',[o.insertId,OWNER])});
  register(server,'list_person_interactions','人物接触履歴一覧','人物ごとの面談、電話、メッセージなどの履歴を取得します。',z.object({personId:z.number().int().positive().optional(),interactionType:z.string().optional(),from:nullableDateTime,to:nullableDateTime,limit:z.number().int().min(1).max(100).default(50)}),true,async i=>{let s=`SELECT pi.*,p.full_name,p.company_name FROM person_interactions pi JOIN people p ON p.id=pi.person_id AND p.owner_key=pi.owner_key WHERE pi.owner_key=?`;const v:any[]=[OWNER];if(i.personId){s+=' AND pi.person_id=?';v.push(i.personId)}if(i.interactionType){s+=' AND pi.interaction_type=?';v.push(i.interactionType)}if(i.from){s+=' AND pi.interacted_at>=?';v.push(i.from)}if(i.to){s+=' AND pi.interacted_at<=?';v.push(i.to)}s+=' ORDER BY pi.interacted_at DESC LIMIT ?';v.push(i.limit);return(await pool.query(s,v))[0]});

  register(server, 'resume_project', 'プロジェクト再開', '新しいスレッドや作業再開時に、指定プロジェクトの最新正本・確定ルール・完了済み・次の作業・禁止事項・失敗履歴・既存資産・関連IFを1回で取得します。開発着手前に使用してください。', z.object({
    projectKey: z.string().min(1).max(150),
    relatedLimit: z.number().int().min(1).max(30).default(10),
  }), true, async ({ projectKey, relatedLimit }) => {
    const memoryKey = `project_state:${projectKey}`;
    const stateMemory = await one(pool, `SELECT * FROM knowledge_memories
      WHERE owner_key=? AND memory_key=? AND category IN ('project_state','project.state') AND status='active' LIMIT 1`, [OWNER, memoryKey]);
    const projectId = stateMemory?.project_id ?? null;
    const [learning] = await pool.query(`SELECT id,memory_key,title,summary,content,tags_json,confidence,updated_at
      FROM knowledge_memories WHERE owner_key=? AND category='learning_feedback' AND status='active'
      AND (tags_json LIKE '%"global"%' OR tags_json LIKE ?)
      ORDER BY confidence DESC,updated_at DESC LIMIT ?`, [OWNER, `%"${projectKey}"%`, relatedLimit]);

    if (!stateMemory) {
      return {
        found: false,
        project_key: projectKey,
        instruction: '正本がまだありません。既存コード・DB・n8nを監査した後、checkpoint_projectで初回正本を作成してください。',
        learning_profile: learning,
      };
    }

    let canonicalState: unknown = stateMemory.content;
    try { canonicalState = JSON.parse(stateMemory.content); } catch {}
    const [memories, tasks, goals, conversations] = await Promise.all([
      pool.query(`SELECT id,category,title,summary,content,importance,updated_at FROM knowledge_memories
        WHERE owner_key=? AND status='active' AND memory_key<>? AND (? IS NULL OR project_id=? OR tags_json LIKE ?)
        ORDER BY importance DESC,updated_at DESC LIMIT ?`, [OWNER, memoryKey, projectId, projectId, `%"${projectKey}"%`, relatedLimit]),
      pool.query(`SELECT id,title,description,status,priority,due_at,notes,updated_at FROM user_tasks
        WHERE owner_key=? AND archived_at IS NULL AND (? IS NULL OR project_id=?)
        ORDER BY FIELD(status,'in_progress','blocked','pending','completed','cancelled'),updated_at DESC LIMIT ?`, [OWNER, projectId, projectId, relatedLimit]),
      pool.query(`SELECT id,title,description,status,priority,target_date,progress_percent,updated_at FROM user_goals
        WHERE owner_key=? AND archived_at IS NULL AND (? IS NULL OR project_id=?)
        ORDER BY updated_at DESC LIMIT ?`, [OWNER, projectId, projectId, relatedLimit]),
      pool.query(`SELECT id,title,summary,decisions_json,action_items_json,unresolved_items_json,updated_at FROM conversation_summaries
        WHERE owner_key=? AND status='active' AND (? IS NULL OR project_id=?)
        ORDER BY updated_at DESC LIMIT ?`, [OWNER, projectId, projectId, relatedLimit]),
    ]);

    await pool.query('UPDATE knowledge_memories SET last_accessed_at=NOW() WHERE id=?', [stateMemory.id]);
    return {
      found: true,
      project_key: projectKey,
      canonical_state: canonicalState,
      state_meta: { id: stateMemory.id, version: stateMemory.version, updated_at: stateMemory.updated_at },
      learning_profile: learning,
      related: { memories: memories[0], tasks: tasks[0], goals: goals[0], conversations: conversations[0] },
      mandatory_next_step: '正本とコード・DB・n8nの現物を照合し、未実装部分だけ作業してください。',
    };
  });

  register(server, 'checkpoint_project', 'プロジェクト・チェックポイント保存', '作業の節目または終了時にプロジェクト最新状態の正本を作成・更新します。更新前状態は自動的に履歴保存され、同じproject_keyへ集約されます。', z.object({
    projectKey: z.string().min(1).max(150),
    projectId: nullableId,
    title: z.string().min(1).max(255).optional(),
    objective: nullableText,
    status: z.enum(['active','paused','blocked','completed','cancelled']).optional(),
    currentPhase: nullableText,
    confirmedRules: jsonArray,
    completed: jsonArray,
    inProgress: jsonArray,
    nextActions: jsonArray,
    unresolved: jsonArray,
    doNotRepeat: jsonArray,
    failures: jsonArray,
    assets: jsonArray,
    verification: jsonArray,
    lastVerifiedAt: nullableDateTime,
    changeReason: z.string().min(5).max(500),
  }), false, async input => {
    const memoryKey = `project_state:${input.projectKey}`;
    const connection = await pool.getConnection();
    let checkpointStage = 'begin';
    try {
      await connection.beginTransaction();
      checkpointStage = 'select_existing';
      const [rows] = await connection.query('SELECT * FROM knowledge_memories WHERE owner_key=? AND memory_key=? FOR UPDATE', [OWNER, memoryKey]);
      const existing = rows[0] ?? null;
      let previous: any = {};
      if (existing) {
        try { previous = JSON.parse(existing.content); } catch { previous = {}; }
      }
      const pick = (incoming: unknown, key: string, fallback: unknown = null) => incoming === undefined ? (previous[key] ?? fallback) : incoming;
      const state = {
        project_key: input.projectKey,
        project_id: input.projectId === undefined ? (existing?.project_id ?? previous.project_id ?? null) : input.projectId,
        title: input.title ?? previous.title ?? input.projectKey,
        objective: pick(input.objective, 'objective'),
        status: input.status ?? previous.status ?? 'active',
        current_phase: pick(input.currentPhase, 'current_phase'),
        confirmed_rules: pick(input.confirmedRules, 'confirmed_rules', []),
        completed: pick(input.completed, 'completed', []),
        in_progress: pick(input.inProgress, 'in_progress', []),
        next_actions: pick(input.nextActions, 'next_actions', []),
        unresolved: pick(input.unresolved, 'unresolved', []),
        do_not_repeat: pick(input.doNotRepeat, 'do_not_repeat', []),
        failures: pick(input.failures, 'failures', []),
        assets: pick(input.assets, 'assets', []),
        verification: pick(input.verification, 'verification', []),
        last_verified_at: pick(input.lastVerifiedAt, 'last_verified_at'),
        updated_at: new Date().toISOString(),
      };

      if (existing) {
        checkpointStage = 'insert_version';
        await connection.query(`INSERT INTO knowledge_memory_versions SET
          knowledge_memory_id=?, version=?, title=?, summary=?, content=?, tags_json=?,
          category=?, importance=?, confidence=?, status=?, change_reason=?, changed_by=?,
          created_at=NOW(), updated_at=NOW()`, [
          existing.id, existing.version, existing.title, existing.summary, existing.content,
          typeof existing.tags_json === 'string' ? existing.tags_json : JSON.stringify(existing.tags_json),
          existing.category, existing.importance, existing.confidence, existing.status, input.changeReason, 'chatgpt',
        ]);
        checkpointStage = 'update_state';
        await connection.query(`UPDATE knowledge_memories SET category='project_state',project_id=?,title=?,summary=?,content=?,tags_json=?,
          importance=5,confidence=100,source_type='checkpoint',source_reference=?,version=version+1,
          last_accessed_at=NOW(),updated_at=NOW() WHERE id=? AND owner_key=?`, [
          state.project_id,state.title,`最新状態: ${state.current_phase ?? state.status}`,JSON.stringify(state),
          JSON.stringify(['project_state',input.projectKey]),input.changeReason,existing.id,OWNER,
        ]);
      } else {
        checkpointStage = 'insert_initial_state';
        const insertValues = [
          OWNER,
          memoryKey,
          'project_state',
          state.title,
          `最新状態: ${state.current_phase ?? state.status}`,
          JSON.stringify(state),
          JSON.stringify(['project_state', input.projectKey]),
          state.project_id,
          5,
          100,
          'checkpoint',
          input.changeReason,
          'active',
          1,
        ];
        await connection.query(`INSERT INTO knowledge_memories
          (owner_key,memory_key,category,title,summary,content,tags_json,project_id,importance,confidence,
           source_type,source_reference,status,version,last_accessed_at,created_at,updated_at)
          VALUES (${insertValues.map(() => '?').join(',')},NOW(),NOW(),NOW())`, insertValues);
      }
      checkpointStage = 'commit';
      await connection.commit();
      responseCache.clear();
      const saved = await one(pool, 'SELECT * FROM knowledge_memories WHERE owner_key=? AND memory_key=?', [OWNER, memoryKey]);
      return { project_key: input.projectKey, version: saved.version, canonical_state: state, memory_id: saved.id };
    } catch (error) {
      await connection.rollback();
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`checkpoint_project stage=${checkpointStage}: ${message}`);
    } finally {
      connection.release();
    }
  });

  register(server, 'record_learning_feedback', '確定フィードバック学習', '久原央士が明示的に確定した好み・禁止事項・修正指示、またはシステム検証済みルールだけを学習記録へ保存します。推測だけの内容は保存しません。', z.object({
    feedbackKey: z.string().min(1).max(150),
    scope: z.enum(['global','project']).default('global'),
    projectKey: z.string().max(150).nullable().optional(),
    category: z.string().min(1).max(50),
    signal: z.string().min(1),
    learnedRule: z.string().min(1),
    evidenceType: z.enum(['user_confirmed','system_verified']).default('user_confirmed'),
    confidence: z.number().min(0).max(100).default(100),
  }), false, async input => {
    if (input.scope === 'project' && !input.projectKey) throw new Error('project scopeではprojectKeyが必要です');
    const memoryKey = `learning:${input.feedbackKey}`;
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.query('SELECT * FROM knowledge_memories WHERE owner_key=? AND memory_key=? FOR UPDATE', [OWNER, memoryKey]);
      const existing = rows[0] ?? null;
      const payload = {
        scope: input.scope, project_key: input.projectKey ?? null, category: input.category,
        signal: input.signal, learned_rule: input.learnedRule, evidence_type: input.evidenceType,
        confidence: input.confidence, updated_at: new Date().toISOString(),
      };
      const tags = JSON.stringify(['learning_feedback', input.scope === 'global' ? 'global' : input.projectKey, input.category]);
      if (existing) {
        await connection.query(`INSERT INTO knowledge_memory_versions
          (knowledge_memory_id,version,title,summary,content,tags_json,category,importance,confidence,status,change_reason,changed_by,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,'確定フィードバック更新','chatgpt',NOW(),NOW())`, [
          existing.id,existing.version,existing.title,existing.summary,existing.content,existing.tags_json,
          existing.category,existing.importance,existing.confidence,existing.status,
        ]);
        await connection.query(`UPDATE knowledge_memories SET title=?,summary=?,content=?,tags_json=?,confidence=?,
          version=version+1,source_type=?,source_reference=?,status='active',updated_at=NOW()
          WHERE id=? AND owner_key=?`, [
          `学習: ${input.category}`,input.learnedRule,JSON.stringify(payload),tags,input.confidence,
          input.evidenceType,input.signal,existing.id,OWNER,
        ]);
      } else {
        await connection.query(`INSERT INTO knowledge_memories
          (owner_key,memory_key,category,title,summary,content,tags_json,project_id,importance,confidence,
           source_type,source_reference,status,version,created_at,updated_at)
          VALUES (?,?,'learning_feedback',?,?,?,?,NULL,5,?,?,?,'active',1,NOW(),NOW())`, [
          OWNER,memoryKey,`学習: ${input.category}`,input.learnedRule,JSON.stringify(payload),tags,
          input.confidence,input.evidenceType,input.signal,
        ]);
      }
      await connection.commit();
      responseCache.clear();
      return one(pool, 'SELECT * FROM knowledge_memories WHERE owner_key=? AND memory_key=?', [OWNER, memoryKey]);
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  });

}
