// studio/level_target.js - The one level target shared by the Audio settings meter, its hint
// and "Check your loudest line": a shout should peak between -10 and -6 dB (dBFS peak).
// Pure, no DOM, so the node tests can import it.

export const LEVEL_GOOD_MIN_DB = -10;
export const LEVEL_GOOD_MAX_DB = -6;
// Below this peak nobody spoke.
export const LEVEL_QUIET_PEAK_DB = -45;

const HINTS = {
  neutral: 'Say your loudest line. Aim for the green band.',
  attention: 'A bit quiet. Move closer or turn the mic up.',
  done: 'Good level.',
  error: 'Too loud. Move back from the mic or turn down its input level.',
};

/** Which band of the meter a peak falls in: 'quiet' | 'good' | 'loud'. */
export function levelZone(db) {
  if (typeof db !== 'number' || Number.isNaN(db) || db < LEVEL_GOOD_MIN_DB) return 'quiet';
  return db > LEVEL_GOOD_MAX_DB ? 'loud' : 'good';
}

/**
 * The meter's hint for the loudest peak of the last few seconds: {text, tone}, tone being
 * 'neutral' | 'attention' | 'done' | 'error'.
 */
export function levelHint(windowMaxDb) {
  let tone = 'neutral';
  if (typeof windowMaxDb === 'number' && windowMaxDb >= LEVEL_QUIET_PEAK_DB) {
    tone = { quiet: 'attention', good: 'done', loud: 'error' }[levelZone(windowMaxDb)];
  }
  return { text: HINTS[tone], tone };
}
