// Deterministic clock for the forge.
//
// The trial harness replays a run and compares the state export byte for byte, so no
// wall-clock reading may leak into anything the forge serves. Every timestamp the forge
// emits comes from this clock: it is seeded from MAKEFUN_TRIAL_NOW (the instance's
// opening time, the only "now" a trial carries) and advances exactly one second per
// tick, which keeps created_at / author dates monotonic in request order and identical
// across a live pass and its replay.

function seedBaseMs() {
  const raw = process.env.MAKEFUN_TRIAL_NOW;
  if (raw) {
    const text = String(raw).trim();
    const asNumber = Number(text);
    if (text !== '' && Number.isFinite(asNumber)) {
      // Epoch seconds are ~1.7e9, epoch milliseconds ~1.7e12.
      return asNumber < 1e12 ? asNumber * 1000 : asNumber;
    }
    const parsed = Date.parse(text);
    if (Number.isFinite(parsed)) return parsed;
  }
  // Local development without the harness: a fixed, documented epoch.
  return Date.UTC(2026, 0, 1, 0, 0, 0);
}

const baseMs = seedBaseMs();
let ticks = 0;

/** Advance the clock one second and return the new reading in epoch milliseconds. */
export function tickMs() {
  ticks += 1;
  return baseMs + ticks * 1000;
}

/** Advance the clock and return an ISO-8601 timestamp. */
export function tickIso() {
  return new Date(tickMs()).toISOString();
}

/** Advance the clock and return epoch seconds (for git ident lines). */
export function tickEpochSec() {
  return Math.floor(tickMs() / 1000);
}

/** Format an epoch-second reading as an ISO-8601 timestamp without advancing. */
export function isoFromEpochSec(sec) {
  return new Date(sec * 1000).toISOString();
}
