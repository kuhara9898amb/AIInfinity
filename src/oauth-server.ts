import crypto from 'node:crypto';

// A minimal, single-user OAuth 2.1 authorization server (RFC 6749/7591/7636/8414/8707)
// that exists only so claude.ai's "custom connector" UI (which requires OAuth and has no
// field for a static bearer token/header) can obtain the server's one real secret
// (MCP_HTTP_BEARER_TOKEN) through a normal-looking sign-in flow.
//
// Security model: dynamic client registration (/register) is intentionally open per spec,
// but it grants no access by itself. Issuing an authorization code (/authorize) and
// exchanging it for a token (/token) both require the caller to already know the correct
// `resource` URL, which must exactly equal this server's canonical resource URL
// (an unguessable path containing MCP_HTTP_BEARER_TOKEN). Without that knowledge, the
// open registration/authorize/token endpoints hand out nothing of value.

interface ClientRecord {
  clientId: string;
  redirectUris: string[];
}

interface AuthCodeRecord {
  clientId: string;
  redirectUri: string;
  resource: string;
  codeChallenge: string;
  expiresAt: number;
}

const CODE_TTL_MS = 5 * 60 * 1000;

const clients = new Map<string, ClientRecord>();
const authCodes = new Map<string, AuthCodeRecord>();

function pruneExpiredCodes() {
  const now = Date.now();
  for (const [code, record] of authCodes) {
    if (record.expiresAt < now) authCodes.delete(code);
  }
}

export function registerClient(body: unknown): { status: number; body: Record<string, unknown> } {
  const metadata = (body ?? {}) as Record<string, unknown>;
  const redirectUris = Array.isArray(metadata.redirect_uris)
    ? metadata.redirect_uris.filter((uri): uri is string => typeof uri === 'string' && uri.length > 0)
    : [];
  if (!redirectUris.length) {
    return { status: 400, body: { error: 'invalid_client_metadata', error_description: 'redirect_uris is required' } };
  }
  const clientId = crypto.randomBytes(16).toString('hex');
  clients.set(clientId, { clientId, redirectUris });
  return {
    status: 201,
    body: {
      client_id: clientId,
      redirect_uris: redirectUris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      ...(typeof metadata.client_name === 'string' ? { client_name: metadata.client_name } : {}),
    },
  };
}

export function authorize(params: URLSearchParams, expectedResource: string):
  | { redirectTo: string }
  | { error: string; description: string } {
  pruneExpiredCodes();
  const clientId = params.get('client_id') ?? '';
  const redirectUri = params.get('redirect_uri') ?? '';
  const responseType = params.get('response_type') ?? '';
  const codeChallenge = params.get('code_challenge') ?? '';
  const codeChallengeMethod = params.get('code_challenge_method') ?? '';
  const resource = params.get('resource') ?? '';
  const state = params.get('state') ?? '';

  const client = clients.get(clientId);
  if (!client) return { error: 'invalid_client', description: '不明なclient_idです' };
  if (!client.redirectUris.includes(redirectUri)) return { error: 'invalid_request', description: 'redirect_uriが登録内容と一致しません' };
  if (responseType !== 'code') return { error: 'unsupported_response_type', description: 'codeのみ対応しています' };
  if (codeChallengeMethod !== 'S256' || !codeChallenge) return { error: 'invalid_request', description: 'PKCE(S256)が必須です' };
  if (resource !== expectedResource) return { error: 'invalid_target', description: 'resourceパラメータが不正です' };

  const code = crypto.randomBytes(32).toString('base64url');
  authCodes.set(code, { clientId, redirectUri, resource, codeChallenge, expiresAt: Date.now() + CODE_TTL_MS });

  const redirectTo = new URL(redirectUri);
  redirectTo.searchParams.set('code', code);
  if (state) redirectTo.searchParams.set('state', state);
  return { redirectTo: redirectTo.toString() };
}

export function exchangeToken(
  form: URLSearchParams,
  expectedResource: string,
  staticAccessToken: string,
): { status: number; body: Record<string, unknown> } {
  const grantType = form.get('grant_type');

  if (grantType === 'authorization_code') {
    pruneExpiredCodes();
    const code = form.get('code') ?? '';
    const record = authCodes.get(code);
    if (!record) return { status: 400, body: { error: 'invalid_grant', error_description: 'codeが無効か期限切れです' } };
    authCodes.delete(code);

    if ((form.get('redirect_uri') ?? '') !== record.redirectUri) {
      return { status: 400, body: { error: 'invalid_grant', error_description: 'redirect_uriが一致しません' } };
    }
    if ((form.get('resource') ?? record.resource) !== expectedResource || record.resource !== expectedResource) {
      return { status: 400, body: { error: 'invalid_target', error_description: 'resourceが一致しません' } };
    }
    const verifier = form.get('code_verifier') ?? '';
    const computedChallenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    if (computedChallenge !== record.codeChallenge) {
      return { status: 400, body: { error: 'invalid_grant', error_description: 'PKCE検証に失敗しました' } };
    }
    return {
      status: 200,
      body: { access_token: staticAccessToken, token_type: 'Bearer', expires_in: 31536000, refresh_token: staticAccessToken },
    };
  }

  if (grantType === 'refresh_token') {
    if ((form.get('refresh_token') ?? '') !== staticAccessToken) {
      return { status: 400, body: { error: 'invalid_grant' } };
    }
    return {
      status: 200,
      body: { access_token: staticAccessToken, token_type: 'Bearer', expires_in: 31536000, refresh_token: staticAccessToken },
    };
  }

  return { status: 400, body: { error: 'unsupported_grant_type' } };
}
