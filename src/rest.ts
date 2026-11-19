// The REST v3 surface under /api/v3, plus the JSON serializers that GraphQL and MCP
// reuse so every surface agrees on ids and shapes.

import { parseCommit, parseIdent, parseTree, isTreeMode } from './objects.ts';
import { globalId } from './store.ts';
import { isoFromEpochSec, tickIso } from './clock.ts';

const NOT_FOUND = { message: 'Not Found' };

function hostOf(baseUrl) {
  try {
    return new URL(baseUrl).host;
  } catch {
    return 'localhost';
  }
}

export function userJson(forge) {
  return {
    login: forge.login ?? '',
    id: forge.userId,
    node_id: globalId('User', forge.userId),
    type: 'User',
    site_admin: false,
  };
}

export function repoJson(forge, baseUrl, repo) {
  const login = forge.login ?? '';
  const fullName = `${login}/${repo.name}`;
  let openIssues = 0;
  for (const issue of repo.issues.values()) if (issue.state === 'open') openIssues += 1;
  for (const pull of repo.pulls.values()) if (pull.state === 'open') openIssues += 1;
  return {
    id: repo.id,
    node_id: globalId('Repository', repo.id),
    name: repo.name,
    full_name: fullName,
    owner: userJson(forge),
    private: repo.private,
    html_url: `${baseUrl}/${fullName}`,
    description: repo.description,
    fork: false,
    url: `${baseUrl}/api/v3/repos/${fullName}`,
    clone_url: `${baseUrl}/${fullName}.git`,
    ssh_url: `git@${hostOf(baseUrl)}:${fullName}.git`,
    git_url: `git://${hostOf(baseUrl)}/${fullName}.git`,
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    forks_count: 0,
    archived: false,
    disabled: false,
    open_issues_count: openIssues,
    license: null,
    topics: [],
    visibility: repo.private ? 'private' : 'public',
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
  };
}

export function labelJson(label) {
  return {
    id: label.id,
    node_id: globalId('Label', label.id),
    name: label.name,
    color: label.color,
    default: false,
    description: label.description,
  };
}

export function issueJson(forge, baseUrl, repo, issue) {
  const login = forge.login ?? '';
  const fullName = `${login}/${repo.name}`;
  return {
    id: issue.id,
    node_id: globalId('Issue', issue.id),
    url: `${baseUrl}/api/v3/repos/${fullName}/issues/${issue.number}`,
    repository_url: `${baseUrl}/api/v3/repos/${fullName}`,
    html_url: `${baseUrl}/${fullName}/issues/${issue.number}`,
    number: issue.number,
    state: issue.state,
    title: issue.title,
    body: issue.body ?? '',
    user: userJson(forge),
    labels: issue.labels.map(labelJson),
    assignee: null,
    assignees: [],
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
  };
}

/** A pull request seen through the issues API, as GitHub serves it. */
export function pullAsIssueJson(forge, baseUrl, repo, pull) {
  const base = issueJson(forge, baseUrl, repo, {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    labels: [],
    comments: pull.comments,
    createdAt: pull.createdAt,
    updatedAt: pull.updatedAt,
    closedAt: pull.closedAt,
  });
  const login = forge.login ?? '';
  base.node_id = globalId('PullRequest', pull.id);
  base.pull_request = {
    url: `${baseUrl}/api/v3/repos/${login}/${repo.name}/pulls/${pull.number}`,
    html_url: `${baseUrl}/${login}/${repo.name}/pull/${pull.number}`,
    merged_at: pull.mergedAt,
  };
  return base;
}

export function commentJson(forge, baseUrl, repo, issueNumber, comment) {
  const login = forge.login ?? '';
  const fullName = `${login}/${repo.name}`;
  return {
    id: comment.id,
    node_id: globalId('IssueComment', comment.id),
    url: `${baseUrl}/api/v3/repos/${fullName}/issues/comments/${comment.id}`,
    html_url: `${baseUrl}/${fullName}/issues/${issueNumber}#issuecomment-${comment.id}`,
    issue_url: `${baseUrl}/api/v3/repos/${fullName}/issues/${issueNumber}`,
    body: comment.body,
    user: userJson(forge),
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
  };
}

