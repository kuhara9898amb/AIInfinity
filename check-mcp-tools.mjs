import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const transport = new StdioClientTransport({
  command: '/Users/erka/AIInfinity/mysql-mcp-v4/run-mcp-v4.sh',
  args: [],
});

const client = new Client({
  name: 'ai-infinity-mcp-v4-tool-check',
  version: '1.0.0',
});

await client.connect(transport);

const result = await client.listTools();

console.log('TOOL COUNT:', result.tools.length);

for (const tool of result.tools) {
  console.log(tool.name);
}

await client.close();
