// studio/takes.js - Reads a line's takes out of room state. Every take lookup in the
// studio goes through these, so the state shape can change in one place.
// Pure functions: no DOM, no app state.

// Room state version this client understands. A tab loaded before a DubMate update
// stops applying state from a server with a different version. 3: takes and the room
// carry voice chains, and the booth edits them (rooms.CLIENT_STATE_VERSION).
export const TAKE_STATE_VERSION = 3;

// Room state keeps takes by stable line ID:
// takes[line.line_id] = { picked: take_id, next_number, takes: [take, ...] oldest first }.

/** The take used in the dub for this line, or undefined. */
export function pickedTake(takes, line) {
  const entry = takes && line ? takes[line.line_id] : undefined;
  if (!entry) return undefined;
  return (entry.takes || []).find((t) => t.take_id === entry.picked);
}

/** Every take of this line, oldest first. */
export function lineTakes(takes, line) {
  const entry = takes && line ? takes[line.line_id] : undefined;
  return (entry && entry.takes) || [];
}

export function takeCount(takes, line) {
  return lineTakes(takes, line).length;
}

/** How well a take follows the original line's timing, in words: "Tight sync" from 0.8,
 *  "Good sync" from 0.6, "Loose sync" below, "–" when it wasn't measured. Negative
 *  scores come from older takes and count as not measured. */
export function syncWords(score) {
  if (typeof score !== 'number' || !Number.isFinite(score) || score < 0) return '–';
  if (score >= 0.8) return 'Tight sync';
  return score >= 0.6 ? 'Good sync' : 'Loose sync';
}

/** The take's audio URL without its cache-busting ?v=, or null. */
export function takeAudioKey(take) {
  if (!take || !take.url) return null;
  return take.url.split('?v=')[0];
}