function refJson(forge, baseUrl, repo, refName, sha) {
  const login = forge.login ?? '';
  return {
    label: `${login}:${refName}`,
    ref: refName,
    sha: sha ?? null,
    user: userJson(forge),
    repo: repoJson(forge, baseUrl, repo),
  };
}

export function pullJson(forge, baseUrl, repo, pull) {
  const login = forge.login ?? '';
  const fullName = `${login}/${repo.name}`;
  const headSha = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
  const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
  const mergeable = pull.merged ? true : forge.pullMergeable(repo, pull);
  return {
    id: pull.id,
    node_id: globalId('PullRequest', pull.id),
    url: `${baseUrl}/api/v3/repos/${fullName}/pulls/${pull.number}`,
    html_url: `${baseUrl}/${fullName}/pull/${pull.number}`,
    diff_url: `${baseUrl}/${fullName}/pull/${pull.number}.diff`,
    patch_url: `${baseUrl}/${fullName}/pull/${pull.number}.patch`,
    number: pull.number,
    state: pull.merged ? 'closed' : pull.state,
    title: pull.title,
    body: pull.body ?? '',
    user: userJson(forge),
    labels: [],
    draft: false,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.closedAt,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    merged: pull.merged,
    mergeable,
    mergeable_state: mergeable === null ? 'unknown' : mergeable ? 'clean' : 'dirty',
    comments: pull.comments.length,
    head: refJson(forge, baseUrl, repo, pull.headRef, headSha),
    base: refJson(forge, baseUrl, repo, pull.baseRef, baseSha),
    author_association: 'OWNER',
  };
}

export function commitJson(forge, baseUrl, repo, sha) {
  const obj = forge.get(sha);
  const login = forge.login ?? '';
  const fullName = `${login}/${repo.name}`;
  if (!obj || obj.type !== 'commit') return null;
  const commit = parseCommit(obj.data);
  const author = parseIdent(commit.author);
  const committer = parseIdent(commit.committer);
  const person = (ident) => ({
    name: ident.name,
    email: ident.email,
    date: isoFromEpochSec(ident.epochSec),
  });
  return {
    sha,
    node_id: globalId('Commit', sha),
    commit: {
      author: person(author),
      committer: person(committer),
      message: commit.message,
      tree: { sha: commit.tree, url: `${baseUrl}/api/v3/repos/${fullName}/git/trees/${commit.tree}` },
      url: `${baseUrl}/api/v3/repos/${fullName}/git/commits/${sha}`,
      comment_count: 0,
    },
    url: `${baseUrl}/api/v3/repos/${fullName}/commits/${sha}`,
    html_url: `${baseUrl}/${fullName}/commit/${sha}`,
    author: null,
    committer: null,
    parents: commit.parents.map((parent) => ({
      sha: parent,
      url: `${baseUrl}/api/v3/repos/${fullName}/commits/${parent}`,
      html_url: `${baseUrl}/${fullName}/commit/${parent}`,
    })),
  };
}

// ---------------------------------------------------------------------------
// helpers

function paginate(items, query, baseUrl, rawPath) {
  const perPage = Math.min(100, Math.max(1, Number(query.get('per_page')) || 30));
  const page = Math.max(1, Number(query.get('page')) || 1);
  const total = items.length;
  const slice = items.slice((page - 1) * perPage, page * perPage);
  const headers = {};
  if (page * perPage < total) {
    const params = new URLSearchParams(query);
    params.set('per_page', String(perPage));
    params.set('page', String(page + 1));
    const lastParams = new URLSearchParams(query);
    lastParams.set('per_page', String(perPage));
    lastParams.set('page', String(Math.ceil(total / perPage)));
    headers.link = `<${baseUrl}${rawPath}?${params}>; rel="next", <${baseUrl}${rawPath}?${lastParams}>; rel="last"`;
  }
  return { slice, headers };
}

function labelNamesOf(body) {
  if (!Array.isArray(body?.labels)) return [];
  return body.labels.map((label) => (typeof label === 'string' ? label : label?.name)).filter(Boolean);
}

function resolveLabels(repo, body) {
  const names = labelNamesOf(body);
  const labels = [];
  for (const name of names) {
    const label = repo.labels.get(name);
    if (!label) return { error: name };
    labels.push(label);
  }
  return { labels };
}

// ---------------------------------------------------------------------------
// the handler

