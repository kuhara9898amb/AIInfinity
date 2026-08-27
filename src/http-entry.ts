import http from 'node:http';
import crypto from 'node:crypto';
import type { OAuthMetadata } from '@modelcontextprotocol/server';
import { createMcpHandler, oauthMetadataResponse } from '@modelcontextprotocol/server';
import { toNodeHandler, toWebRequest } from '@modelcontextprotocol/node';
import { server } from './index.js';
import { registerClient, authorize, exchangeToken } from './oauth-server.js';

const PORT = Number(process.env.MCP_HTTP_PORT ?? 8790);
const TOKEN = process.env.MCP_HTTP_BEARER_TOKEN;
if (!TOKEN) throw new Error('MCP_HTTP_BEARER_TOKENが未設定です');
const tokenBuffer = Buffer.from(TOKEN, 'utf8');

function timingSafeTokenMatch(candidate: string): boolean {
  const candidateBuffer = Buffer.from(candidate, 'utf8');
  if (candidateBuffer.length !== tokenBuffer.length) return false;
  return crypto.timingSafeEqual(candidateBuffer, tokenBuffer);
}

function originOf(req: http.IncomingMessage): string {
  const proto = (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0]?.trim() || 'https';
  const host = req.headers.host ?? `127.0.0.1:${PORT}`;
  return `${proto}://${host}`;
}

function resourceUrlOf(req: http.IncomingMessage): string {
  return `${originOf(req)}/mcp/${TOKEN}`;
}

// claude.ai's custom-connector UI takes only a URL and no header/token field, so the
// resource path itself (`/mcp/<TOKEN>`) doubles as the shared secret. The Authorization
// header and `key` query param remain supported for the CLI / other manual integrations.
function isAuthorized(req: http.IncomingMessage): boolean {
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ') && timingSafeTokenMatch(header.slice('Bearer '.length))) return true;
  const url = new URL(req.url ?? '/', 'http://localhost');
  const key = url.searchParams.get('key');
  if (key && timingSafeTokenMatch(key)) return true;
  if (url.pathname === `/mcp/${TOKEN}`) return true;
  return false;
}

async function sendWebResponse(res: http.ServerResponse, response: Response): Promise<void> {
  res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
  if (response.body) {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      res.write(chunk);
    }
  }
  res.end();
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  return JSON.parse(raw);
}

async function readFormBody(req: http.IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

const mcpHandler = createMcpHandler(() => server);
const nodeHandler = toNodeHandler(mcpHandler);

const httpServer = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
      return;
    }

    if (url.pathname.startsWith('/.well-known/oauth-protected-resource') || url.pathname === '/.well-known/oauth-authorization-server') {
      const origin = originOf(req);
      const oauthMetadata: OAuthMetadata = {
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        registration_endpoint: `${origin}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
      };
      const webRequest = await toWebRequest(req);
      const response = oauthMetadataResponse(webRequest, {
        oauthMetadata,
        resourceServerUrl: new URL(resourceUrlOf(req)),
        resourceName: 'AI Infinity MCP v4',
      });
      if (response) {
        await sendWebResponse(res, response);
        return;
      }
    }

    if (url.pathname === '/register' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const result = registerClient(body);
      res.writeHead(result.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(result.body));
      return;
    }

    if (url.pathname === '/authorize' && req.method === 'GET') {
      const result = authorize(url.searchParams, resourceUrlOf(req));
      if ('redirectTo' in result) {
        res.writeHead(302, { location: result.redirectTo });
        res.end();
      } else {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: result.error, error_description: result.description }));
      }
      return;
    }

    if (url.pathname === '/token' && req.method === 'POST') {
      const form = await readFormBody(req);
      const result = exchangeToken(form, resourceUrlOf(req), TOKEN as string);
      res.writeHead(result.status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(result.body));
      return;
    }

    if (!isAuthorized(req)) {
      const resourceMetadataUrl = `${originOf(req)}/.well-known/oauth-protected-resource/mcp/${TOKEN}`;
      res.writeHead(401, {
        'content-type': 'application/json',
        'www-authenticate': `Bearer resource_metadata="${resourceMetadataUrl}"`,
      });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }

    await nodeHandler(req, res);
  } catch (error) {
    console.error('HTTP handler error:', error);
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'internal_error' }));
    }
  }
});

httpServer.listen(PORT, '127.0.0.1', () => {
  console.error(`AI Infinity MCP v4 HTTP server listening on 127.0.0.1:${PORT}`);
});
