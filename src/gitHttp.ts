// Git smart HTTP: protocol v2 upload-pack (ls-refs + fetch), v0 upload-pack fallback
// and v0 receive-pack, all served from the forge's in-memory object store.

import {
  ZERO_OID,
  pktLine,
  PKT_FLUSH,
  PKT_DELIM,
  parsePktStream,
  buildPack,
  parsePack,
  parseCommit,
  parseTag,
  sha1hex,
} from './objects.ts';

const AGENT = 'coreforge/1.0';
const TYPE_ORDER = { commit: 0, tag: 1, tree: 2, blob: 3 };

function sortedRefs(repo) {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/** The v0-style ref advertisement lines (first line carries the capabilities). */
function v0RefLines(forge, repo, caps) {
  const headRef = forge.headRef(repo);
  const headTip = repo.refs.get(headRef) ?? null;
  const refs = sortedRefs(repo);
  if (!headTip && refs.length === 0) {
    return [pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`)];
  }
  const lines = [];
  let first = true;
  const push = (oid, name) => {
    lines.push(pktLine(first ? `${oid} ${name}\0${caps}\n` : `${oid} ${name}\n`));
    first = false;
  };
  push(headTip ?? ZERO_OID, 'HEAD');
  for (const [name, oid] of refs) {
    push(oid, name);
    const obj = forge.get(oid);
    if (obj && obj.type === 'tag') {
      const peeled = forge.peelToCommit(oid);
      if (peeled) lines.push(pktLine(`${peeled} ${name}^{}\n`));
    }
  }
  return lines;
}

/** GET /info/refs advertisement for either service. */
export function advertise(forge, repo, service, version2) {
  if (service === 'git-upload-pack' && version2) {
    const body = Buffer.concat([
      pktLine('version 2\n'),
      pktLine(`agent=${AGENT}\n`),
      pktLine('ls-refs=unborn\n'),
      pktLine('fetch=shallow wait-for-done side-band-64k ofs-delta\n'),
      pktLine('object-format=sha1\n'),
      PKT_FLUSH,
    ]);
    return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body };
  }
  if (service === 'git-upload-pack') {
    const caps = [
      'side-band-64k',
      'thin-pack',
      'ofs-delta',
      'shallow',
      'no-progress',
      `agent=${AGENT}`,
      `symref=HEAD:${forge.headRef(repo)}`,
    ].join(' ');
    const body = Buffer.concat([
      pktLine('# service=git-upload-pack\n'),
      PKT_FLUSH,
      ...v0RefLines(forge, repo, caps),
      PKT_FLUSH,
    ]);
    return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body };
  }
  // git-receive-pack speaks v0 only.
  const caps = ['report-status', 'side-band-64k', 'delete-refs', 'ofs-delta', `agent=${AGENT}`].join(' ');
  const body = Buffer.concat([
    pktLine('# service=git-receive-pack\n'),
    PKT_FLUSH,
    ...v0RefLines(forge, repo, caps),
    PKT_FLUSH,
  ]);
  return { status: 200, contentType: 'application/x-git-receive-pack-advertisement', body };
}

/** Wrap bytes as sideband band-1 pkt-lines (payload chunks of 32 KiB). */
function sidebandChunks(data) {
  const chunks = [];
  for (let off = 0; off < data.length; off += 32768) {
    const slice = data.subarray(off, Math.min(off + 32768, data.length));
    chunks.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  if (chunks.length === 0) chunks.push(pktLine(Buffer.from([1])));
  return chunks;
}

/** Parse every pkt-line in a request body, across flush-separated sections. */
function parseAllPackets(body) {
  const packets = [];
  let off = 0;
  while (off < body.length) {
    const { packets: chunk, next } = parsePktStream(body, off);
    packets.push(...chunk);
    off = next;
    if (!chunk.some((packet) => packet.kind === 'flush')) break;
    if (next >= body.length) break;
  }
  return packets;
}

// ---------------------------------------------------------------------------
// ls-refs (protocol v2)

function lsRefs(forge, repo, args) {
  const peel = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const unborn = args.includes('unborn');
  const prefixes = args.filter((arg) => arg.startsWith('ref-prefix ')).map((arg) => arg.slice('ref-prefix '.length));
  const matches = (name) => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const lines = [];
  const headRef = forge.headRef(repo);
  const headTip = repo.refs.get(headRef) ?? null;
  if (matches('HEAD')) {
    if (headTip) {
      lines.push(`${headTip} HEAD${symrefs ? ` symref-target:${headRef}` : ''}`);
    } else if (unborn) {
      lines.push(`unborn HEAD symref-target:${headRef}`);
    }
  }
  for (const [name, oid] of sortedRefs(repo)) {
    if (!matches(name)) continue;
    let line = `${oid} ${name}`;
    if (peel) {
      const obj = forge.get(oid);
      if (obj && obj.type === 'tag') {
        const peeled = forge.peelToCommit(oid);
        if (peeled) line += ` peeled:${peeled}`;
      }
    }
    lines.push(line);
  }
  return Buffer.concat([...lines.map((line) => pktLine(`${line}\n`)), PKT_FLUSH]);
}

// ---------------------------------------------------------------------------
// fetch (shared by protocol v2 and v0)

function computeFetch(forge, wants, haves, shallowClient, depth, deepenRelative = false) {
  // The object graph is immutable and content-addressed, so a fetch over wants and
  // haves that all exist has one answer forever: cache it by the request tuple.
  // (A want or have that does not exist yet is never cached — it may be pushed later.)
  const cacheable = wants.every((want) => forge.has(want)) && haves.every((have) => forge.has(have));
  const fetchKey = cacheable
    ? `${wants.join(',')}|${[...haves].sort().join(',')}|${[...shallowClient].sort().join(',')}|${depth}|${deepenRelative}`
    : null;
  if (fetchKey) {
    const cached = forge.fetchCache.get(fetchKey);
    if (cached) return cached;
  }
  const result = computeFetchUncached(forge, wants, haves, shallowClient, depth, deepenRelative);
  if (fetchKey) {
    if (forge.fetchCache.size > 256) forge.fetchCache.clear();
    forge.fetchCache.set(fetchKey, result);
  }
  return result;
}

function computeFetchUncached(forge, wants, haves, shallowClient, depth, deepenRelative = false) {
  const clientShallow = new Set(shallowClient);
  let included = null;
  if (depth != null && deepenRelative && clientShallow.size > 0) {
    // deepen-relative (real git's --deepen): extend the history `depth` generations
    // below the client's current shallow boundary commits; everything above the
    // boundary is included as usual.
    const closureAll = forge.reachableCommits(
      wants.filter((want) => {
        const obj = forge.get(want);
        return obj && obj.type === 'commit';
      }),
    );
    const below = new Map(); // commit -> generations below the nearest boundary commit
    const queue = [];
    for (const boundary of clientShallow) {
      if (closureAll.has(boundary) && !below.has(boundary)) {
        below.set(boundary, 0);
        queue.push(boundary);
      }
    }
    for (let qi = 0; qi < queue.length; qi += 1) {
      const current = queue[qi];
      const obj = forge.get(current);
      if (!obj || obj.type !== 'commit') continue;
      for (const parent of parseCommit(obj.data).parents) {
        if (!below.has(parent)) {
          below.set(parent, below.get(current) + 1);
          queue.push(parent);
        }
      }
    }
    included = new Set();
    for (const commitSha of closureAll) {
      if (!below.has(commitSha) || below.get(commitSha) <= depth) included.add(commitSha);
    }
  } else if (depth != null) {
    const levels = new Map();
    const queue = wants.map((want) => [want, 1]);
    for (let qi = 0; qi < queue.length; qi += 1) {
      const [sha, level] = queue[qi];
      if (levels.has(sha) && levels.get(sha) <= level) continue;
      levels.set(sha, level);
      const obj = forge.get(sha);
      if (!obj) continue;
      if (obj.type === 'commit') {
        // Parents of a commit already at the depth limit cannot be included: prune.
        if (level < depth) {
          for (const parent of parseCommit(obj.data).parents) queue.push([parent, level + 1]);
        }
      } else if (obj.type === 'tag') {
        const target = parseTag(obj.data).object;
        if (target) queue.push([target, level]);
      }
    }
    included = new Set();
    for (const [sha, level] of levels) {
      const obj = forge.get(sha);
      if (obj && obj.type === 'commit' && level <= depth) included.add(sha);
    }
  }
  let send;
  if (included) {
    send = new Set();
    for (const commitSha of included) {
      send.add(commitSha);
      const tree = forge.treeOfCommit(commitSha);
      if (tree) for (const sha of forge.objectClosure([tree])) send.add(sha);
    }
    for (const want of wants) {
      const obj = forge.get(want);
      if (obj && obj.type === 'tag') send.add(want);
    }
  } else {
    send = forge.objectClosure(wants.filter((want) => forge.has(want)), null);
  }
  const haveClosure = forge.objectClosure(haves.filter((have) => forge.has(have)), clientShallow);
  for (const sha of haveClosure) send.delete(sha);

  let includedCommits = included;
  if (!includedCommits) {
    includedCommits = forge.reachableCommits(
      wants.filter((want) => {
        const obj = forge.get(want);
        return obj && obj.type === 'commit';
      }),
    );
  }
  const shallowOut = [];
  const unshallowOut = [];
  if (depth != null || clientShallow.size > 0) {
    for (const commitSha of includedCommits) {
      const obj = forge.get(commitSha);
      if (!obj || obj.type !== 'commit') continue;
      const parents = parseCommit(obj.data).parents;
      if (parents.some((parent) => !includedCommits.has(parent) && forge.has(parent))) {
        shallowOut.push(commitSha);
      }
    }
    for (const commitSha of clientShallow) {
      if (!includedCommits.has(commitSha)) continue;
      const obj = forge.get(commitSha);
      if (!obj || obj.type !== 'commit') continue;
      if (parseCommit(obj.data).parents.every((parent) => includedCommits.has(parent))) {
        unshallowOut.push(commitSha);
      }
    }
  }

  const cacheKey = sha1hex(Buffer.from([...send].sort().join(','), 'utf8'));
  let pack = forge.packCache.get(cacheKey);
  if (!pack) {
    const objects = [...send]
      .map((sha) => forge.get(sha))
      .filter(Boolean)
      .map((obj) => ({ type: obj.type, data: obj.data }));
    objects.sort((a, b) => TYPE_ORDER[a.type] - TYPE_ORDER[b.type]);
    pack = buildPack(objects);
    if (forge.packCache.size > 128) forge.packCache.clear();
    forge.packCache.set(cacheKey, pack);
  }
  return { pack, shallowOut, unshallowOut };
}

function fetchV2(forge, repo, args) {
  const wants = [];
  const haves = [];
  const shallowClient = [];
  let depth = null;
  let deepenRelative = false;
  let done = false;
  for (const arg of args) {
    if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) shallowClient.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) depth = Number(arg.slice(7).trim());
    else if (arg === 'deepen-relative') deepenRelative = true;
    else if (arg === 'done') done = true;
  }
  if (!done) {
    // Negotiation round: acknowledge the haves we share and say we are ready. A client
    // whose negotiation is complete (git's fetch-pack, once every have is ACKed) then
    // expects the packfile section to follow in this same response, so it does.
    const parts = [pktLine('acknowledgments\n')];
    const common = haves.filter((have) => forge.has(have));
    if (common.length === 0) parts.push(pktLine('NAK\n'));
    else for (const have of common) parts.push(pktLine(`ACK ${have}\n`));
    parts.push(pktLine('ready\n'));
    parts.push(PKT_DELIM);
    parts.push(...packfileSection(forge, wants, haves, shallowClient, depth, deepenRelative));
    return Buffer.concat(parts);
  }
  return Buffer.concat(packfileSection(forge, wants, haves, shallowClient, depth, deepenRelative));
}

/** The shallow-info + packfile sections of a fetch response, ending in a flush. */
function packfileSection(forge, wants, haves, shallowClient, depth, deepenRelative = false) {
  const { pack, shallowOut, unshallowOut } = computeFetch(forge, wants, haves, shallowClient, depth, deepenRelative);
  const parts = [];
  if (shallowOut.length || unshallowOut.length) {
    parts.push(pktLine('shallow-info\n'));
    for (const sha of shallowOut) parts.push(pktLine(`shallow ${sha}\n`));
    for (const sha of unshallowOut) parts.push(pktLine(`unshallow ${sha}\n`));
    parts.push(PKT_DELIM);
  }
  parts.push(pktLine('packfile\n'));
  parts.push(...sidebandChunks(pack));
  parts.push(PKT_FLUSH);
  return parts;
}

function fetchV0(forge, repo, wants, haves, shallowClient, depth, deepenRelative = false) {
  const { pack, shallowOut, unshallowOut } = computeFetch(forge, wants, haves, shallowClient, depth, deepenRelative);
  const parts = [];
  for (const sha of shallowOut) parts.push(pktLine(`shallow ${sha}\n`));
  for (const sha of unshallowOut) parts.push(pktLine(`unshallow ${sha}\n`));
  parts.push(pktLine('NAK\n'));
  parts.push(...sidebandChunks(pack));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** POST /git-upload-pack: dispatch between the v2 commands and the v0 request shape. */
export function uploadPack(forge, repo, body) {
  const packets = parseAllPackets(body);
  const dataLines = packets.filter((packet) => packet.kind === 'data').map((packet) => packet.payload.toString('utf8').replace(/\n$/, ''));
  const commandLine = dataLines.find((line) => line.startsWith('command='));
  if (commandLine) {
    const command = commandLine.slice('command='.length);
    // Arguments are the data lines after the first delim packet.
    const delimIndex = packets.findIndex((packet) => packet.kind === 'delim');
    const argPackets = delimIndex >= 0 ? packets.slice(delimIndex + 1) : packets.slice(1);
    const args = argPackets
      .filter((packet) => packet.kind === 'data')
      .map((packet) => packet.payload.toString('utf8').replace(/\n$/, ''));
    if (command === 'ls-refs') {
      return { status: 200, contentType: 'application/x-git-upload-pack-result', body: lsRefs(forge, repo, args) };
    }
    if (command === 'fetch') {
      return { status: 200, contentType: 'application/x-git-upload-pack-result', body: fetchV2(forge, repo, args) };
    }
    return { status: 400, contentType: 'text/plain', body: Buffer.from(`unknown command ${command}\n`) };
  }
  // v0: two flush-separated sections; the first want line may carry capabilities.
  const wants = [];
  const haves = [];
  const shallowClient = [];
  let depth = null;
  let deepenRelative = false;
  let section = 0;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      section += 1;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (section === 0) {
      if (line.startsWith('want ')) wants.push(line.slice(5).trim().split(' ')[0]);
      else if (line.startsWith('shallow ')) shallowClient.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) depth = Number(line.slice(7).trim());
      else if (line === 'deepen-relative') deepenRelative = true;
    } else {
      if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    }
  }
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: fetchV0(forge, repo, wants, haves, shallowClient, depth, deepenRelative) };
}

// ---------------------------------------------------------------------------
// receive-pack (protocol v0)

function validateAndApply(forge, repo, command, unpackOk) {
  const { oldOid, newOid, ref } = command;
  if (!unpackOk) return { ref, ok: false, reason: 'unpack failed' };
  if (!ref.startsWith('refs/') || ref.includes('..') || ref.includes(' ')) {
    return { ref, ok: false, reason: 'invalid refname' };
  }
  const current = repo.refs.get(ref) ?? ZERO_OID;
  if (oldOid !== ZERO_OID && oldOid !== current) {
    return { ref, ok: false, reason: 'stale info' };
  }
  if (newOid === ZERO_OID) {
    repo.refs.delete(ref);
    return { ref, ok: true };
  }
  const obj = forge.get(newOid);
  if (!obj) return { ref, ok: false, reason: 'unknown object' };
  if (ref.startsWith('refs/heads/') && obj.type !== 'commit') {
    return { ref, ok: false, reason: 'invalid object type' };
  }
  if (current !== ZERO_OID && obj.type === 'commit') {
    const currentObj = forge.get(current);
    if (currentObj && currentObj.type === 'commit' && !forge.isAncestor(current, newOid)) {
      return { ref, ok: false, reason: 'non-fast-forward' };
    }
  }
  repo.refs.set(ref, newOid);
  return { ref, ok: true };
}

/** POST /git-receive-pack: parse the command list + packfile, apply, report. */
export function receivePack(forge, repo, body) {
  const { packets, next } = parsePktStream(body, 0);
  const dataPackets = packets.filter((packet) => packet.kind === 'data');
  const commands = [];
  let caps = new Set();
  dataPackets.forEach((packet, index) => {
    let line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (index === 0) {
      const nul = line.indexOf('\0');
      if (nul >= 0) {
        caps = new Set(line.slice(nul + 1).split(' ').filter(Boolean).map((cap) => cap.split('=')[0]));
        line = line.slice(0, nul);
      }
    }
    const parts = line.split(' ');
    if (parts.length >= 3) {
      commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts.slice(2).join(' ') });
    }
  });
  const packBytes = body.subarray(next);
  let unpackOk = true;
  let unpackDetail = 'ok';
  const wantsPack = commands.some((command) => command.newOid !== ZERO_OID);
  if (packBytes.length > 0) {
    try {
      parsePack(packBytes, (sha) => forge.get(sha), (type, data) => forge.put(type, data));
    } catch (err) {
      unpackOk = false;
      unpackDetail = `error ${err instanceof Error ? err.message : String(err)}`;
    }
  } else if (wantsPack) {
    unpackOk = false;
    unpackDetail = 'error no packfile';
  }
  const results = commands.map((command) => validateAndApply(forge, repo, command, unpackOk));
  const reportLines = [
    `unpack ${unpackOk ? 'ok' : unpackDetail}`,
    ...results.map((result) => (result.ok ? `ok ${result.ref}` : `ng ${result.ref} ${result.reason}`)),
  ];
  const inner = Buffer.concat([...reportLines.map((line) => pktLine(`${line}\n`)), PKT_FLUSH]);
  let out;
  if (caps.has('side-band-64k')) {
    out = Buffer.concat([...sidebandChunks(inner), PKT_FLUSH]);
  } else {
    out = inner;
  }
  return { status: 200, contentType: 'application/x-git-receive-pack-result', body: out };
}
