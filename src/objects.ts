// The git object model, in memory: sha1 identity, commit/tree/tag parsing and
// serialisation, pkt-line framing and packfile build/parse (including delta resolution).
// Standard library only: node:crypto for sha1, node:zlib for (de)compression.

import { createHash } from 'node:crypto';
import zlib from 'node:zlib';

export const ZERO_OID = '0000000000000000000000000000000000000000';

export function sha1hex(buf) {
  return createHash('sha1').update(buf).digest('hex');
}

/** The git object id: sha1 over "<type> <length>\0" followed by the raw payload. */
export function hashObject(type, data) {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1hex(Buffer.concat([header, data]));
}

export const TYPE_TO_NUM = { commit: 1, tree: 2, blob: 3, tag: 4 };
export const NUM_TO_TYPE = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag', 6: 'ofs-delta', 7: 'ref-delta' };

// ---------------------------------------------------------------------------
// commits

/** Parse a commit object into { tree, parents, author, committer, message }. */
export function parseCommit(data) {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split >= 0 ? text.slice(0, split) : text;
  const message = split >= 0 ? text.slice(split + 2) : '';
  let tree = null;
  const parents = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function serializeCommit({ tree, parents, author, committer, message }) {
  let out = `tree ${tree}\n`;
  for (const parent of parents ?? []) out += `parent ${parent}\n`;
  out += `author ${author}\ncommitter ${committer}\n\n${message ?? ''}`;
  return Buffer.from(out, 'utf8');
}

/** Parse an ident line "Name <email> 1700000000 +0000" into its parts. */
export function parseIdent(line) {
  const match = /^(.*?) <(.*?)> (\d+) ([+-]\d{4})$/.exec(line ?? '');
  if (!match) return { name: line ?? '', email: '', epochSec: 0, tz: '+0000' };
  return { name: match[1], email: match[2], epochSec: Number(match[3]), tz: match[4] };
}

/** Parse a tag object, returning the sha it points at (and its type/tag name). */
export function parseTag(data) {
  const text = data.toString('utf8');
  let object = null;
  let type = null;
  let tag = null;
  for (const line of text.split('\n')) {
    if (line === '') break;
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
  }
  return { object, type, tag };
}

// ---------------------------------------------------------------------------
// trees

/** Parse a tree object into [{ mode, name, oid }] in stored order. */
export function parseTree(data) {
  const entries = [];
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    if (sp < 0) break;
    const mode = data.subarray(off, sp).toString('ascii');
    const nul = data.indexOf(0x00, sp);
    if (nul < 0) break;
    const name = data.subarray(sp + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    off = nul + 21;
  }
  return entries;
}

export function isTreeMode(mode) {
  return mode === '40000' || mode === '040000';
}

/** Serialise tree entries, applying git's sort rule (directories sort as "name/"). */
export function serializeTree(entries) {
  const sorted = [...entries].sort((a, b) => {
    const an = a.name + (isTreeMode(a.mode) ? '/' : '');
    const bn = b.name + (isTreeMode(b.mode) ? '/' : '');
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// pkt-lines

/** Frame one payload as a pkt-line (4 hex digits of total length + payload). */
export function pktLine(payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const head = Buffer.from((body.length + 4).toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');
export const PKT_RESPONSE_END = Buffer.from('0002', 'ascii');

/**
 * Parse pkt-lines from `buf` starting at `start`. Stops after the first flush packet
 * (inclusive) or at end of buffer. Returns { packets, next } where each packet is
 * { kind: 'data'|'flush'|'delim'|'response-end', payload } and `next` is the offset of
 * the first unparsed byte. Throws on malformed framing.
 */
export function parsePktStream(buf, start = 0) {
  const packets = [];
  let off = start;
  while (off < buf.length) {
    if (off + 4 > buf.length) throw new Error('truncated pkt-line header');
    const head = buf.subarray(off, off + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) throw new Error(`bad pkt-line length ${JSON.stringify(head)}`);
    const len = parseInt(head, 16);
    if (len === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      off += 4;
      return { packets, next: off };
    }
    if (len === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      off += 4;
      continue;
    }
    if (len === 2) {
      packets.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      off += 4;
      continue;
    }
    if (len < 4 || off + len > buf.length) throw new Error('truncated pkt-line payload');
    packets.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
    off += len;
  }
  return { packets, next: off };
}

// ---------------------------------------------------------------------------
// packfiles

function encodePackObjectHeader(typeNum, size) {
  const bytes = [];
  let rest = Math.floor(size / 16);
  let first = (typeNum << 4) | (size & 0x0f);
  while (rest > 0) {
    bytes.push(first | 0x80);
    first = rest & 0x7f;
    rest = Math.floor(rest / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a version-2 packfile from full (non-delta) objects, in the given order. */
export function buildPack(objects) {
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  const parts = [header];
  for (const obj of objects) {
    parts.push(encodePackObjectHeader(TYPE_TO_NUM[obj.type], obj.data.length));
    parts.push(zlib.deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** Apply a git delta payload to a base payload. */
export function applyDelta(base, delta) {
  let off = 0;
  const readVarint = () => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[off];
      off += 1;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  readVarint(); // source size; the base is authoritative
  const targetSize = readVarint();
  const chunks = [];
  while (off < delta.length) {
    const op = delta[off];
    off += 1;
    if (op & 0x80) {
      let cpOff = 0;
      let cpSize = 0;
      if (op & 0x01) cpOff = delta[off++];
      if (op & 0x02) cpOff += delta[off++] * 2 ** 8;
      if (op & 0x04) cpOff += delta[off++] * 2 ** 16;
      if (op & 0x08) cpOff += delta[off++] * 2 ** 24;
      if (op & 0x10) cpSize = delta[off++];
      if (op & 0x20) cpSize += delta[off++] * 2 ** 8;
      if (op & 0x40) cpSize += delta[off++] * 2 ** 16;
      if (cpSize === 0) cpSize = 0x10000;
      chunks.push(base.subarray(cpOff, cpOff + cpSize));
    } else if (op > 0) {
      chunks.push(delta.subarray(off, off + op));
      off += op;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  const out = Buffer.concat(chunks);
  if (out.length !== targetSize) throw new Error('delta produced the wrong size');
  return out;
}

/**
 * Parse a packfile and resolve every entry, including ofs-delta and ref-delta chains
 * whose bases are earlier in the same pack or already in the store. Resolved objects
 * are handed to `putObject(type, data)` (which stores them and returns their sha).
 * Returns the number of objects in the pack. Throws on any malformed input.
 */
export function parsePack(buf, getObject, putObject) {
  if (buf.length < 12 + 20) throw new Error('packfile too short');
  if (buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('packfile has no PACK header');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  const dataEnd = buf.length - 20;
  let off = 12;
  const entries = []; // { start, typeNum, raw, baseOfs?, baseSha? }
  for (let i = 0; i < count; i += 1) {
    const start = off;
    let byte = buf[off];
    off += 1;
    const typeNum = (byte >> 4) & 0x07;
    // The size is not needed: zlib reports how many bytes it consumed.
    while (byte & 0x80) {
      byte = buf[off];
      off += 1;
    }
    let baseOfs = null;
    let baseSha = null;
    if (typeNum === 6) {
      // ofs-delta: a negative offset varint back to the base entry's start.
      let b = buf[off];
      off += 1;
      let offset = b & 0x7f;
      while (b & 0x80) {
        b = buf[off];
        off += 1;
        offset = (offset + 1) * 128 + (b & 0x7f);
      }
      baseOfs = start - offset;
    } else if (typeNum === 7) {
      baseSha = buf.subarray(off, off + 20).toString('hex');
      off += 20;
    }
    if (off >= dataEnd && count > 0 && !(off === dataEnd)) {
      // An entry may end exactly at dataEnd only after inflation; guard real overruns below.
      if (off > dataEnd) throw new Error('pack entry overruns the packfile');
    }
    const inflated = zlib.inflateSync(buf.subarray(off, dataEnd + 20), { info: true });
    const raw = inflated.buffer;
    off += inflated.engine.bytesWritten;
    entries.push({ start, typeNum, raw, baseOfs, baseSha });
  }
  const byStart = new Map(entries.map((entry) => [entry.start, entry]));
  const resolved = new Map(); // start -> { type, data }
  const resolve = (entry) => {
    if (resolved.has(entry.start)) return resolved.get(entry.start);
    let out;
    if (entry.typeNum === 6 || entry.typeNum === 7) {
      let base;
      if (entry.typeNum === 6) {
        const baseEntry = byStart.get(entry.baseOfs);
        if (!baseEntry) throw new Error('ofs-delta base is not in the pack');
        base = resolve(baseEntry);
      } else {
        const stored = getObject(entry.baseSha);
        if (stored) {
          base = stored;
        } else {
          const baseEntry = entries.find((candidate) => candidate.typeNum !== 6 && candidate.typeNum !== 7 && hashObject(NUM_TO_TYPE[candidate.typeNum], candidate.raw) === entry.baseSha)
            ?? entries.find((candidate) => {
              try {
                return hashObject(resolve(candidate).type, resolve(candidate).data) === entry.baseSha;
              } catch {
                return false;
              }
            });
          if (!baseEntry) throw new Error('ref-delta base is not available');
          base = resolve(baseEntry);
        }
      }
      out = { type: base.type, data: applyDelta(base.data, entry.raw) };
    } else {
      out = { type: NUM_TO_TYPE[entry.typeNum], data: entry.raw };
    }
    resolved.set(entry.start, out);
    return out;
  };
  for (const entry of entries) {
    const obj = resolve(entry);
    putObject(obj.type, obj.data);
  }
  return count;
}
