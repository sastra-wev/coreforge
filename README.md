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
