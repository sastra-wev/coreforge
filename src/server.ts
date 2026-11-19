// The HTTP server: one process routing the four surfaces — git smart HTTP at
// /{owner}/{repo}.git, REST v3 under /api/v3, GraphQL at /api/graphql and MCP at
// /mcp — plus the unauthenticated /healthz probe the harness boots against.

import http from 'node:http';
import { Forge } from './store.ts';
import { advertise, uploadPack, receivePack } from './gitHttp.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

function sendJson(res, status, obj, extraHeaders = {}) {
  const body = obj === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(obj), 'utf8');
  const headers = { 'content-length': body.length, ...extraHeaders };
  if (obj !== undefined) headers['content-type'] = 'application/json; charset=utf-8';
  res.writeHead(status, headers);
  res.end(body);
}

function sendBuffer(res, status, contentType, body) {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function createApp() {
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const forge = new Forge(token);
  let requestCounter = 0;

  async function handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://internal');
    const pathname = url.pathname;
    const baseUrl = `http://${req.headers.host ?? 'localhost'}`;
    const rawBody = await readBody(req);

    if (pathname === '/healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }

    // Every other surface takes the trial's bearer token.
    if (token !== '' && req.headers.authorization !== `Bearer ${token}`) {
      sendJson(res, 401, { message: 'Bad credentials' }, { 'x-github-request-id': `coreforge-${++requestCounter}` });
      return;
    }

    if (pathname === '/api/graphql') {
      if (req.method !== 'POST') {
        sendJson(res, 405, { errors: [{ message: 'Method not allowed' }] });
        return;
      }
      let body;
      try {
        body = JSON.parse(rawBody.toString('utf8'));
      } catch {
        sendJson(res, 400, { errors: [{ message: 'Request body is not valid JSON' }] });
        return;
      }
      const result = handleGraphQL(forge, { baseUrl }, body);
      sendJson(res, result.status, result.json, { 'x-github-request-id': `coreforge-${++requestCounter}` });
      return;
    }

    if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
      const restPath = pathname.slice('/api/v3'.length);
      const segments = restPath.split('/').filter((segment) => segment.length > 0).map((segment) => {
        try {
          return decodeURIComponent(segment);
        } catch {
          return segment;
        }
      });
      let body;
      let bodyMalformed = false;
      if (rawBody.length > 0) {
        try {
          body = JSON.parse(rawBody.toString('utf8'));
        } catch {
          bodyMalformed = true;
        }
      }
      const result = handleRest(
        forge,
        { baseUrl, rawPath: pathname },
        req.method ?? 'GET',
        segments,
        url.searchParams,
        body,
        bodyMalformed,
      );
      const headers = {
        'x-github-request-id': `coreforge-${++requestCounter}`,
        'x-oauth-scopes': 'repo, read:org',
        ...(result.headers ?? {}),
      };
      if (result.status === 204) {
        res.writeHead(204, headers);
        res.end();
        return;
      }
      sendJson(res, result.status, result.json, headers);
      return;
    }

    if (pathname === '/mcp') {
      const result = handleMcp(forge, { baseUrl }, req.method ?? 'POST', rawBody.toString('utf8'));
      if (result.json === undefined) {
        res.writeHead(result.status, { 'content-length': 0 });
        res.end();
        return;
      }
      sendJson(res, result.status, result.json);
      return;
    }

    const gitMatch = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(pathname);
    if (gitMatch) {
      const owner = decodeURIComponent(gitMatch[1]);
      const repoName = decodeURIComponent(gitMatch[2]);
      const subPath = gitMatch[3] ?? '';
      forge.bindLogin(owner);
      const repo = forge.getRepo(owner, repoName);
      if (!repo) {
        sendBuffer(res, 404, 'text/plain', Buffer.from('repository not found\n'));
        return;
      }
      try {
        if (subPath === '/info/refs' && req.method === 'GET') {
          const service = url.searchParams.get('service');
          if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
            sendBuffer(res, 400, 'text/plain', Buffer.from('unknown service\n'));
            return;
          }
          const version2 = String(req.headers['git-protocol'] ?? '').includes('version=2');
          const result = advertise(forge, repo, service, version2);
          sendBuffer(res, result.status, result.contentType, result.body);
          return;
        }
        if (subPath === '/git-upload-pack' && req.method === 'POST') {
          const result = uploadPack(forge, repo, rawBody);
          sendBuffer(res, result.status, result.contentType, result.body);
          return;
        }
        if (subPath === '/git-receive-pack' && req.method === 'POST') {
          const result = receivePack(forge, repo, rawBody);
          sendBuffer(res, result.status, result.contentType, result.body);
          return;
        }
      } catch (err) {
        process.stderr.write(`[forge] git error: ${err instanceof Error ? err.message : String(err)}\n`);
        sendBuffer(res, 400, 'text/plain', Buffer.from('bad request\n'));
        return;
      }
      sendBuffer(res, 404, 'text/plain', Buffer.from('not found\n'));
      return;
    }

    sendJson(res, 404, { message: 'Not Found' }, { 'x-github-request-id': `coreforge-${++requestCounter}` });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      process.stderr.write(`[forge] request failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
      if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
      else res.end();
    });
  });
  server.keepAliveTimeout = 120_000;
  server.headersTimeout = 125_000;
  server.maxRequestsPerSocket = 0;
  return server;
}