/**
 * Handle one REST request. `segments` is the decoded path after /api/v3.
 * Returns { status, json, headers? } (json === undefined means an empty body).
 */
export function handleRest(forge, ctx, method, segments, query, body, bodyMalformed) {
  const { baseUrl, rawPath } = ctx;
  const reply = (status, json, headers) => ({ status, json, headers });
  if (bodyMalformed && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    return reply(400, { message: 'Problems parsing JSON' });
  }
  const data = body ?? {};

  // /api/v3/ and /api/v3/meta and /api/v3/user
  if (segments.length === 0) {
    if (method !== 'GET') return reply(404, NOT_FOUND);
    return reply(200, {
      current_user_url: `${baseUrl}/api/v3/user`,
      current_user_repositories_url: `${baseUrl}/api/v3/user/repos`,
      repository_url: `${baseUrl}/api/v3/repos/{owner}/{repo}`,
      meta_url: `${baseUrl}/api/v3/meta`,
    });
  }
  if (segments[0] === 'meta' && segments.length === 1) {
    if (method !== 'GET') return reply(404, NOT_FOUND);
    return reply(200, {
      verifiable_password_authentication: false,
      ssh_key_fingerprints: {},
      installed_version: '1.0.0-coreforge',
    });
  }
  if (segments[0] === 'user' && segments.length === 1) {
    if (method !== 'GET') return reply(404, NOT_FOUND);
    return reply(200, userJson(forge));
  }
  if (segments[0] === 'user' && segments[1] === 'repos' && segments.length === 2) {
    if (method === 'GET') {
      const { slice, headers } = paginate(forge.allRepos(), query, baseUrl, rawPath);
      return reply(200, slice.map((repo) => repoJson(forge, baseUrl, repo)), headers);
    }
    if (method === 'POST') {
      const name = data.name;
      if (typeof name !== 'string' || name === '' || /[/\s]/.test(name)) {
        return reply(422, { message: 'Repository creation failed: the name is invalid.' });
      }
      if (forge.repoByName(name)) {
        return reply(422, { message: 'Repository creation failed: a repository with this name already exists.' });
      }
      const repo = forge.createRepo({
        name,
        description: typeof data.description === 'string' ? data.description : '',
        isPrivate: data.private === true,
      });
      if (data.auto_init === true) {
        const blob = forge.put('blob', Buffer.from(`# ${name}\n`, 'utf8'));
        forge.commitFiles(repo, forge.headRef(repo), new Map([['README.md', { mode: '100644', oid: blob }]]), 'Initial commit');
      }
      return reply(201, repoJson(forge, baseUrl, repo));
    }
    return reply(404, NOT_FOUND);
  }

  if (segments[0] !== 'repos' || segments.length < 3) return reply(404, NOT_FOUND);
  const owner = segments[1];
  const repoName = segments[2];
  forge.bindLogin(owner);
  const repo = forge.getRepo(owner, repoName);
  if (!repo) return reply(404, NOT_FOUND);
  const rest = segments.slice(3);
  const fullName = `${forge.login ?? owner}/${repo.name}`;

  // the repository itself
  if (rest.length === 0) {
    if (method === 'GET') return reply(200, repoJson(forge, baseUrl, repo));
    if (method === 'PATCH') {
      if (typeof data.description === 'string') repo.description = data.description;
      if (typeof data.private === 'boolean') repo.private = data.private;
      if (typeof data.name === 'string' && data.name !== repo.name) {
        if (forge.repoByName(data.name)) return reply(422, { message: 'Repository rename failed: a repository with this name already exists.' });
        forge.deleteRepo(repo);
        repo.name = data.name;
        forge.repos.set(repo.name.toLowerCase(), repo);
      }
      if (typeof data.default_branch === 'string' && repo.refs.has(`refs/heads/${data.default_branch}`)) {
        repo.defaultBranch = data.default_branch;
      }
      return reply(200, repoJson(forge, baseUrl, repo));
    }
    if (method === 'DELETE') {
      forge.deleteRepo(repo);
      return reply(204, undefined);
    }
    return reply(404, NOT_FOUND);
  }

  // contents API
  if (rest[0] === 'contents') {
    const path = rest.slice(1).join('/');
    return contentsRoute(forge, ctx, method, repo, path, query, data, reply);
  }

  // git refs
  if (rest[0] === 'git' && rest[1] === 'refs') {
    if (rest.length === 2) {
      if (method === 'GET') {
        const list = [...repo.refs.entries()]
          .sort((a, b) => (a[0] < b[0] ? -1 : 1))
          .map(([ref, sha]) => ({
            ref,
            node_id: globalId('Ref', `${repo.id}:${ref}`),
            url: `${baseUrl}/api/v3/repos/${fullName}/git/${ref}`,
            object: { sha, type: forge.get(sha)?.type ?? 'commit', url: `${baseUrl}/api/v3/repos/${fullName}/git/commits/${sha}` },
          }));
        return reply(200, list);
      }
      if (method === 'POST') {
        const ref = data.ref;
        const sha = data.sha;
        if (typeof ref !== 'string' || !ref.startsWith('refs/')) {
          return reply(422, { message: 'Validation Failed: ref must start with refs/' });
        }
        const obj = typeof sha === 'string' ? forge.get(sha) : null;
        if (!obj) return reply(422, { message: 'Object does not exist' });
        if (repo.refs.has(ref)) return reply(422, { message: 'Reference already exists' });
        repo.refs.set(ref, sha);
        return reply(201, {
          ref,
          node_id: globalId('Ref', `${repo.id}:${ref}`),
          url: `${baseUrl}/api/v3/repos/${fullName}/git/${ref}`,
          object: { sha, type: obj.type, url: `${baseUrl}/api/v3/repos/${fullName}/git/commits/${sha}` },
        });
      }
      return reply(404, NOT_FOUND);
    }
    if (method === 'GET') {
      const ref = `refs/${rest.slice(2).join('/')}`;
      const sha = repo.refs.get(ref);
      if (!sha) return reply(404, NOT_FOUND);
      return reply(200, {
        ref,
        node_id: globalId('Ref', `${repo.id}:${ref}`),
        url: `${baseUrl}/api/v3/repos/${fullName}/git/${ref}`,
        object: { sha, type: forge.get(sha)?.type ?? 'commit', url: `${baseUrl}/api/v3/repos/${fullName}/git/commits/${sha}` },
      });
    }
    return reply(404, NOT_FOUND);
  }

  // branches
  if (rest[0] === 'branches') {
    if (rest.length === 1 && method === 'GET') {
      const list = [...repo.refs.entries()]
        .filter(([ref]) => ref.startsWith('refs/heads/'))
        .sort((a, b) => (a[0] < b[0] ? -1 : 1))
        .map(([ref, sha]) => ({
          name: ref.slice('refs/heads/'.length),
          commit: { sha, url: `${baseUrl}/api/v3/repos/${fullName}/commits/${sha}` },
          protected: false,
        }));
      return reply(200, list);
    }
    if (rest.length >= 2 && method === 'GET') {
      const name = rest.slice(1).join('/');
      const sha = repo.refs.get(`refs/heads/${name}`);
      if (!sha) return reply(404, NOT_FOUND);
      return reply(200, {
        name,
        commit: { sha, url: `${baseUrl}/api/v3/repos/${fullName}/commits/${sha}` },
        protected: false,
      });
    }
    return reply(404, NOT_FOUND);
  }

  // commits
  if (rest[0] === 'commits') {
    if (rest.length === 1 && method === 'GET') {
      const start = forge.resolveCommit(repo, query.get('sha') ?? repo.defaultBranch);
      if (!start) return reply(200, []);
      const order = [];
      const seen = new Set();
      const stack = [start];
      while (stack.length) {
        const sha = stack.pop();
        if (seen.has(sha)) continue;
        const obj = forge.get(sha);
        if (!obj || obj.type !== 'commit') continue;
        seen.add(sha);
        order.push(sha);
        const parents = parseCommit(obj.data).parents;
        for (let i = parents.length - 1; i >= 0; i -= 1) stack.push(parents[i]);
      }
      const { slice, headers } = paginate(order, query, baseUrl, rawPath);
      return reply(200, slice.map((sha) => commitJson(forge, baseUrl, repo, sha)), headers);
    }
    if (rest.length === 2 && method === 'GET') {
      const json = commitJson(forge, baseUrl, repo, rest[1]);
      return json ? reply(200, json) : reply(404, NOT_FOUND);
    }
    return reply(404, NOT_FOUND);
  }

  // labels
  if (rest[0] === 'labels') {
    if (rest.length === 1) {
      if (method === 'GET') return reply(200, [...repo.labels.values()].map(labelJson));
      if (method === 'POST') {
        const name = data.name;
        if (typeof name !== 'string' || name === '') return reply(422, { message: 'Validation Failed: a label needs a name.' });
        if (repo.labels.has(name)) return reply(422, { message: 'Validation Failed: the label already exists.' });
        const color = typeof data.color === 'string' ? data.color.replace(/^#/, '') : 'ededed';
        const label = {
          id: forge.allocId(),
          name,
          color,
          description: typeof data.description === 'string' ? data.description : null,
        };
        repo.labels.set(name, label);
        return reply(201, labelJson(label));
      }
      return reply(404, NOT_FOUND);
    }
    if (rest.length === 2 && method === 'GET') {
      const label = repo.labels.get(rest[1]);
      return label ? reply(200, labelJson(label)) : reply(404, NOT_FOUND);
    }
    return reply(404, NOT_FOUND);
  }

  // issues (and their comments)
  if (rest[0] === 'issues') {
    if (rest.length === 1) {
      if (method === 'POST') {
        const resolved = resolveLabels(repo, data);
        if (resolved.error) {
          return reply(422, { message: `Validation Failed: label '${resolved.error}' does not exist.` });
        }
        const issue = forge.createIssue(repo, {
          title: typeof data.title === 'string' ? data.title : '',
          body: typeof data.body === 'string' ? data.body : '',
          labelNames: labelNamesOf(data),
        });
        return reply(201, issueJson(forge, baseUrl, repo, issue));
      }
      if (method === 'GET') {
        const state = query.get('state') ?? 'open';
        let list = [...repo.issues.values()];
        if (state === 'open') list = list.filter((issue) => issue.state === 'open');
        else if (state === 'closed') list = list.filter((issue) => issue.state === 'closed');
        const wantedLabels = (query.get('labels') ?? '').split(',').filter(Boolean);
        if (wantedLabels.length) {
          list = list.filter((issue) => wantedLabels.every((name) => issue.labels.some((label) => label.name === name)));
        }
        const direction = query.get('direction') ?? 'desc';
        list.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
        const { slice, headers } = paginate(list, query, baseUrl, rawPath);
        return reply(200, slice.map((issue) => issueJson(forge, baseUrl, repo, issue)), headers);
      }
      return reply(404, NOT_FOUND);
    }
    const number = Number(rest[1]);
    const issue = repo.issues.get(number);
    const pull = repo.pulls.get(number);
    if (rest.length === 2) {
      if (method === 'GET') {
        if (issue) return reply(200, issueJson(forge, baseUrl, repo, issue));
        if (pull) return reply(200, pullAsIssueJson(forge, baseUrl, repo, pull));
        return reply(404, NOT_FOUND);
      }
      if (method === 'PATCH' && issue) {
        if (typeof data.title === 'string') issue.title = data.title;
        if (typeof data.body === 'string') issue.body = data.body;
        if (data.labels !== undefined) {
          const resolved = resolveLabels(repo, data);
          if (resolved.error) return reply(422, { message: `Validation Failed: label '${resolved.error}' does not exist.` });
          issue.labels = resolved.labels;
        }
        if (data.state === 'closed' || data.state === 'open') {
          issue.state = data.state;
          issue.updatedAt = tickIso();
          issue.closedAt = data.state === 'closed' ? issue.updatedAt : null;
        }
        return reply(200, issueJson(forge, baseUrl, repo, issue));
      }
      return reply(404, NOT_FOUND);
    }
    if (rest.length === 3 && rest[2] === 'comments') {
      const target = issue ?? pull;
      if (!target) return reply(404, NOT_FOUND);
      if (method === 'GET') {
        return reply(200, target.comments.map((comment) => commentJson(forge, baseUrl, repo, number, comment)));
      }
      if (method === 'POST') {
        if (typeof data.body !== 'string') return reply(422, { message: 'Validation Failed: a comment needs a body.' });
        const comment = forge.addComment(repo, target, data.body);
        return reply(201, commentJson(forge, baseUrl, repo, number, comment));
      }
      return reply(404, NOT_FOUND);
    }
    return reply(404, NOT_FOUND);
  }

  // pull requests
  if (rest[0] === 'pulls') {
    if (rest.length === 1) {
      if (method === 'POST') {
        const cleanRef = (value) => {
          if (typeof value !== 'string') return '';
          return value.includes(':') ? value.split(':').pop() : value;
        };
        const headRef = cleanRef(data.head);
        const baseRef = cleanRef(data.base);
        if (!headRef || !repo.refs.has(`refs/heads/${headRef}`)) {
          return reply(422, { message: 'Validation Failed: the head branch does not exist.' });
        }
        if (!baseRef || !repo.refs.has(`refs/heads/${baseRef}`)) {
          return reply(422, { message: 'Validation Failed: the base branch does not exist.' });
        }
        if (forge.findOpenPull(repo, headRef, baseRef)) {
          return reply(422, { message: `Validation Failed: a pull request already exists for ${headRef} -> ${baseRef}.` });
        }
        const pull = forge.createPull(repo, {
          title: typeof data.title === 'string' ? data.title : '',
          body: typeof data.body === 'string' ? data.body : '',
          headRef,
          baseRef,
        });
        return reply(201, pullJson(forge, baseUrl, repo, pull));
      }
      if (method === 'GET') {
        const state = query.get('state') ?? 'open';
        let list = [...repo.pulls.values()];
        if (state === 'open') list = list.filter((pull) => pull.state === 'open');
        else if (state === 'closed') list = list.filter((pull) => pull.state === 'closed');
        const direction = query.get('direction') ?? 'desc';
        list.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
        const { slice, headers } = paginate(list, query, baseUrl, rawPath);
        return reply(200, slice.map((pull) => pullJson(forge, baseUrl, repo, pull)), headers);
      }
      return reply(404, NOT_FOUND);
    }
    const number = Number(rest[1]);
    const pull = repo.pulls.get(number);
    if (rest.length === 2 && method === 'GET') {
      return pull ? reply(200, pullJson(forge, baseUrl, repo, pull)) : reply(404, NOT_FOUND);
    }
    if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
      if (!pull) return reply(404, NOT_FOUND);
      const files = forge.pullFiles(repo, pull).map((file) => ({
        sha: file.sha,
        filename: file.filename,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        changes: file.changes,
      }));
      return reply(200, files);
    }
    if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
      if (!pull) return reply(404, NOT_FOUND);
      if (pull.merged || pull.state !== 'open') {
        return reply(405, { message: 'Pull Request is not mergeable' });
      }
      const method2 = typeof data.merge_method === 'string' ? data.merge_method : 'merge';
      const result = forge.mergePull(repo, pull, method2);
      if (result.conflict || result.missing) {
        return reply(405, { message: 'Pull Request is not mergeable' });
      }
      return reply(200, { sha: result.sha, merged: true, message: 'Pull Request successfully merged and closed.' });
    }
    return reply(404, NOT_FOUND);
  }

  return reply(404, NOT_FOUND);
}

