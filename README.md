# AI Infinity MCP v4

Restricted-write MCP server for MySQL, n8n 2.34.5, and the AI Infinity Laravel dashboard.

## Safety defaults

- No DELETE, DROP, TRUNCATE, arbitrary write SQL, workflow activation, credential API, or file deletion tools.
- MySQL writes are allowlisted by table and column and update one primary-key row at a time.
- n8n writes reject Execute Command, SSH, FTP, local file, and local file trigger nodes.
- Laravel writes stay inside allowlisted project directories and back up existing files.
- Every write is appended to the JSONL audit log.
- Published/publishing/active status changes are rejected by generic database tools.

## Install on the sub Mac

Replace the generated v4 directory files while preserving the existing `.env`, then run:

```bash
chmod 700 run-mcp-v4.sh
npm install
npm run check
./run-mcp-v4.sh
```

Do not stop or modify the v3 server during initial testing.
