// The forge's in-memory store: the content-addressed object database plus every
// repository's refs, labels, issues, pull requests and comments. One process, no
// persistence: /bot is read-only in the pod, and a trial starts from an empty store.

import {
  ZERO_OID,
  hashObject,
  parseCommit,
  serializeCommit,
  parseTree,
  serializeTree,
  isTreeMode,
  parseTag,
} from './objects.ts';
import { tickIso, tickEpochSec } from './clock.ts';

/** Derive a login from the bearer token when it carries one (a JWT's claims). */
export function deriveLoginFromToken(token) {
  if (!token) return null;
  const parts = String(token).split('.');
  if (parts.length === 3) {
    try {
      const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
      for (const key of ['login', 'username', 'preferred_username', 'user_name']) {
        if (typeof claims[key] === 'string' && claims[key]) return claims[key];
      }
      if (typeof claims.sub === 'string' && claims.sub && !/^\d+$/.test(claims.sub)) return claims.sub;
    } catch {
      // Not a JWT: the login is bound from the first owner segment seen instead.
    }
  }
  return null;
}

/** Global node ids, GitHub-style: base64 of "<Type>:<database id>". */
export function globalId(type, dbId) {
  return Buffer.from(`${type}:${dbId}`, 'utf8').toString('base64');
}

