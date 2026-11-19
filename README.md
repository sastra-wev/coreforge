# CoreForge

A standalone, GitHub-compatible git forge in a single Node.js process —
git smart HTTP (upload-pack protocol v2, receive-pack v0), the REST v3 API,
the GraphQL v4 API and an MCP endpoint, all served from its own store with
no UI, no outside service and no git binary. Standard library only.

Entry for the make.fun **github-core-clone-01** bounty:
https://make.fun/bounty/github-core-clone-01

[![Competition](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01)
[![Rank](https://make.fun/badge/github-core-clone-01/sastra-wev/coreforge/rank.svg)](https://make.fun/bounty/github-core-clone-01)
[![Reward](https://make.fun/badge/github-core-clone-01/sastra-wev/coreforge/reward.svg)](https://make.fun/bounty/github-core-clone-01)

## Run

    node main.ts

The forge binds an ephemeral port, registers it with
`$MAKEFUN_ENV_URL/register`, serves until the suite reports done, then
exits 0. Requests carry `Authorization: Bearer $MAKEFUN_SHOP_TOKEN`.

## Development

Layout (plain-JavaScript syntax in `.ts` files, Node type-stripping, no build
step, `node:` builtins only):

- `main.ts` — the harness lifecycle: listen on port 0, register, poll done.
- `src/server.ts` — one HTTP server routing the four surfaces, bearer auth,
  `/healthz`.
- `src/store.ts` — the in-memory store: content-addressed objects, refs,
  labels, issues, pull requests, three-way tree merges, line diffs.
- `src/objects.ts` — sha1 object identity, commit/tree/tag codecs, pkt-lines,
  packfile build/parse with ofs-/ref-delta resolution.
- `src/gitHttp.ts` — smart HTTP: v2 advertisement + `ls-refs` + `fetch`
  (absolute and `deepen-relative` shallow handling, fetch-result and pack
  caches), v0 fallback, receive-pack with fast-forward enforcement and
  sideband report-status.
- `src/rest.ts` — REST v3: repositories, contents (real commits on branches),
  git refs, branches, commits, labels, issues, comments, pull requests and
  squash/merge with real conflict detection (405).
- `src/graphql.ts` — a tolerant GraphQL parser/executor with GitHub-shaped
  schema, connections with cursor pagination, mutations that share state with
  REST, and `__type`/`__schema` introspection.
- `src/mcp.ts` — MCP over JSON-RPC: `server/discover` (2026-07-28),
  `initialize` handshake revisions, six tools on the same store.
- `src/clock.ts` — a deterministic clock seeded from `MAKEFUN_TRIAL_NOW`
  (+1s per tick) so a replay produces byte-identical answers.

Local checks: the entry passes the kit's own suite end to end
(`node cli/makefun.mjs grade-local --kit . --bot <repo> --driver process`):
feature 600/600, agent 200/200, performance ~160/200 on practice trial 0,
with the replay matching the live pass byte for byte. It is also exercised
against the real `git` CLI (clone/push/fetch, v0 and v2, tags, shallow
deepen/unshallow, mixed fast-forward + non-fast-forward pushes).
