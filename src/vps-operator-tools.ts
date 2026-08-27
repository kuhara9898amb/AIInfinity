import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as z from 'zod/v4';

const execFileAsync = promisify(execFile);

const VPS_HOST = '210.131.214.99';
const VPS_USER = 'aioperator';
const VPS_KEY = '/Users/erka/.ssh/ai_shacho_operator';

type OperatorAction =
  | 'ping'
  | 'status'
  | 'security_status'
  | 'security_fix'
  | 'deploy_status'
  | 'deploy_run'
  | 'deploy_rollback'
  | 'mvp_setup';

function textResult(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

function errorResult(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true };
}

function timeoutFor(action: OperatorAction): number {
  if (action === 'deploy_run' || action === 'deploy_rollback') return 180000;
  if (action === 'security_fix' || action === 'mvp_setup') return 120000;
  return 20000;
}

async function runOperator(action: OperatorAction) {
  const { stdout, stderr } = await execFileAsync(
    'ssh',
    [
      '-i', VPS_KEY,
      '-o', 'IdentitiesOnly=yes',
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=10',
      `${VPS_USER}@${VPS_HOST}`,
      action,
    ],
    {
      timeout: timeoutFor(action),
      maxBuffer: 1024 * 1024,
    }
  );

  if (stderr.trim()) {
    // SSH may emit benign diagnostics. Do not expose them unless execution fails.
  }

  const trimmed = stdout.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    return { success: true, raw: trimmed };
  }
}

export function registerVpsOperatorTools(server: any) {
  server.registerTool('ai_shacho_operator_ping', {
    title: 'AI社長VPSオペレーター疎通確認',
    description: 'AI専用・最小権限SSH経路の疎通だけを確認します。任意コマンドは実行できません。',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => {
    try {
      return textResult(await runOperator('ping'));
    } catch (error) {
      return errorResult(error);
    }
  });

  server.registerTool('ai_shacho_status', {
    title: 'AI社長サイト総合状態確認',
    description: 'ai-shacho.netのWordPress、MySQL、nginx、HTTPS、セキュリティ、REST、MVP公開条件を既存の固定診断でまとめて確認します。',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => {
    try {
      const [status, security, deploy] = await Promise.all([
        runOperator('status'),
        runOperator('security_status'),
        runOperator('deploy_status'),
      ]);
      return textResult({ status, security, deploy });
    } catch (error) {
      return errorResult(error);
    }
  });

  server.registerTool('ai_shacho_security_status', {
    title: 'AI社長WordPressセキュリティ診断',
    description: 'ai-shacho.netのWordPress・nginx・SSH・ファイル権限・公開設定のセキュリティ状態を読み取り専用で診断します。任意コマンドは実行できません。',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => {
    try {
      return textResult(await runOperator('security_status'));
    } catch (error) {
      return errorResult(error);
    }
  });

  server.registerTool('ai_shacho_security_fix', {
    title: 'AI社長WordPressセキュリティFIX',
    description: 'ai-shacho.net専用のホワイトリスト化されたセキュリティ修正だけを実行します。任意コマンド・任意パス・任意引数は受け付けません。VPS側でバックアップ・検証・失敗時ロールバックを行います。',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async () => {
    try {
      return textResult(await runOperator('security_fix'));
    } catch (error) {
      return errorResult(error);
    }
  });

  server.registerTool('ai_shacho_deploy_status', {
    title: 'AI社長WordPressデプロイ状態確認',
    description: 'ai-shacho.netのWordPressコンテナ、テーマ配置、現在版、主要ページを読み取り専用で確認します。任意コマンドは実行できません。',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => {
    try {
      return textResult(await runOperator('deploy_status'));
    } catch (error) {
      return errorResult(error);
    }
  });

  server.registerTool('ai_shacho_deploy_run', {
    title: 'AI社長WordPress固定デプロイ',
    description: '固定済みPrivateリポジトリのmainブランチからai-shachoテーマだけをデプロイします。バックアップ、PHP構文確認、テーマ配置、HTTPS確認、失敗時自動ロールバックをVPS側の固定処理で行います。任意入力は受け付けません。',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async () => {
    try {
      return textResult(await runOperator('deploy_run'));
    } catch (error) {
      return errorResult(error);
    }
  });

  server.registerTool('ai_shacho_deploy_rollback', {
    title: 'AI社長WordPress直前版ロールバック',
    description: 'ai-shachoテーマをVPSに保存された直前の正常バックアップへ戻し、PHP構文とHTTPSを再検証します。対象・世代は固定で、任意入力は受け付けません。',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async () => {
    try {
      return textResult(await runOperator('deploy_rollback'));
    } catch (error) {
      return errorResult(error);
    }
  });

  server.registerTool('ai_shacho_mvp_setup', {
    title: 'AI社長WordPress MVP固定設定',
    description: 'トップ、記事一覧、このサイトについて、運営会社、無料相談、メニュー、表示設定、7カテゴリ、REST連携に必要な固定MVP設定だけを冪等に適用します。既存データは削除せず、実行前バックアップと検証を行います。',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async () => {
    try {
      return textResult(await runOperator('mvp_setup'));
    } catch (error) {
      return errorResult(error);
    }
  });
}
