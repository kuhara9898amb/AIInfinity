# CLAUDE.md

このリポジトリで作業する Claude は、以下を必ず守ること。

## 言語（最優先ルール）

- ユーザーへの返答・報告・質問は、**例外なくすべて日本語**で書く。
- 長い作業の後、会話の要約・再開の後、ツール結果が英語だった場合でも、日本語で書く。
- 英語で書いてしまったと気づいたら、その場で日本語で書き直す。
- コード・コマンド・ファイル名・エラーメッセージの原文など、英語のままの方が正確なものは英語のままでよい。ただし説明文は日本語で書く。
- 外部記憶（knowledge_memories）やタスク説明（user_tasks）に書く文章も、原則として日本語で書く。

## 時刻の扱い（最優先ルール）

### 1. ユーザーへの表示はすべて JST

- ユーザーに見せる時刻は、例外なく **JST（日本標準時、UTC+9）** で書く。
- 形式は `2026-09-23 10:07 JST` のように、末尾に `JST` を付ける。
- UTC を併記したい場合も JST を先に書く。例: `10:07 JST（01:07 UTC）`
- 「〇分後に確認します」と書く場合も、確認する時刻を JST で添える。

### 2. MySQL（AI Infinity MCP v4 の DB）のタイムゾーンは JST

2026-09-23 に実測で確認した事実:

| 項目 | 値 |
|---|---|
| `@@system_time_zone` | `JST` |
| `@@global.time_zone` / `@@session.time_zone` | `SYSTEM`（= JST） |
| `NOW()` | JST の現在時刻 |
| `UTC_TIMESTAMP()` | UTC の現在時刻 |

`TIMESTAMP` 型の列（`user_tasks`・`claude_development_runs`・`knowledge_memories` など）も、
`DATETIME` 型の列（`task_dispatcher_outbox`・`task192_monitor_ticks` など）も、読むときは JST で返る。

### 3. DB の時刻を読むときは `CAST(列 AS CHAR)` を使う

`mysql_query` ツールの結果に出る `2026-09-23T01:07:02.000Z` のような `Z` 付きの値は **UTC** である。
そのまま「01:07」と読むと 9 時間ずれる。

```sql
-- 正しい読み方: JST の時刻がそのまま文字列で返る
SELECT id, CAST(completed_at AS CHAR) AS completed_at_jst FROM user_tasks WHERE id = 313;
-- → 2026-09-23 10:07:02（JST）

-- 現在時刻の確認も同じ
SELECT CAST(NOW() AS CHAR) AS now_jst;
```

実測の対応例（同じ瞬間）:

| 読み方 | 表示 | 意味 |
|---|---|---|
| `CAST(completed_at AS CHAR)` | `2026-09-23 10:07:02` | JST（これを使う） |
| `completed_at`（そのまま） | `2026-09-23T01:07:02.000Z` | UTC（9 時間前に見える） |

### 4. DB へ時刻を書き込むときのルール

- **できる限り自分で時刻を書かない。** DB 側の `NOW()` を使うツール（例: `complete_user_task`）を優先する。
- どうしても書く場合（`update_user_task` の `started_at` / `completed_at` / `due_at` など）は、
  **JST の壁時計時刻を `YYYY-MM-DD HH:MM:SS` 形式で渡す**。
  - `update_user_task` は受け取った文字列を変換せずにそのまま MySQL へ渡す
    （`mysql-mcp-v4/src/external-memory-tools.ts` の `updateById`）。
  - MySQL は JST で解釈するので、UTC の時刻をタイムゾーンなしで渡すと **9 時間ずれて保存される**。
  - `Z` や `+00:00` 付きの ISO 文字列は渡さない（解釈が環境に依存するため）。
- **書き込んだら、必ず直後に読み戻して確認する。**

```sql
SELECT id, CAST(completed_at AS CHAR) AS completed_at_jst FROM user_tasks WHERE id = <更新したID>;
```

  読み戻した JST の時刻が意図と一致しなければ、その場でユーザーに報告して直す。

### 5. 時刻の変換早見表

| JST | UTC |
|---|---|
| 09:00 | 00:00（同日） |
| 00:00 | 前日 15:00 |
| `JST = UTC + 9 時間` | `UTC = JST − 9 時間` |

日付をまたぐ変換（JST 00:00〜08:59 は UTC では前日）に特に注意すること。

### 6. 例外なし

ログ・DB・コード・外部記憶（knowledge_memories）の値が UTC で書かれていても、
ユーザーへの報告では必ず JST に直してから書く。変換に自信がなければ、
`CAST(... AS CHAR)` で DB から JST を取り直してから書く。
