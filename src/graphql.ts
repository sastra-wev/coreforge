// A small, tolerant GraphQL executor for the v4 surface at /api/graphql: a tokenizer
// and recursive-descent parser (operations, fragments, variables, input objects,
// enum literals), a schema shaped like GitHub's for the types the suite drives, and
// introspection for __type / __schema. Everything resolves against the same store
// the REST and git surfaces use, so objects keep one identity across surfaces.

import { globalId, parseGlobalId } from './store.ts';
import { tickIso } from './clock.ts';

// ---------------------------------------------------------------------------
// tokenizer

function tokenize(source) {
  const tokens = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (/\s|,/.test(ch)) {
      i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push({ kind: '...' });
      i += 3;
      continue;
    }
    if ('!$():=@[]{}|'.includes(ch)) {
      tokens.push({ kind: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        const value = end < 0 ? source.slice(i + 3) : source.slice(i + 3, end);
        tokens.push({ kind: 'String', value });
        i = end < 0 ? source.length : end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\') {
          const esc = source[j + 1];
          if (esc === 'u') {
            out += String.fromCharCode(parseInt(source.slice(j + 2, j + 6), 16));
            j += 6;
          } else {
            out += { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '/': '/', '\\': '\\', '"': '"' }[esc] ?? esc;
            j += 2;
          }
        } else {
          out += source[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'String', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      const match = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(source.slice(i));
      tokens.push({ kind: /[.eE]/.test(match[0]) ? 'Float' : 'Int', value: match[0] });
      i += match[0].length;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      const match = /^[_A-Za-z][_0-9A-Za-z]*/.exec(source.slice(i));
      tokens.push({ kind: 'Name', value: match[0] });
      i += match[0].length;
      continue;
    }
    throw new Error(`GraphQL: unexpected character ${JSON.stringify(ch)}`);
  }
  tokens.push({ kind: 'EOF' });
  return tokens;
}

// ---------------------------------------------------------------------------
// parser

class Parser {
  constructor(tokens) {
    this.tokens = tokens;
    this.pos = 0;
  }

  peek() {
    return this.tokens[this.pos];
  }

  next() {
    const token = this.tokens[this.pos];
    this.pos += 1;
    return token;
  }

  expect(kind) {
    const token = this.next();
    if (token.kind !== kind) throw new Error(`GraphQL: expected ${kind}, found ${token.kind}`);
    return token;
  }

  skip(kind) {
    if (this.peek().kind === kind) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  parseDocument() {
    const definitions = [];
    while (this.peek().kind !== 'EOF') definitions.push(this.parseDefinition());
    return definitions;
  }

  parseDefinition() {
    const token = this.peek();
    if (token.kind === '{') {
      return { kind: 'Operation', operation: 'query', name: null, varDefs: [], selectionSet: this.parseSelectionSet() };
    }
    if (token.kind === 'Name' && ['query', 'mutation', 'subscription'].includes(token.value)) {
      this.next();
      let name = null;
      if (this.peek().kind === 'Name') name = this.next().value;
      const varDefs = this.peek().kind === '(' ? this.parseVarDefs() : [];
      this.parseDirectives();
      return { kind: 'Operation', operation: token.value, name, varDefs, selectionSet: this.parseSelectionSet() };
    }
    if (token.kind === 'Name' && token.value === 'fragment') {
      this.next();
      const name = this.expect('Name').value;
      this.expect('Name'); // "on"
      const typeCondition = this.expect('Name').value;
      this.parseDirectives();
      return { kind: 'Fragment', name, typeCondition, selectionSet: this.parseSelectionSet() };
    }
    throw new Error('GraphQL: unsupported definition');
  }

  parseVarDefs() {
    this.expect('(');
    const defs = [];
    while (this.peek().kind !== ')') {
      this.expect('$');
      const name = this.expect('Name').value;
      this.expect(':');
      this.parseTypeRef();
      let defaultValue;
      if (this.skip('=')) defaultValue = this.parseValue();
      this.parseDirectives();
      defs.push({ name, defaultValue });
    }
    this.expect(')');
    return defs;
  }

  parseTypeRef() {
    if (this.skip('[')) {
      this.parseTypeRef();
      this.expect(']');
    } else {
      this.expect('Name');
    }
    this.skip('!');
  }

  parseDirectives() {
    while (this.peek().kind === '@') {
      this.next();
      this.expect('Name');
      if (this.peek().kind === '(') this.parseArguments();
    }
  }

  parseSelectionSet() {
    this.expect('{');
    const selections = [];
    while (this.peek().kind !== '}') selections.push(this.parseSelection());
    this.expect('}');
    return selections;
  }

  parseSelection() {
    if (this.peek().kind === '...') {
      this.next();
      if (this.peek().kind === 'Name' && this.peek().value === 'on') {
        this.next();
        const typeCondition = this.expect('Name').value;
        this.parseDirectives();
        return { kind: 'InlineFragment', typeCondition, selectionSet: this.parseSelectionSet() };
      }
      const name = this.expect('Name').value;
      this.parseDirectives();
      return { kind: 'FragmentSpread', name };
    }
    let name = this.expect('Name').value;
    let alias = null;
    if (this.skip(':')) {
      alias = name;
      name = this.expect('Name').value;
    }
    const args = this.peek().kind === '(' ? this.parseArguments() : {};
    this.parseDirectives();
    const selectionSet = this.peek().kind === '{' ? this.parseSelectionSet() : null;
    return { kind: 'Field', name, alias, args, selectionSet };
  }

  parseArguments() {
    this.expect('(');
    const args = {};
    while (this.peek().kind !== ')') {
      const name = this.expect('Name').value;
      this.expect(':');
      args[name] = this.parseValue();
    }
    this.expect(')');
    return args;
  }

  parseValue() {
    const token = this.peek();
    if (token.kind === '$') {
      this.next();
      return { $var: this.expect('Name').value };
    }
    if (token.kind === 'Int') {
      this.next();
      return parseInt(token.value, 10);
    }
    if (token.kind === 'Float') {
      this.next();
      return parseFloat(token.value);
    }
    if (token.kind === 'String') {
      this.next();
      return token.value;
    }
    if (token.kind === 'Name') {
      this.next();
      if (token.value === 'true') return true;
      if (token.value === 'false') return false;
      if (token.value === 'null') return null;
      return { $enum: token.value };
    }
    if (token.kind === '[') {
      this.next();
      const list = [];
      while (this.peek().kind !== ']') list.push(this.parseValue());
      this.expect(']');
      return list;
    }
    if (token.kind === '{') {
      this.next();
      const obj = {};
      while (this.peek().kind !== '}') {
        const name = this.expect('Name').value;
        this.expect(':');
        obj[name] = this.parseValue();
      }
      this.expect('}');
      return obj;
    }
    throw new Error(`GraphQL: unexpected value token ${token.kind}`);
  }
}

function resolveValue(value, variables) {
  if (value && typeof value === 'object') {
    if ('$var' in value) return variables[value.$var];
    if ('$enum' in value) return value.$enum;
    if (Array.isArray(value)) return value.map((item) => resolveValue(item, variables));
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = resolveValue(item, variables);
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// type references and the schema

const T = (name, kind = 'OBJECT') => ({ kind, name, ofType: null });
const NN = (ofType) => ({ kind: 'NON_NULL', name: null, ofType });
const L = (ofType) => ({ kind: 'LIST', name: null, ofType });
const ID = T('ID', 'SCALAR');
const STR = T('String', 'SCALAR');
const INT = T('Int', 'SCALAR');
const BOOL = T('Boolean', 'SCALAR');
const DATETIME = T('DateTime', 'SCALAR');
const URI = T('URI', 'SCALAR');

const ENUM_TYPES = {
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  PullRequestOrderField: ['CREATED_AT', 'UPDATED_AT'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  State: ['OPEN', 'CLOSED'],
  CommentAuthorAssociation: ['OWNER', 'MEMBER', 'COLLABORATOR', 'CONTRIBUTOR', 'NONE'],
  StatusState: ['EXPECTED', 'ERROR', 'FAILURE', 'PENDING', 'SUCCESS'],
};

// Interfaces a concrete type answers to, for fragment type conditions.
const IMPLEMENTS = {
  Node: ['Repository', 'Issue', 'PullRequest', 'User', 'IssueComment', 'Commit', 'Label', 'Ref'],
  RepositoryOwner: ['User'],
  Actor: ['User'],
  SearchResultItem: ['Issue', 'Repository', 'User', 'PullRequest', 'Discussion'],
  Closable: ['Issue', 'PullRequest'],
  Comment: ['IssueComment'],
  Labelable: ['Issue', 'PullRequest'],
  Reactable: ['Issue', 'PullRequest', 'IssueComment'],
  UniformResourceLocatable: ['Repository', 'Issue', 'PullRequest', 'User'],
};

function typeMatches(actualType, condition) {
  if (!condition) return true;
  if (actualType === condition) return true;
  const implementors = IMPLEMENTS[condition];
  return Array.isArray(implementors) && implementors.includes(actualType);
}

// ---------------------------------------------------------------------------
// wrappers around store objects

function wrapUser(ctx) {
  return { __type: 'User', login: ctx.forge.login ?? '' };
}

function wrapRepo(ctx, repo) {
  return { __type: 'Repository', repo };
}

function wrapIssue(ctx, repo, issue) {
  return { __type: 'Issue', repo, issue };
}

function wrapPull(ctx, repo, pull) {
  return { __type: 'PullRequest', repo, pull };
}

function wrapComment(ctx, repo, targetNumber, comment) {
  return { __type: 'IssueComment', repo, targetNumber, comment };
}

function cursorFor(index) {
  return Buffer.from(`arrayconnection:${index}`, 'utf8').toString('base64');
}

function decodeCursor(cursor) {
  try {
    const text = Buffer.from(String(cursor), 'base64').toString('utf8');
    const match = /(\d+)$/.exec(text);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

/** Slice a full ordered list into a connection wrapper honouring first/after/last/before. */
function makeConnection(ctx, typeName, edgeTypeName, fullList, args) {
  let start = 0;
  let end = fullList.length;
  if (args?.after != null) {
    const index = decodeCursor(args.after);
    if (index != null) start = Math.min(index + 1, fullList.length);
  }
  if (args?.before != null) {
    const index = decodeCursor(args.before);
    if (index != null) end = Math.min(index, fullList.length);
  }
  if (args?.first != null) end = Math.min(end, start + Math.max(0, args.first));
  if (args?.last != null) start = Math.max(start, end - Math.max(0, args.last));
  const items = fullList.slice(start, end);
  return {
    __type: typeName,
    __edgeType: edgeTypeName,
    items,
    startIndex: start,
    totalCount: fullList.length,
    hasNextPage: end < fullList.length,
    hasPreviousPage: start > 0,
  };
}

function sortedIssues(repo, args) {
  let list = [...repo.issues.values()];
  const states = args?.states;
  if (Array.isArray(states) && states.length) {
    const wanted = states.map((state) => String(state).toUpperCase());
    list = list.filter((issue) => wanted.includes(issue.state.toUpperCase()));
  }
  const direction = args?.orderBy?.direction ?? 'ASC';
  list.sort((a, b) => (direction === 'DESC' ? b.number - a.number : a.number - b.number));
  return list;
}

function sortedPulls(repo, args) {
  let list = [...repo.pulls.values()];
  const states = args?.states;
  if (Array.isArray(states) && states.length) {
    const wanted = states.map((state) => String(state).toUpperCase());
    list = list.filter((pull) => wanted.includes(pull.merged ? 'MERGED' : pull.state.toUpperCase()));
  }
  const direction = args?.orderBy?.direction ?? 'ASC';
  list.sort((a, b) => (direction === 'DESC' ? b.number - a.number : a.number - b.number));
  return list;
}

function pullGraphQLState(pull) {
  return pull.merged ? 'MERGED' : pull.state.toUpperCase();
}

// ---------------------------------------------------------------------------
// the schema: field resolvers per type. A field is [typeRef, resolver?]; without a
// resolver the executor reads the property of the same name off the wrapper.

const TYPES = {
  Query: {
    fields: {
      viewer: [T('User'), (source, args, ctx) => wrapUser(ctx)],
      repository: [T('Repository'), (source, args, ctx) => {
        if (typeof args?.owner === 'string') ctx.forge.bindLogin(args.owner);
        const repo = ctx.forge.getRepo(args?.owner ?? '', args?.name ?? '');
        return repo ? wrapRepo(ctx, repo) : null;
      }],
      repositoryOwner: [T('User'), (source, args, ctx) => {
        if (args?.login && args.login === ctx.forge.login) return wrapUser(ctx);
        return null;
      }],
      node: [T('Node', 'INTERFACE'), (source, args, ctx) => nodeById(ctx, args?.id)],
      nodes: [NN(L(NN(T('Node', 'INTERFACE')))), (source, args, ctx) => (args?.ids ?? []).map((id) => nodeById(ctx, id))],
      search: [NN(T('SearchResultItemConnection')), (source, args, ctx) => {
        const type = args?.type ?? 'ISSUE';
        let items = [];
        if (type === 'REPOSITORY') {
          items = ctx.forge.allRepos().map((repo) => wrapRepo(ctx, repo));
        } else {
          const needle = typeof args?.query === 'string' ? args.query.toLowerCase() : '';
          for (const repo of ctx.forge.allRepos()) {
            for (const issue of repo.issues.values()) {
              if (needle && !issue.title.toLowerCase().includes(needle) && !repo.name.toLowerCase().includes(needle)) continue;
              items.push(wrapIssue(ctx, repo, issue));
            }
          }
          items.sort((a, b) => a.issue.number - b.issue.number || a.repo.id - b.repo.id);
        }
        const connection = makeConnection(ctx, 'SearchResultItemConnection', 'SearchResultItemEdge', items, args);
        connection.issueCount = items.filter((item) => item.__type === 'Issue').length;
        connection.repositoryCount = items.filter((item) => item.__type === 'Repository').length;
        return connection;
      }],
      rateLimit: [T('RateLimit'), (source, args, ctx) => ({
        __type: 'RateLimit',
        limit: 5000,
        cost: 1,
        remaining: 4999,
        used: 1,
        resetAt: tickIso(),
        nodeCount: 0,
      })],
      __type: [T('__Type'), (source, args) => typeWrapper(args?.name)],
      __schema: [T('__Schema'), () => schemaWrapper()],
    },
  },
  Mutation: {
    fields: {
      createIssue: [T('CreateIssuePayload'), (source, args, ctx) => {
        const input = args?.input ?? {};
        const repo = repoFromNodeId(ctx, input.repositoryId);
        if (!repo) throw new Error('Repository not found');
        const labelNames = [];
        if (Array.isArray(input.labelIds)) {
          for (const labelId of input.labelIds) {
            const parsed = parseGlobalId(labelId);
            for (const label of repo.labels.values()) {
              if (parsed && label.id === Number(parsed.dbId)) labelNames.push(label.name);
            }
          }
        }
        const issue = ctx.forge.createIssue(repo, {
          title: input.title ?? '',
          body: input.body ?? '',
          labelNames,
        });
        return { __type: 'CreateIssuePayload', issue: wrapIssue(ctx, repo, issue), clientMutationId: input.clientMutationId ?? null };
      }],
      closeIssue: [T('CloseIssuePayload'), (source, args, ctx) => {
        const input = args?.input ?? {};
        const found = findIssueByNodeId(ctx, input.issueId);
        if (!found) throw new Error('Issue not found');
        found.issue.state = 'closed';
        found.issue.closedAt = tickIso();
        found.issue.updatedAt = found.issue.closedAt;
        return { __type: 'CloseIssuePayload', issue: wrapIssue(ctx, found.repo, found.issue), clientMutationId: input.clientMutationId ?? null };
      }],
      reopenIssue: [T('ReopenIssuePayload'), (source, args, ctx) => {
        const input = args?.input ?? {};
        const found = findIssueByNodeId(ctx, input.issueId);
        if (!found) throw new Error('Issue not found');
        found.issue.state = 'open';
        found.issue.closedAt = null;
        found.issue.updatedAt = tickIso();
        return { __type: 'ReopenIssuePayload', issue: wrapIssue(ctx, found.repo, found.issue), clientMutationId: input.clientMutationId ?? null };
      }],
      createPullRequest: [T('CreatePullRequestPayload'), (source, args, ctx) => {
        const input = args?.input ?? {};
        const repo = repoFromNodeId(ctx, input.repositoryId);
        if (!repo) throw new Error('Repository not found');
        const headRef = input.headRefName ?? '';
        const baseRef = input.baseRefName ?? '';
        if (!repo.refs.has(`refs/heads/${headRef}`)) throw new Error(`Head branch ${headRef} does not exist`);
        if (!repo.refs.has(`refs/heads/${baseRef}`)) throw new Error(`Base branch ${baseRef} does not exist`);
        if (ctx.forge.findOpenPull(repo, headRef, baseRef)) {
          throw new Error(`A pull request already exists for ${headRef} -> ${baseRef}`);
        }
        const pull = ctx.forge.createPull(repo, {
          title: input.title ?? '',
          body: input.body ?? '',
          headRef,
          baseRef,
        });
        return { __type: 'CreatePullRequestPayload', pullRequest: wrapPull(ctx, repo, pull), clientMutationId: input.clientMutationId ?? null };
      }],
      mergePullRequest: [T('MergePullRequestPayload'), (source, args, ctx) => {
        const input = args?.input ?? {};
        const found = findPullByNodeId(ctx, input.pullRequestId);
        if (!found) throw new Error('Pull request not found');
        if (found.pull.merged) throw new Error('Pull request is already merged');
        const method = { SQUASH: 'squash', MERGE: 'merge', REBASE: 'squash' }[input.mergeMethod ?? 'SQUASH'] ?? 'squash';
        const result = ctx.forge.mergePull(found.repo, found.pull, method);
        if (result.conflict || result.missing) throw new Error('Pull request is not mergeable');
        return { __type: 'MergePullRequestPayload', pullRequest: wrapPull(ctx, found.repo, found.pull), clientMutationId: input.clientMutationId ?? null };
      }],
      addComment: [T('AddCommentPayload'), (source, args, ctx) => {
        const input = args?.input ?? {};
        const issueFound = findIssueByNodeId(ctx, input.subjectId);
        const pullFound = issueFound ? null : findPullByNodeId(ctx, input.subjectId);
        const found = issueFound ?? pullFound;
        if (!found) throw new Error('Subject not found');
        const target = issueFound ? found.issue : found.pull;
        const comment = ctx.forge.addComment(found.repo, target, input.body ?? '');
        const wrapped = wrapComment(ctx, found.repo, target.number, comment);
        return {
          __type: 'AddCommentPayload',
          commentEdge: { __type: 'IssueCommentEdge', node: wrapped, cursor: cursorFor(0) },
          subject: issueFound ? wrapIssue(ctx, found.repo, found.issue) : wrapPull(ctx, found.repo, found.pull),
          clientMutationId: input.clientMutationId ?? null,
        };
      }],
    },
  },
  User: {
    fields: {
      login: [NN(STR), (s) => s.login],
      id: [NN(ID), (s, args, ctx) => globalId('User', ctx.forge.userId)],
      databaseId: [INT, (s, args, ctx) => ctx.forge.userId],
      name: [STR, (s) => s.login],
      url: [NN(URI), (s, args, ctx) => `${ctx.baseUrl}/${s.login}`],
      resourcePath: [NN(URI), (s) => `/${s.login}`],
      avatarUrl: [NN(URI), () => ''],
      isViewer: [NN(BOOL), () => true],
    },
  },
  Repository: {
    fields: {
      id: [NN(ID), (s) => globalId('Repository', s.repo.id)],
      databaseId: [NN(INT), (s) => s.repo.id],
      name: [NN(STR), (s) => s.repo.name],
      nameWithOwner: [NN(STR), (s, args, ctx) => `${ctx.forge.login ?? ''}/${s.repo.name}`],
      owner: [NN(T('User')), (s, args, ctx) => wrapUser(ctx)],
      description: [STR, (s) => s.repo.description],
      isPrivate: [NN(BOOL), (s) => s.repo.private],
      viewerPermission: [T('RepositoryPermission', 'ENUM'), () => 'ADMIN'],
      hasIssuesEnabled: [NN(BOOL), () => true],
      hasWikiEnabled: [NN(BOOL), () => true],
      isFork: [NN(BOOL), () => false],
      isArchived: [NN(BOOL), () => false],
      url: [NN(URI), (s, args, ctx) => `${ctx.baseUrl}/${ctx.forge.login ?? ''}/${s.repo.name}`],
      resourcePath: [NN(URI), (s, args, ctx) => `/${ctx.forge.login ?? ''}/${s.repo.name}`],
      createdAt: [NN(DATETIME), (s) => s.repo.createdAt],
      updatedAt: [NN(DATETIME), (s) => s.repo.updatedAt],
      pushedAt: [DATETIME, (s) => s.repo.updatedAt],
      defaultBranchRef: [T('Ref'), (s, args, ctx) => {
        const tip = s.repo.refs.get(ctx.forge.headRef(s.repo)) ?? null;
        return { __type: 'Ref', name: s.repo.defaultBranch, repo: s.repo, targetSha: tip };
      }],
      ref: [T('Ref'), (s, args, ctx) => {
        const qualified = args?.qualifiedName ?? '';
        const sha = s.repo.refs.get(qualified);
        if (!sha) return null;
        return { __type: 'Ref', name: qualified.replace(/^refs\/(heads|tags)\//, ''), repo: s.repo, targetSha: sha };
      }],
      refs: [T('RefConnection'), (s, args, ctx) => {
        const prefix = args?.refPrefix ?? 'refs/';
        const items = [...s.repo.refs.entries()]
          .filter(([ref]) => ref.startsWith(prefix))
          .sort((a, b) => (a[0] < b[0] ? -1 : 1))
          .map(([ref, sha]) => ({ __type: 'Ref', name: ref.replace(/^refs\/(heads|tags)\//, ''), repo: s.repo, targetSha: sha }));
        return makeConnection(ctx, 'RefConnection', 'RefEdge', items, args);
      }],
      issue: [T('Issue'), (s, args, ctx) => {
        const issue = s.repo.issues.get(Number(args?.number));
        return issue ? wrapIssue(ctx, s.repo, issue) : null;
      }],
      issues: [NN(T('IssueConnection')), (s, args, ctx) => {
        const items = sortedIssues(s.repo, args).map((issue) => wrapIssue(ctx, s.repo, issue));
        return makeConnection(ctx, 'IssueConnection', 'IssueEdge', items, args);
      }],
      pullRequest: [T('PullRequest'), (s, args, ctx) => {
        const pull = s.repo.pulls.get(Number(args?.number));
        return pull ? wrapPull(ctx, s.repo, pull) : null;
      }],
      pullRequests: [NN(T('PullRequestConnection')), (s, args, ctx) => {
        const items = sortedPulls(s.repo, args).map((pull) => wrapPull(ctx, s.repo, pull));
        return makeConnection(ctx, 'PullRequestConnection', 'PullRequestEdge', items, args);
      }],
      object: [T('GitObject', 'INTERFACE'), (s, args, ctx) => {
        const sha = ctx.forge.resolveCommit(s.repo, args?.expression ?? '') ?? (/^[0-9a-f]{40}$/.test(args?.expression ?? '') ? args.expression : null);
        if (!sha) return null;
        const obj = ctx.forge.get(sha);
        if (!obj) return null;
        if (obj.type === 'commit') return { __type: 'Commit', repo: s.repo, sha };
        return null;
      }],
      stargazerCount: [NN(INT), () => 0],
      forkCount: [NN(INT), () => 0],
    },
  },
  Ref: {
    fields: {
      name: [NN(STR), (s) => s.name],
      prefix: [NN(STR), (s) => (s.name && s.repo ? '' : '')],
      target: [T('GitObject', 'INTERFACE'), (s, args, ctx) => (s.targetSha ? { __type: 'Commit', repo: s.repo, sha: ctx.forge.peelToCommit(s.targetSha) ?? s.targetSha } : null)],
      repository: [NN(T('Repository')), (s, args, ctx) => wrapRepo(ctx, s.repo)],
    },
  },
  Commit: {
    fields: {
      id: [NN(ID), (s) => globalId('Commit', s.sha)],
      oid: [NN(T('GitObjectID', 'SCALAR')), (s) => s.sha],
      message: [NN(STR), (s, args, ctx) => ctx.forge.get(s.sha)?.data ? parseCommitText(ctx, s.sha).message : ''],
      messageHeadline: [NN(STR), (s, args, ctx) => (parseCommitText(ctx, s.sha).message.split('\n')[0] ?? '')],
      author: [T('GitActor'), (s, args, ctx) => gitActor(ctx, s.sha, 'author')],
      committer: [T('GitActor'), (s, args, ctx) => gitActor(ctx, s.sha, 'committer')],
      tree: [NN(T('Tree')), (s, args, ctx) => ({ __type: 'Tree', repo: s.repo, sha: parseCommitText(ctx, s.sha).tree })],
      parents: [NN(T('CommitConnection')), (s, args, ctx) => {
        const items = parseCommitText(ctx, s.sha).parents.map((parent) => ({ __type: 'Commit', repo: s.repo, sha: parent }));
        return makeConnection(ctx, 'CommitConnection', 'CommitEdge', items, args);
      }],
      url: [NN(URI), (s, args, ctx) => `${ctx.baseUrl}/${ctx.forge.login ?? ''}/${s.repo.name}/commit/${s.sha}`],
      committedDate: [NN(DATETIME), (s, args, ctx) => gitActor(ctx, s.sha, 'committer')?.date ?? s.repo.createdAt],
      authoredDate: [NN(DATETIME), (s, args, ctx) => gitActor(ctx, s.sha, 'author')?.date ?? s.repo.createdAt],
    },
  },
  Tree: {
    fields: {
      id: [NN(ID), (s) => globalId('Tree', s.sha)],
      oid: [NN(T('GitObjectID', 'SCALAR')), (s) => s.sha],
      entries: [NN(L(NN(T('TreeEntry')))), (s, args, ctx) => {
        const obj = ctx.forge.get(s.sha);
        if (!obj) return [];
        return treeEntriesOf(ctx, obj.data).map((entry) => ({ __type: 'TreeEntry', repo: s.repo, ...entry }));
      }],
    },
  },
  TreeEntry: {
    fields: {
      name: [NN(STR), (s) => s.name],
      path: [NN(STR), (s) => s.name],
      mode: [NN(INT), (s) => parseInt(s.mode, 8) ? Number(s.mode) : 0],
      type: [NN(STR), (s) => s.entryType],
      oid: [NN(T('GitObjectID', 'SCALAR')), (s) => s.oid],
      object: [T('GitObject', 'INTERFACE'), (s, args, ctx) => {
        const obj = ctx.forge.get(s.oid);
        if (!obj) return null;
        if (obj.type === 'commit') return { __type: 'Commit', repo: s.repo, sha: s.oid };
        if (obj.type === 'tree') return { __type: 'Tree', repo: s.repo, sha: s.oid };
        if (obj.type === 'blob') return { __type: 'Blob', repo: s.repo, sha: s.oid };
        return null;
      }],
    },
  },
  Blob: {
    fields: {
      id: [NN(ID), (s) => globalId('Blob', s.sha)],
      oid: [NN(T('GitObjectID', 'SCALAR')), (s) => s.sha],
      byteSize: [NN(INT), (s, args, ctx) => ctx.forge.get(s.sha)?.data.length ?? 0],
      text: [STR, (s, args, ctx) => ctx.forge.get(s.sha)?.data.toString('utf8') ?? null],
      isBinary: [NN(BOOL), () => false],
    },
  },
  GitActor: {
    fields: {
      name: [STR, (s) => s.name],
      email: [STR, (s) => s.email],
      date: [DATETIME, (s) => s.date],
      user: [T('User'), () => null],
    },
  },
  Issue: {
    fields: {
      id: [NN(ID), (s) => globalId('Issue', s.issue.id)],
      databaseId: [INT, (s) => s.issue.id],
      number: [NN(INT), (s) => s.issue.number],
      title: [NN(STR), (s) => s.issue.title],
      body: [NN(STR), (s) => s.issue.body ?? ''],
      bodyText: [NN(STR), (s) => s.issue.body ?? ''],
      state: [NN(T('IssueState', 'ENUM')), (s) => s.issue.state.toUpperCase()],
      closed: [NN(BOOL), (s) => s.issue.state === 'closed'],
      closedAt: [DATETIME, (s) => s.issue.closedAt],
      createdAt: [NN(DATETIME), (s) => s.issue.createdAt],
      updatedAt: [NN(DATETIME), (s) => s.issue.updatedAt],
      url: [NN(URI), (s, args, ctx) => `${ctx.baseUrl}/${ctx.forge.login ?? ''}/${s.repo.name}/issues/${s.issue.number}`],
      resourcePath: [NN(URI), (s, args, ctx) => `/${ctx.forge.login ?? ''}/${s.repo.name}/issues/${s.issue.number}`],
      author: [T('User'), (s, args, ctx) => wrapUser(ctx)],
      repository: [NN(T('Repository')), (s, args, ctx) => wrapRepo(ctx, s.repo)],
      labels: [T('LabelConnection'), (s, args, ctx) => {
        const items = s.issue.labels.map((label) => ({ __type: 'Label', repo: s.repo, label }));
        return makeConnection(ctx, 'LabelConnection', 'LabelEdge', items, args);
      }],
      comments: [NN(T('IssueCommentConnection')), (s, args, ctx) => {
        const items = s.issue.comments.map((comment) => wrapComment(ctx, s.repo, s.issue.number, comment));
        return makeConnection(ctx, 'IssueCommentConnection', 'IssueCommentEdge', items, args);
      }],
      viewerCanClose: [NN(BOOL), () => true],
      viewerCanReopen: [NN(BOOL), () => true],
    },
  },
  PullRequest: {
    fields: {
      id: [NN(ID), (s) => globalId('PullRequest', s.pull.id)],
      databaseId: [INT, (s) => s.pull.id],
      number: [NN(INT), (s) => s.pull.number],
      title: [NN(STR), (s) => s.pull.title],
      body: [STR, (s) => s.pull.body ?? ''],
      bodyText: [NN(STR), (s) => s.pull.body ?? ''],
      state: [NN(T('PullRequestState', 'ENUM')), (s) => pullGraphQLState(s.pull)],
      merged: [NN(BOOL), (s) => s.pull.merged],
      mergedAt: [DATETIME, (s) => s.pull.mergedAt],
      mergeCommit: [T('Commit'), (s, args, ctx) => (s.pull.mergeCommitSha ? { __type: 'Commit', repo: s.repo, sha: s.pull.mergeCommitSha } : null)],
      headRefName: [NN(STR), (s) => s.pull.headRef],
      baseRefName: [NN(STR), (s) => s.pull.baseRef],
      headRefOid: [NN(T('GitObjectID', 'SCALAR')), (s, args, ctx) => ctx.forge ? (s.repo.refs.get(`refs/heads/${s.pull.headRef}`) ?? s.pull.headSha ?? '') : ''],
      baseRefOid: [NN(T('GitObjectID', 'SCALAR')), (s, args, ctx) => (s.repo.refs.get(`refs/heads/${s.pull.baseRef}`) ?? s.pull.baseSha ?? '')],
      headRef: [T('Ref'), (s, args, ctx) => {
        const sha = s.repo.refs.get(`refs/heads/${s.pull.headRef}`);
        return sha ? { __type: 'Ref', name: s.pull.headRef, repo: s.repo, targetSha: sha } : null;
      }],
      baseRef: [T('Ref'), (s, args, ctx) => {
        const sha = s.repo.refs.get(`refs/heads/${s.pull.baseRef}`);
        return sha ? { __type: 'Ref', name: s.pull.baseRef, repo: s.repo, targetSha: sha } : null;
      }],
      mergeable: [NN(T('MergeableState', 'ENUM')), (s, args, ctx) => {
        if (s.pull.merged) return 'MERGEABLE';
        const mergeable = ctx.forge.pullMergeable(s.repo, s.pull);
        return mergeable === null ? 'UNKNOWN' : mergeable ? 'MERGEABLE' : 'CONFLICTING';
      }],
      isDraft: [NN(BOOL), () => false],
      closed: [NN(BOOL), (s) => s.pull.state === 'closed'],
      closedAt: [DATETIME, (s) => s.pull.closedAt],
      createdAt: [NN(DATETIME), (s) => s.pull.createdAt],
      updatedAt: [NN(DATETIME), (s) => s.pull.updatedAt],
      url: [NN(URI), (s, args, ctx) => `${ctx.baseUrl}/${ctx.forge.login ?? ''}/${s.repo.name}/pull/${s.pull.number}`],
      resourcePath: [NN(URI), (s, args, ctx) => `/${ctx.forge.login ?? ''}/${s.repo.name}/pull/${s.pull.number}`],
      author: [T('User'), (s, args, ctx) => wrapUser(ctx)],
      repository: [NN(T('Repository')), (s, args, ctx) => wrapRepo(ctx, s.repo)],
      files: [T('PullRequestChangedFileConnection'), (s, args, ctx) => {
        const items = ctx.forge.pullFiles(s.repo, s.pull).map((file) => ({
          __type: 'PullRequestChangedFile',
          path: file.filename,
          additions: file.additions,
          deletions: file.deletions,
          changeType: file.status.toUpperCase(),
        }));
        return makeConnection(ctx, 'PullRequestChangedFileConnection', 'PullRequestChangedFileEdge', items, args);
      }],
      additions: [NN(INT), (s, args, ctx) => ctx.forge.pullFiles(s.repo, s.pull).reduce((sum, file) => sum + file.additions, 0)],
      deletions: [NN(INT), (s, args, ctx) => ctx.forge.pullFiles(s.repo, s.pull).reduce((sum, file) => sum + file.deletions, 0)],
      changedFiles: [NN(INT), (s, args, ctx) => ctx.forge.pullFiles(s.repo, s.pull).length],
      comments: [NN(T('IssueCommentConnection')), (s, args, ctx) => {
        const items = s.pull.comments.map((comment) => wrapComment(ctx, s.repo, s.pull.number, comment));
        return makeConnection(ctx, 'IssueCommentConnection', 'IssueCommentEdge', items, args);
      }],
      labels: [T('LabelConnection'), (s, args, ctx) => makeConnection(ctx, 'LabelConnection', 'LabelEdge', [], args)],
    },
  },
  IssueComment: {
    fields: {
      id: [NN(ID), (s) => globalId('IssueComment', s.comment.id)],
      databaseId: [INT, (s) => s.comment.id],
      body: [NN(STR), (s) => s.comment.body ?? ''],
      bodyText: [NN(STR), (s) => s.comment.body ?? ''],
      author: [T('User'), (s, args, ctx) => wrapUser(ctx)],
      createdAt: [NN(DATETIME), (s) => s.comment.createdAt],
      updatedAt: [NN(DATETIME), (s) => s.comment.updatedAt],
      url: [NN(URI), (s, args, ctx) => `${ctx.baseUrl}/${ctx.forge.login ?? ''}/${s.repo.name}/issues/${s.targetNumber}#issuecomment-${s.comment.id}`],
    },
  },
  Label: {
    fields: {
      id: [NN(ID), (s) => globalId('Label', s.label.id)],
      name: [NN(STR), (s) => s.label.name],
      color: [NN(STR), (s) => s.label.color],
      description: [STR, (s) => s.label.description],
    },
  },
  PullRequestChangedFile: {
    fields: {
      path: [NN(STR), (s) => s.path],
      additions: [NN(INT), (s) => s.additions],
      deletions: [NN(INT), (s) => s.deletions],
      changeType: [NN(T('PatchStatus', 'ENUM')), (s) => s.changeType],
    },
  },
  RateLimit: {
    fields: {
      limit: [NN(INT)],
      cost: [NN(INT)],
      remaining: [NN(INT)],
      used: [NN(INT)],
      resetAt: [NN(DATETIME)],
      nodeCount: [NN(INT)],
    },
  },
  PageInfo: {
    fields: {
      hasNextPage: [NN(BOOL)],
      hasPreviousPage: [NN(BOOL)],
      startCursor: [STR],
      endCursor: [STR],
    },
  },
  CreateIssuePayload: { fields: { issue: [T('Issue')], clientMutationId: [STR] } },
  CloseIssuePayload: { fields: { issue: [T('Issue')], clientMutationId: [STR] } },
  ReopenIssuePayload: { fields: { issue: [T('Issue')], clientMutationId: [STR] } },
  CreatePullRequestPayload: { fields: { pullRequest: [T('PullRequest')], clientMutationId: [STR] } },
  MergePullRequestPayload: { fields: { pullRequest: [T('PullRequest')], clientMutationId: [STR] } },
  AddCommentPayload: { fields: { commentEdge: [T('IssueCommentEdge')], subject: [T('Node', 'INTERFACE')], clientMutationId: [STR] } },
  __Schema: {
    fields: {
      description: [STR],
      types: [NN(L(NN(T('__Type'))))],
      queryType: [NN(T('__Type'))],
      mutationType: [T('__Type')],
      subscriptionType: [T('__Type')],
      directives: [NN(L(NN(T('__Directive'))))],
    },
  },
  __Type: {
    fields: {
      kind: [NN(T('__TypeKind', 'ENUM'))],
      name: [STR],
      description: [STR],
      fields: [L(NN(T('__Field')))],
      inputFields: [L(NN(T('__InputValue')))],
      interfaces: [NN(L(NN(T('__Type'))))],
      enumValues: [L(NN(T('__EnumValue')))],
      possibleTypes: [L(NN(T('__Type')))],
      ofType: [T('__Type')],
      specifiedByURL: [STR],
    },
  },
  __Field: {
    fields: {
      name: [NN(STR)],
      description: [STR],
      args: [NN(L(NN(T('__InputValue'))))],
      type: [NN(T('__Type'))],
      isDeprecated: [NN(BOOL)],
      deprecationReason: [STR],
    },
  },
  __EnumValue: {
    fields: {
      name: [NN(STR)],
      description: [STR],
      isDeprecated: [NN(BOOL)],
      deprecationReason: [STR],
    },
  },
  __InputValue: {
    fields: {
      name: [NN(STR)],
      description: [STR],
      type: [NN(T('__Type'))],
      defaultValue: [STR],
    },
  },
  __Directive: {
    fields: {
      name: [NN(STR)],
      description: [STR],
      locations: [NN(L(NN(T('__DirectiveLocation', 'ENUM'))))],
      args: [NN(L(NN(T('__InputValue'))))],
      isRepeatable: [NN(BOOL)],
    },
  },
};

// Connection and edge types share one shape; register them uniformly.
for (const base of ['Issue', 'PullRequest', 'IssueComment', 'Label', 'Ref', 'Commit', 'PullRequestChangedFile', 'SearchResultItem']) {
  TYPES[`${base}Connection`] = {
    fields: {
      nodes: [L(T(base === 'SearchResultItem' ? 'Node' : base, base === 'SearchResultItem' ? 'INTERFACE' : 'OBJECT')), (s) => s.items],
      edges: [L(T(`${base}Edge`)), (s) => s.items.map((item, index) => ({ __type: `${base}Edge`, node: item, cursor: cursorFor(s.startIndex + index) }))],
      pageInfo: [NN(T('PageInfo')), (s) => ({
        __type: 'PageInfo',
        hasNextPage: s.hasNextPage,
        hasPreviousPage: s.hasPreviousPage,
        startCursor: s.items.length ? cursorFor(s.startIndex) : null,
        endCursor: s.items.length ? cursorFor(s.startIndex + s.items.length - 1) : null,
      })],
      totalCount: [NN(INT), (s) => s.totalCount],
    },
  };
  TYPES[`${base}Edge`] = {
    fields: {
      node: [T(base === 'SearchResultItem' ? 'Node' : base, base === 'SearchResultItem' ? 'INTERFACE' : 'OBJECT')],
      cursor: [NN(STR)],
    },
  };
}
TYPES.SearchResultItemConnection.fields.issueCount = [NN(INT), (s) => s.issueCount ?? 0];
TYPES.SearchResultItemConnection.fields.repositoryCount = [NN(INT), (s) => s.repositoryCount ?? 0];

// ---------------------------------------------------------------------------
// store lookups by node id

function repoFromNodeId(ctx, id) {
  if (id == null) return null;
  const parsed = parseGlobalId(id);
  if (parsed && parsed.type === 'Repository') return ctx.forge.repoById(parsed.dbId);
  if (/^\d+$/.test(String(id))) return ctx.forge.repoById(id);
  return null;
}

function findIssueByNodeId(ctx, id) {
  const parsed = parseGlobalId(id ?? '');
  if (!parsed) return null;
  for (const repo of ctx.forge.allRepos()) {
    for (const issue of repo.issues.values()) {
      if (issue.id === Number(parsed.dbId)) return { repo, issue };
    }
  }
  return null;
}

function findPullByNodeId(ctx, id) {
  const parsed = parseGlobalId(id ?? '');
  if (!parsed) return null;
  for (const repo of ctx.forge.allRepos()) {
    for (const pull of repo.pulls.values()) {
      if (pull.id === Number(parsed.dbId)) return { repo, pull };
    }
  }
  return null;
}

function nodeById(ctx, id) {
  const parsed = parseGlobalId(id ?? '');
  if (!parsed) return null;
  if (parsed.type === 'Repository') {
    const repo = ctx.forge.repoById(parsed.dbId);
    return repo ? wrapRepo(ctx, repo) : null;
  }
  if (parsed.type === 'Issue') {
    const found = findIssueByNodeId(ctx, id);
    return found ? wrapIssue(ctx, found.repo, found.issue) : null;
  }
  if (parsed.type === 'PullRequest') {
    const found = findPullByNodeId(ctx, id);
    return found ? wrapPull(ctx, found.repo, found.pull) : null;
  }
  if (parsed.type === 'User') {
    return Number(parsed.dbId) === ctx.forge.userId ? wrapUser(ctx) : null;
  }
  if (parsed.type === 'IssueComment') {
    for (const repo of ctx.forge.allRepos()) {
      for (const target of [...repo.issues.values(), ...repo.pulls.values()]) {
        for (const comment of target.comments) {
          if (comment.id === Number(parsed.dbId)) return wrapComment(ctx, repo, target.number, comment);
        }
      }
    }
    return null;
  }
  return null;
}

// Commit helpers (the objects module owns parsing; keep a local, cached read).
import { parseCommit as parseCommitObject, parseIdent, parseTree, isTreeMode } from './objects.ts';
import { isoFromEpochSec } from './clock.ts';

function parseCommitText(ctx, sha) {
  const obj = ctx.forge.get(sha);
  if (!obj || obj.type !== 'commit') return { tree: null, parents: [], author: '', committer: '', message: '' };
  return parseCommitObject(obj.data);
}

function gitActor(ctx, sha, role) {
  const commit = parseCommitText(ctx, sha);
  const ident = parseIdent(role === 'author' ? commit.author : commit.committer);
  return {
    __type: 'GitActor',
    name: ident.name,
    email: ident.email,
    date: isoFromEpochSec(ident.epochSec),
  };
}

function treeEntriesOf(ctx, data) {
  return parseTree(data).map((entry) => ({
    name: entry.name,
    mode: entry.mode,
    oid: entry.oid,
    entryType: isTreeMode(entry.mode) ? 'tree' : 'blob',
  }));
}

// ---------------------------------------------------------------------------
// introspection wrappers

function typeWrapper(name) {
  if (!name) return null;
  if (ENUM_TYPES[name]) {
    return {
      __type: '__Type',
      kind: 'ENUM',
      name,
      description: null,
      fields: null,
      inputFields: null,
      interfaces: [],
      possibleTypes: null,
      enumValues: ENUM_TYPES[name].map((value) => ({
        __type: '__EnumValue',
        name: value,
        description: null,
        isDeprecated: false,
        deprecationReason: null,
      })),
      ofType: null,
      specifiedByURL: null,
    };
  }
  const typeDef = TYPES[name];
  if (typeDef) {
    return {
      __type: '__Type',
      kind: 'OBJECT',
      name,
      description: null,
      fields: Object.entries(typeDef.fields).map(([fieldName, [fieldType]]) => ({
        __type: '__Field',
        name: fieldName,
        description: null,
        args: [],
        type: fieldType,
        isDeprecated: false,
        deprecationReason: null,
      })),
      inputFields: null,
      interfaces: [],
      possibleTypes: null,
      enumValues: null,
      ofType: null,
      specifiedByURL: null,
    };
  }
  if (['ID', 'String', 'Int', 'Float', 'Boolean', 'DateTime', 'URI', 'GitObjectID', 'Base64String'].includes(name)) {
    return {
      __type: '__Type',
      kind: 'SCALAR',
      name,
      description: null,
      fields: null,
      inputFields: null,
      interfaces: [],
      possibleTypes: null,
      enumValues: null,
      ofType: null,
      specifiedByURL: null,
    };
  }
  if (name === 'Node' || name === 'GitObject' || name === 'SearchResultItem' || name === 'RepositoryOwner' || name === 'Actor') {
    return {
      __type: '__Type',
      kind: 'INTERFACE',
      name,
      description: null,
      fields: name === 'Node' ? [{ __type: '__Field', name: 'id', description: null, args: [], type: NN(ID), isDeprecated: false, deprecationReason: null }] : [],
      inputFields: null,
      interfaces: [],
      possibleTypes: null,
      enumValues: null,
      ofType: null,
      specifiedByURL: null,
    };
  }
  return null;
}

function schemaWrapper() {
  const names = new Set([...Object.keys(TYPES), ...Object.keys(ENUM_TYPES), 'ID', 'String', 'Int', 'Boolean', 'Float', 'DateTime', 'URI', 'GitObjectID']);
  return {
    __type: '__Schema',
    description: null,
    types: [...names].map((name) => typeWrapper(name)).filter(Boolean),
    queryType: typeWrapper('Query'),
    mutationType: typeWrapper('Mutation'),
    subscriptionType: null,
    directives: [],
  };
}

// ---------------------------------------------------------------------------
// executor

function namedTypeOf(typeRef) {
  let current = typeRef;
  while (current && (current.kind === 'NON_NULL' || current.kind === 'LIST')) current = current.ofType;
  return current?.name ?? null;
}

function completeValue(ctx, typeRef, value, selection, fragments, variables, errors) {
  if (!typeRef) return value ?? null;
  if (typeRef.kind === 'NON_NULL') return completeValue(ctx, typeRef.ofType, value, selection, fragments, variables, errors);
  if (value === null || value === undefined) return null;
  if (typeRef.kind === 'LIST') {
    const items = Array.isArray(value) ? value : [value];
    return items.map((item) => completeValue(ctx, typeRef.ofType, item, selection, fragments, variables, errors));
  }
  if (!selection.selectionSet) return value;
  const objectType = value.__type ?? typeRef.name;
  return executeSelectionSet(ctx, objectType, value, selection.selectionSet, fragments, variables, errors);
}

function executeSelectionSet(ctx, typeName, source, selections, fragments, variables, errors) {
  const out = {};
  const typeDef = TYPES[typeName];
  for (const selection of selections) {
    if (selection.kind === 'InlineFragment') {
      if (typeMatches(source?.__type ?? typeName, selection.typeCondition)) {
        Object.assign(out, executeSelectionSet(ctx, selection.typeCondition ?? typeName, source, selection.selectionSet, fragments, variables, errors));
      }
      continue;
    }
    if (selection.kind === 'FragmentSpread') {
      const fragment = fragments[selection.name];
      if (fragment && typeMatches(source?.__type ?? typeName, fragment.typeCondition)) {
        Object.assign(out, executeSelectionSet(ctx, fragment.typeCondition, source, fragment.selectionSet, fragments, variables, errors));
      }
      continue;
    }
    const key = selection.alias ?? selection.name;
    if (selection.name === '__typename') {
      out[key] = source?.__type ?? typeName;
      continue;
    }
    const fieldDef = typeDef?.fields?.[selection.name];
    if (!fieldDef) {
      errors.push({ message: `Field '${selection.name}' doesn't exist on type '${typeName}'` });
      out[key] = null;
      continue;
    }
    const [fieldType, resolver] = fieldDef;
    let value;
    try {
      const args = {};
      for (const [argName, argValue] of Object.entries(selection.args ?? {})) {
        args[argName] = resolveValue(argValue, variables);
      }
      value = resolver ? resolver(source, args, ctx) : source?.[selection.name];
    } catch (err) {
      errors.push({ message: err instanceof Error ? err.message : String(err) });
      out[key] = null;
      continue;
    }
    out[key] = completeValue(ctx, fieldType, value, selection, fragments, variables, errors);
  }
  return out;
}

function executeOne(ctx, body) {
  const errors = [];
  let definitions;
  try {
    definitions = new Parser(tokenize(String(body?.query ?? ''))).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  const fragments = {};
  const operations = [];
  for (const definition of definitions) {
    if (definition.kind === 'Fragment') fragments[definition.name] = definition;
    else operations.push(definition);
  }
  let variables = {};
  if (typeof body?.variables === 'string') {
    try {
      variables = JSON.parse(body.variables);
    } catch {
      variables = {};
    }
  } else if (body?.variables && typeof body.variables === 'object') {
    variables = body.variables;
  }
  const runOperation = (operation) => {
    const mergedVariables = { ...variables };
    for (const varDef of operation.varDefs ?? []) {
      if (mergedVariables[varDef.name] === undefined && varDef.defaultValue !== undefined) {
        mergedVariables[varDef.name] = resolveValue(varDef.defaultValue, mergedVariables);
      }
    }
    const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
    const opErrors = [];
    const data = executeSelectionSet(ctx, rootType, { __type: rootType }, operation.selectionSet, fragments, mergedVariables, opErrors);
    const result = { data };
    if (opErrors.length) result.errors = opErrors;
    return result;
  };
  if (body?.operationName) {
    const operation = operations.find((candidate) => candidate.name === body.operationName) ?? operations[0];
    if (!operation) return { data: null, errors: [{ message: 'No operation found' }] };
    return runOperation(operation);
  }
  if (operations.length === 1) return runOperation(operations[0]);
  if (operations.length === 0) return { data: null, errors: [{ message: 'No operation found' }] };
  return operations.map(runOperation);
}

/** Handle one GraphQL request body (single operation or a batched array). */
export function handleGraphQL(forge, ctx, body) {
  const fullCtx = { forge, baseUrl: ctx.baseUrl };
  if (Array.isArray(body)) {
    return { status: 200, json: body.map((item) => executeOne(fullCtx, item)) };
  }
  const result = executeOne(fullCtx, body ?? {});
  return { status: 200, json: result };
}
