// The MCP endpoint at /mcp: JSON-RPC 2.0 over Streamable HTTP. Speaks the
// 2026-07-28 revision through server/discover and the handshake revisions through
// initialize, and exposes the forge's six core tools on the same store as REST.

import { repoJson, issueJson, pullJson } from './rest.ts';

const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'coreforge', version: '1.0.0' };

// Built once, in a fixed key order: two tools/list answers are byte-for-byte equal.
const TOOLS = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and repository name (or by full_name "owner/repo").',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The full name in "owner/repo" form.' },
      },
      required: [],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
        labels: { type: 'array', items: { type: 'string' }, description: 'Label names to apply.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request into its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function toolResult(obj) {
  return {
    content: [{ type: 'text', text: JSON.stringify(obj) }],
    structuredContent: obj,
    isError: false,
  };
}

function toolError(message) {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

/** Resolve { owner, repo } from the call arguments, honouring full_name and synonyms. */
function resolveRepoArgs(forge, args) {
  let owner = args?.owner ?? args?.user ?? null;
  let repo = args?.repo ?? args?.repository ?? args?.name ?? null;
  const fullName = args?.full_name ?? args?.fullName ?? null;
  if ((!owner || !repo) && typeof fullName === 'string' && fullName.includes('/')) {
    const [ownerPart, ...rest] = fullName.split('/');
    owner = owner ?? ownerPart;
    repo = repo ?? rest.join('/');
  }
  if (owner) forge.bindLogin(owner);
  if (!repo) return null;
  return forge.getRepo(owner ?? forge.login ?? '', repo);
}

function callTool(forge, baseUrl, name, args) {
  switch (name) {
    case 'create_repo': {
      const repoName = args?.name ?? args?.repo;
      if (typeof repoName !== 'string' || repoName === '') return toolError('create_repo requires a name');
      if (forge.repoByName(repoName)) return toolError(`a repository named ${repoName} already exists`);
      const repo = forge.createRepo({
        name: repoName,
        description: typeof args?.description === 'string' ? args.description : '',
        isPrivate: args?.private === true,
      });
      return toolResult(repoJson(forge, baseUrl, repo));
    }
    case 'get_repo': {
      const repo = resolveRepoArgs(forge, args);
      if (!repo) return toolError('repository not found');
      return toolResult(repoJson(forge, baseUrl, repo));
    }
    case 'create_issue': {
      const repo = resolveRepoArgs(forge, args);
      if (!repo) return toolError('repository not found');
      if (typeof args?.title !== 'string' || args.title === '') return toolError('create_issue requires a title');
      const labelNames = Array.isArray(args?.labels)
        ? args.labels.map((label) => (typeof label === 'string' ? label : label?.name)).filter(Boolean)
        : [];
      for (const labelName of labelNames) {
        if (!repo.labels.has(labelName)) return toolError(`label '${labelName}' does not exist`);
      }
      const issue = forge.createIssue(repo, {
        title: args.title,
        body: typeof args?.body === 'string' ? args.body : '',
        labelNames,
      });
      return toolResult(issueJson(forge, baseUrl, repo, issue));
    }
    case 'list_issues': {
      const repo = resolveRepoArgs(forge, args);
      if (!repo) return toolError('repository not found');
      const state = typeof args?.state === 'string' ? args.state : 'open';
      let list = [...repo.issues.values()];
      if (state === 'open') list = list.filter((issue) => issue.state === 'open');
      else if (state === 'closed') list = list.filter((issue) => issue.state === 'closed');
      list.sort((a, b) => a.number - b.number);
      return toolResult(list.map((issue) => issueJson(forge, baseUrl, repo, issue)));
    }
    case 'create_pull_request': {
      const repo = resolveRepoArgs(forge, args);
      if (!repo) return toolError('repository not found');
      const cleanRef = (value) => (typeof value === 'string' ? (value.includes(':') ? value.split(':').pop() : value) : '');
      const headRef = cleanRef(args?.head ?? args?.head_branch);
      const baseRef = cleanRef(args?.base ?? args?.base_branch);
      if (typeof args?.title !== 'string' || args.title === '') return toolError('create_pull_request requires a title');
      if (!headRef || !repo.refs.has(`refs/heads/${headRef}`)) return toolError(`head branch ${headRef} does not exist`);
      if (!baseRef || !repo.refs.has(`refs/heads/${baseRef}`)) return toolError(`base branch ${baseRef} does not exist`);
      if (forge.findOpenPull(repo, headRef, baseRef)) return toolError('a pull request already exists for this head and base');
      const pull = forge.createPull(repo, {
        title: args.title,
        body: typeof args?.body === 'string' ? args.body : '',
        headRef,
        baseRef,
      });
      return toolResult(pullJson(forge, baseUrl, repo, pull));
    }
    case 'merge_pull_request': {
      const repo = resolveRepoArgs(forge, args);
      if (!repo) return toolError('repository not found');
      const number = Number(args?.pull_number ?? args?.pullNumber ?? args?.number);
      const pull = repo.pulls.get(number);
      if (!pull) return toolError(`pull request ${number} not found`);
      if (pull.merged || pull.state !== 'open') return toolError('pull request is not open');
      const result = forge.mergePull(repo, pull, 'squash');
      if (result.conflict || result.missing) return toolError('pull request is not mergeable');
      const json = pullJson(forge, baseUrl, repo, pull);
      json.sha = result.sha;
      return toolResult(json);
    }
    default:
      return null;
  }
}

/**
 * Handle one MCP request. `rawBody` is the unparsed request text (auth is checked by
 * the server before this runs). Returns { status, json } where json may be undefined
 * for an empty 202 reply.
 */
export function handleMcp(forge, ctx, method, rawBody) {
  const { baseUrl } = ctx;
  if (method === 'DELETE') return { status: 200, json: undefined };
  if (method === 'GET') return { status: 405, json: { jsonrpc: '2.0', id: null, error: { code: -32601, message: 'GET is not supported on this endpoint' } } };
  let parsed;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { status: 400, json: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  const handleOne = (request) => {
    const id = request?.id ?? null;
    const isNotification = request?.id === undefined || request?.id === null;
    const methodName = request?.method;
    const reply = (result) => ({ jsonrpc: '2.0', id, result });
    const replyError = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
    switch (methodName) {
      case 'server/discover':
        return reply({
          resultType: 'complete',
          supportedVersions: SUPPORTED_VERSIONS,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
        });
      case 'initialize': {
        const requested = request?.params?.protocolVersion;
        const protocolVersion = SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
        return reply({
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
        });
      }
      case 'ping':
        return reply({});
      case 'tools/list':
        return reply({ tools: TOOLS });
      case 'tools/call': {
        const toolName = request?.params?.name;
        const tool = TOOLS.find((candidate) => candidate.name === toolName);
        if (!tool) return replyError(-32602, `Unknown tool: ${toolName}`);
        const args = request?.params?.arguments ?? {};
        for (const required of tool.inputSchema.required ?? []) {
          if (args[required] === undefined || args[required] === null || args[required] === '') {
            return reply(toolError(`missing required argument: ${required}`));
          }
        }
        try {
          const result = callTool(forge, baseUrl, tool.name, args);
          if (!result) return replyError(-32602, `Unknown tool: ${toolName}`);
          return reply(result);
        } catch (err) {
          return reply(toolError(err instanceof Error ? err.message : String(err)));
        }
      }
      default:
        if (isNotification) return null;
        return replyError(-32601, `Method not found: ${methodName}`);
    }
  };
  if (Array.isArray(parsed)) {
    const responses = parsed.map(handleOne).filter(Boolean);
    return { status: 200, json: responses.length ? responses : undefined };
  }
  if (parsed && typeof parsed === 'object' && (parsed.id === undefined || parsed.id === null) && typeof parsed.method === 'string' && parsed.method.startsWith('notifications/')) {
    return { status: 202, json: undefined };
  }
  const response = handleOne(parsed ?? {});
  if (!response) return { status: 202, json: undefined };
  return { status: 200, json: response };
}
