// studio/takes.js - Reads a line's takes out of room state. Every take lookup in the
// studio goes through these, so the state shape can change in one place.
// Pure functions: no DOM, no app state.

// Room state version this client understands (checked from step 5 of the take model).
export const TAKE_STATE_VERSION = 2;

/** The take used in the dub for this line, or undefined. */
export function pickedTake(takes, line) {
  if (!takes || !line) return undefined;
  return takes[line.index];
}

/** Every take of this line, oldest first. */
export function lineTakes(takes, line) {
  const take = pickedTake(takes, line);
  return take ? [take] : [];
}

export function takeCount(takes, line) {
  return lineTakes(takes, line).length;
}

/** The take's audio URL without its cache-busting ?v=, or null. */
export function takeAudioKey(take) {
  if (!take || !take.url) return null;
  return take.url.split('?v=')[0];
}