export function parseGlobalId(id) {
  try {
    const text = Buffer.from(String(id), 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 0) return null;
    return { type: text.slice(0, colon), dbId: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

export class Forge {
  constructor(token) {
    this.objects = new Map(); // sha -> { type, data }
    this.repos = new Map(); // lowercased name -> repo record
    this.nextId = 1000; // one global counter for database ids
    this.login = deriveLoginFromToken(token);
    this.userId = this.allocId();
    this.packCache = new Map(); // pack key -> Buffer (objects are immutable)
    this.fetchCache = new Map(); // fetch request tuple -> { pack, shallowOut, unshallowOut }
  }

  allocId() {
    const id = this.nextId;
    this.nextId += 1;
    return id;
  }

  /** The first owner segment seen for this token names the account, first-wins. */
  bindLogin(owner) {
    if (!this.login && owner) this.login = owner;
  }

  // ------------------------------------------------------------ objects

  put(type, data) {
    const sha = hashObject(type, data);
    if (!this.objects.has(sha)) this.objects.set(sha, { type, data });
    return sha;
  }

  get(sha) {
    return this.objects.get(sha);
  }

  has(sha) {
    return this.objects.has(sha);
  }

  /** Follow a tag chain to the commit it ultimately points at (or null). */
  peelToCommit(sha) {
    let current = sha;
    for (let depth = 0; depth < 16; depth += 1) {
      const obj = this.get(current);
      if (!obj) return null;
      if (obj.type === 'commit') return current;
      if (obj.type === 'tag') {
        current = parseTag(obj.data).object;
        continue;
      }
      return null;
    }
    return null;
  }

  /** All commits reachable from the given tips (tips included), parents followed. */
  reachableCommits(tips, shallowSet = null) {
    const out = new Set();
    const stack = [...tips];
    while (stack.length) {
      const sha = stack.pop();
      if (out.has(sha)) continue;
      const obj = this.get(sha);
      if (!obj || obj.type !== 'commit') continue;
      out.add(sha);
      if (shallowSet && shallowSet.has(sha)) continue;
      for (const parent of parseCommit(obj.data).parents) stack.push(parent);
    }
    return out;
  }

  /**
   * Every object reachable from the tips: commits (parents followed unless the commit
   * is in `shallowSet`), their trees recursively, blobs and tag chains.
   */
  objectClosure(tips, shallowSet = null) {
    const out = new Set();
    const stack = [...tips];
    while (stack.length) {
      const sha = stack.pop();
      if (out.has(sha)) continue;
      const obj = this.get(sha);
      if (!obj) continue;
      out.add(sha);
      if (obj.type === 'commit') {
        const commit = parseCommit(obj.data);
        stack.push(commit.tree);
        if (!(shallowSet && shallowSet.has(sha))) {
          for (const parent of commit.parents) stack.push(parent);
        }
      } else if (obj.type === 'tree') {
        for (const entry of parseTree(obj.data)) stack.push(entry.oid);
      } else if (obj.type === 'tag') {
        const target = parseTag(obj.data).object;
        if (target) stack.push(target);
      }
    }
    return out;
  }

  /** True when `ancestor` is reachable from `descendant` through commit parents. */
  isAncestor(ancestor, descendant) {
    if (ancestor === descendant) return true;
    // Walk from the descendant and stop the moment the ancestor turns up: for a
    // fast-forward push the old tip is the new tip's parent, one step away.
    const seen = new Set();
    const stack = [descendant];
    while (stack.length) {
      const sha = stack.pop();
      if (sha === ancestor) return true;
      if (seen.has(sha)) continue;
      seen.add(sha);
      const obj = this.get(sha);
      if (!obj || obj.type !== 'commit') continue;
      for (const parent of parseCommit(obj.data).parents) stack.push(parent);
    }
    return false;
  }

  /** The best common ancestor of two commits (breadth-first from b), or null. */
  mergeBase(a, b) {
    if (!a || !b) return null;
    const ancestorsOfA = this.reachableCommits([a]);
    if (ancestorsOfA.has(b)) return b;
    if (this.reachableCommits([b]).has(a)) return a;
    const seen = new Set();
    const queue = [b];
    while (queue.length) {
      const sha = queue.shift();
      if (seen.has(sha)) continue;
      seen.add(sha);
      if (ancestorsOfA.has(sha)) return sha;
      const obj = this.get(sha);
      if (obj && obj.type === 'commit') queue.push(...parseCommit(obj.data).parents);
    }
    return null;
  }

  // ------------------------------------------------------------ trees

  /** Flatten a tree into a Map of "path" -> { mode, oid }, recursively. */
  flattenTree(treeSha, prefix = '', out = new Map()) {
    const obj = treeSha ? this.get(treeSha) : null;
    if (!obj || obj.type !== 'tree') return out;
    for (const entry of parseTree(obj.data)) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (isTreeMode(entry.mode)) this.flattenTree(entry.oid, path, out);
      else out.set(path, { mode: entry.mode, oid: entry.oid });
    }
    return out;
  }

  /** Build (and store) a tree hierarchy from a flattened path map; returns its sha. */
  buildTree(flat) {
    const build = (entries) => {
      const treeEntries = [];
      const dirs = new Map();
      for (const [path, value] of entries) {
        const slash = path.indexOf('/');
        if (slash < 0) {
          treeEntries.push({ mode: value.mode, name: path, oid: value.oid });
        } else {
          const dir = path.slice(0, slash);
          if (!dirs.has(dir)) dirs.set(dir, new Map());
          dirs.get(dir).set(path.slice(slash + 1), value);
        }
      }
      for (const [dir, sub] of dirs) {
        treeEntries.push({ mode: '40000', name: dir, oid: build(sub) });
      }
      return this.put('tree', serializeTree(treeEntries));
    };
    return build(flat);
  }

  /** Walk a tree by path segments; returns { type: 'blob'|'tree', oid, mode } or null. */
  lookupInTree(treeSha, segments) {
    let current = treeSha;
    for (let i = 0; i < segments.length; i += 1) {
      const obj = current ? this.get(current) : null;
      if (!obj || obj.type !== 'tree') return null;
      const entry = parseTree(obj.data).find((candidate) => candidate.name === segments[i]);
      if (!entry) return null;
      if (i === segments.length - 1) {
        return { type: isTreeMode(entry.mode) ? 'tree' : 'blob', oid: entry.oid, mode: entry.mode };
      }
      if (!isTreeMode(entry.mode)) return null;
      current = entry.oid;
    }
    return { type: 'tree', oid: treeSha, mode: '40000' };
  }

  treeOfCommit(commitSha) {
    const obj = commitSha ? this.get(commitSha) : null;
    if (!obj || obj.type !== 'commit') return null;
    return parseCommit(obj.data).tree;
  }

  // ------------------------------------------------------------ commits made by the API

  defaultIdent() {
    const login = this.login ?? 'forge';
    return `${login} <${login}@coreforge.invalid> ${tickEpochSec()} +0000`;
  }

  /**
   * Commit a set of path changes ({ path -> {mode, oid} | null }) on top of a branch ref,
   * creating the branch when it does not exist yet. Returns the new commit sha.
   */
  commitFiles(repo, branchRef, changes, message, ident = null) {
    const tip = repo.refs.get(branchRef) ?? null;
    const baseTree = tip ? this.treeOfCommit(tip) : null;
    const flat = baseTree ? this.flattenTree(baseTree) : new Map();
    for (const [path, value] of changes) {
      if (value === null) flat.delete(path);
      else flat.set(path, value);
    }
    const tree = this.buildTree(flat);
    const who = ident ?? this.defaultIdent();
    const data = serializeCommit({
      tree,
      parents: tip ? [tip] : [],
      author: who,
      committer: who,
      message: message ?? '',
    });
    const sha = this.put('commit', data);
    repo.refs.set(branchRef, sha);
    repo.updatedAt = tickIso();
    return sha;
  }

  /** A three-way merge of flattened trees; returns { flat } or { conflict: true }. */
  mergeFlats(baseFlat, oursFlat, theirsFlat) {
    const result = new Map();
    const paths = new Set([...baseFlat.keys(), ...oursFlat.keys(), ...theirsFlat.keys()]);
    const same = (x, y) => (x === undefined && y === undefined)
      || (x !== undefined && y !== undefined && x.oid === y.oid && x.mode === y.mode);
    for (const path of paths) {
      const base = baseFlat.get(path);
      const ours = oursFlat.get(path);
      const theirs = theirsFlat.get(path);
      if (same(ours, theirs)) {
        if (ours !== undefined) result.set(path, ours);
      } else if (same(base, ours)) {
        if (theirs !== undefined) result.set(path, theirs);
      } else if (same(base, theirs)) {
        if (ours !== undefined) result.set(path, ours);
      } else {
        return { conflict: true };
      }
    }
    return { flat: result };
  }

  // ------------------------------------------------------------ repositories

  createRepo({ name, description = '', isPrivate = false }) {
    const now = tickIso();
    const repo = {
      id: this.allocId(),
      name,
      description: description ?? '',
      private: Boolean(isPrivate),
      defaultBranch: 'main',
      refs: new Map(), // full ref name -> sha
      labels: new Map(), // name -> { id, name, color, description }
      issues: new Map(), // number -> issue
      pulls: new Map(), // number -> pull request
      nextNumber: 1, // issues and pull requests share one per-repo counter
      createdAt: now,
      updatedAt: now,
    };
    this.repos.set(String(name).toLowerCase(), repo);
    return repo;
  }

  repoByName(name) {
    if (!name) return null;
    return this.repos.get(String(name).toLowerCase()) ?? null;
  }

  repoById(dbId) {
    for (const repo of this.repos.values()) {
      if (repo.id === Number(dbId)) return repo;
    }
    return null;
  }

  /** A repository is visible only under its owner's login (once the login is known). */
  getRepo(owner, name) {
    if (this.login && owner !== this.login) return null;
    return this.repoByName(name);
  }

  deleteRepo(repo) {
    this.repos.delete(repo.name.toLowerCase());
  }

  allRepos() {
    return [...this.repos.values()].sort((a, b) => a.id - b.id);
  }

  headRef(repo) {
    return `refs/heads/${repo.defaultBranch}`;
  }

  /** Resolve a ref-ish (branch name, full ref, tag name or commit sha) to a commit sha. */
  resolveCommit(repo, ref) {
    if (!ref) return repo.refs.get(this.headRef(repo)) ?? null;
    if (/^[0-9a-f]{40}$/.test(ref)) {
      const peeled = this.peelToCommit(ref);
      if (peeled) return peeled;
    }
    const candidates = [
      ref,
      `refs/heads/${ref}`,
      `refs/tags/${ref}`,
      `refs/${ref}`,
    ];
    for (const candidate of candidates) {
      const sha = repo.refs.get(candidate);
      if (sha) return this.peelToCommit(sha) ?? sha;
    }
    return null;
  }

  // ------------------------------------------------------------ issues & pulls

  createIssue(repo, { title, body = '', labelNames = [] }) {
    const now = tickIso();
    const issue = {
      id: this.allocId(),
      number: repo.nextNumber,
      title: title ?? '',
      body: body ?? '',
      state: 'open',
      labels: labelNames.map((name) => repo.labels.get(name)).filter(Boolean),
      comments: [],
      userLogin: this.login ?? '',
      createdAt: now,
      updatedAt: now,
      closedAt: null,
    };
    repo.nextNumber += 1;
    repo.issues.set(issue.number, issue);
    return issue;
  }

  createPull(repo, { title, body = '', headRef, baseRef }) {
    const now = tickIso();
    const pull = {
      id: this.allocId(),
      number: repo.nextNumber,
      title: title ?? '',
      body: body ?? '',
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef,
      baseRef,
      headSha: repo.refs.get(`refs/heads/${headRef}`) ?? null,
      baseSha: repo.refs.get(`refs/heads/${baseRef}`) ?? null,
      comments: [],
      userLogin: this.login ?? '',
      createdAt: now,
      updatedAt: now,
      closedAt: null,
    };
    repo.nextNumber += 1;
    repo.pulls.set(pull.number, pull);
    return pull;
  }

  findOpenPull(repo, headRef, baseRef) {
    for (const pull of repo.pulls.values()) {
      if (pull.state === 'open' && pull.headRef === headRef && pull.baseRef === baseRef) return pull;
    }
    return null;
  }

  addComment(repo, target, body) {
    const now = tickIso();
    const comment = {
      id: this.allocId(),
      body: body ?? '',
      userLogin: this.login ?? '',
      createdAt: now,
      updatedAt: now,
    };
    target.comments.push(comment);
    return comment;
  }

  /**
   * Merge a pull request for real: a three-way tree merge against the merge base.
   * Returns { sha } on success or { conflict: true } / { missing: true }.
   */
  mergePull(repo, pull, method = 'squash') {
    const baseRef = `refs/heads/${pull.baseRef}`;
    const headRef = `refs/heads/${pull.headRef}`;
    const baseTip = repo.refs.get(baseRef) ?? null;
    const headTip = repo.refs.get(headRef) ?? null;
    if (!baseTip || !headTip) return { missing: true };
    const base = this.mergeBase(baseTip, headTip);
    const baseFlat = base ? this.flattenTree(this.treeOfCommit(base)) : new Map();
    const oursFlat = this.flattenTree(this.treeOfCommit(baseTip));
    const theirsFlat = this.flattenTree(this.treeOfCommit(headTip));
    const merged = this.mergeFlats(baseFlat, oursFlat, theirsFlat);
    if (merged.conflict) return { conflict: true };
    const tree = this.buildTree(merged.flat);
    const who = this.defaultIdent();
    const message = pull.body ? `${pull.title}\n\n${pull.body}` : pull.title;
    const parents = method === 'merge' ? [baseTip, headTip] : [baseTip];
    const data = serializeCommit({ tree, parents, author: who, committer: who, message });
    const sha = this.put('commit', data);
    repo.refs.set(baseRef, sha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = tickIso();
    pull.mergeCommitSha = sha;
    pull.closedAt = pull.mergedAt;
    pull.updatedAt = pull.mergedAt;
    repo.updatedAt = pull.mergedAt;
    return { sha };
  }

  /** True when the pull request's head merges cleanly into its base right now. */
  pullMergeable(repo, pull) {
    const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? null;
    const headTip = repo.refs.get(`refs/heads/${pull.headRef}`) ?? null;
    if (!baseTip || !headTip) return null;
    const base = this.mergeBase(baseTip, headTip);
    const baseFlat = base ? this.flattenTree(this.treeOfCommit(base)) : new Map();
    const merged = this.mergeFlats(
      baseFlat,
      this.flattenTree(this.treeOfCommit(baseTip)),
      this.flattenTree(this.treeOfCommit(headTip)),
    );
    return !merged.conflict;
  }

  /** The changed-file list between a pull request's merge base and its head tip. */
  pullFiles(repo, pull) {
    const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
    const headTip = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
    if (!baseTip || !headTip) return [];
    const base = this.mergeBase(baseTip, headTip) ?? baseTip;
    const before = this.flattenTree(this.treeOfCommit(base));
    const after = this.flattenTree(this.treeOfCommit(headTip));
    const files = [];
    const paths = new Set([...before.keys(), ...after.keys()]);
    for (const path of [...paths].sort()) {
      const a = before.get(path);
      const b = after.get(path);
      if (a && b && a.oid === b.oid) continue;
      const aData = a ? this.get(a.oid)?.data ?? Buffer.alloc(0) : null;
      const bData = b ? this.get(b.oid)?.data ?? Buffer.alloc(0) : null;
      let status;
      let additions;
      let deletions;
      if (!a) {
        status = 'added';
        additions = countLines(bData);
        deletions = 0;
      } else if (!b) {
        status = 'removed';
        additions = 0;
        deletions = countLines(aData);
      } else {
        status = 'modified';
        const diff = lineDiff(aData, bData);
        additions = diff.additions;
        deletions = diff.deletions;
      }
      files.push({
        filename: path,
        status,
        additions,
        deletions,
        changes: additions + deletions,
        sha: b ? b.oid : a.oid,
      });
    }
    return files;
  }
}

/** Count text lines the way diff tooling does (a trailing newline ends the last line). */
export function countLines(data) {
  if (!data || data.length === 0) return 0;
  const text = data.toString('utf8');
  const lines = text.split('\n');
  return text.endsWith('\n') ? lines.length - 1 : lines.length;
}

/** Line-level additions/deletions between two blobs, via an LCS walk (capped). */
export function lineDiff(aData, bData) {
  const splitLines = (data) => {
    if (!data || data.length === 0) return [];
    const text = data.toString('utf8');
    const lines = text.split('\n');
    if (text.endsWith('\n')) lines.pop();
    return lines;
  };
  const a = splitLines(aData);
  const b = splitLines(bData);
  if (a.length * b.length > 4_000_000) {
    return { additions: b.length, deletions: a.length };
  }
  const rows = a.length + 1;
  const cols = b.length + 1;
  const dp = new Array(rows);
  for (let i = 0; i < rows; i += 1) dp[i] = new Uint32Array(cols);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const common = dp[0][0];
  return { additions: b.length - common, deletions: a.length - common };
}

export { ZERO_OID };