function contentsRoute(forge, ctx, method, repo, path, query, data, reply) {
  const { baseUrl } = ctx;
  const login = forge.login ?? '';
  const fullName = `${login}/${repo.name}`;

  if (method === 'GET') {
    const commitSha = forge.resolveCommit(repo, query.get('ref') ?? repo.defaultBranch);
    if (!commitSha) return reply(404, NOT_FOUND);
    const tree = forge.treeOfCommit(commitSha);
    if (!tree) return reply(404, NOT_FOUND);
    if (path === '') return reply(200, listTree(forge, baseUrl, repo, tree, ''));
    const found = forge.lookupInTree(tree, path.split('/'));
    if (!found) return reply(404, NOT_FOUND);
    const name = path.split('/').pop();
    if (found.type === 'tree') return reply(200, listTree(forge, baseUrl, repo, found.oid, path));
    const blob = forge.get(found.oid);
    const content = blob.data.toString('base64');
    return reply(200, {
      type: 'file',
      encoding: 'base64',
      size: blob.data.length,
      name,
      path,
      content,
      sha: found.oid,
      url: `${baseUrl}/api/v3/repos/${fullName}/contents/${path}`,
      git_url: `${baseUrl}/api/v3/repos/${fullName}/git/blobs/${found.oid}`,
      html_url: `${baseUrl}/${fullName}/blob/${repo.defaultBranch}/${path}`,
      download_url: null,
    });
  }

  if (method === 'PUT') {
    if (typeof data.content !== 'string') return reply(422, { message: 'Validation Failed: content is required.' });
    const branch = typeof data.branch === 'string' ? data.branch : repo.defaultBranch;
    const ref = `refs/heads/${branch}`;
    if (!repo.refs.has(ref) && branch !== repo.defaultBranch) {
      const defaultTip = repo.refs.get(forge.headRef(repo));
      if (defaultTip) repo.refs.set(ref, defaultTip);
    }
    const tip = repo.refs.get(ref) ?? null;
    const tree = tip ? forge.treeOfCommit(tip) : null;
    const flat = tree ? forge.flattenTree(tree) : new Map();
    const existing = flat.get(path);
    if (existing && data.sha !== existing.oid) {
      return reply(409, { message: `Validation Failed: ${path} does not match the current sha.` });
    }
    if (!existing && data.sha) {
      return reply(409, { message: `Validation Failed: ${path} does not exist yet, so its sha cannot match.` });
    }
    const blobSha = forge.put('blob', Buffer.from(data.content, 'base64'));
    const message = typeof data.message === 'string' ? data.message : `Create ${path}`;
    const commitSha = forge.commitFiles(repo, ref, new Map([[path, { mode: '100644', oid: blobSha }]]), message);
    const commitObj = commitJson(forge, baseUrl, repo, commitSha);
    return reply(existing ? 200 : 201, {
      content: {
        type: 'file',
        encoding: 'base64',
        size: Buffer.from(data.content, 'base64').length,
        name: path.split('/').pop(),
        path,
        sha: blobSha,
        url: `${baseUrl}/api/v3/repos/${fullName}/contents/${path}`,
        git_url: `${baseUrl}/api/v3/repos/${fullName}/git/blobs/${blobSha}`,
        html_url: `${baseUrl}/${fullName}/blob/${branch}/${path}`,
        download_url: null,
      },
      commit: {
        sha: commitSha,
        message,
        author: commitObj?.commit.author ?? null,
        committer: commitObj?.commit.committer ?? null,
        tree: commitObj?.commit.tree ?? null,
        parents: commitObj?.parents ?? [],
      },
    });
  }

  if (method === 'DELETE') {
    const branch = typeof data.branch === 'string' ? data.branch : repo.defaultBranch;
    const ref = `refs/heads/${branch}`;
    const tip = repo.refs.get(ref) ?? null;
    if (!tip) return reply(404, NOT_FOUND);
    const flat = forge.flattenTree(forge.treeOfCommit(tip));
    const existing = flat.get(path);
    if (!existing) return reply(404, NOT_FOUND);
    if (typeof data.sha === 'string' && data.sha !== existing.oid) {
      return reply(409, { message: `Validation Failed: ${path} does not match the current sha.` });
    }
    const message = typeof data.message === 'string' ? data.message : `Delete ${path}`;
    const commitSha = forge.commitFiles(repo, ref, new Map([[path, null]]), message);
    return reply(200, { content: null, commit: { sha: commitSha, message } });
  }

  return reply(404, NOT_FOUND);
}

function listTree(forge, baseUrl, repo, treeSha, prefix) {
  const login = forge.login ?? '';
  const fullName = `${login}/${repo.name}`;
  const obj = forge.get(treeSha);
  if (!obj || obj.type !== 'tree') return [];
  return parseTree(obj.data)
    .map((entry) => {
      const isDir = isTreeMode(entry.mode);
      const entryPath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const blob = !isDir ? forge.get(entry.oid) : null;
      return {
        type: isDir ? 'dir' : 'file',
        size: blob ? blob.data.length : 0,
        name: entry.name,
        path: entryPath,
        sha: entry.oid,
        url: `${baseUrl}/api/v3/repos/${fullName}/contents/${entryPath}`,
        git_url: `${baseUrl}/api/v3/repos/${fullName}/git/${isDir ? 'trees' : 'blobs'}/${entry.oid}`,
        html_url: `${baseUrl}/${fullName}/${isDir ? 'tree' : 'blob'}/${repo.defaultBranch}/${entryPath}`,
        download_url: null,
      };
    })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
