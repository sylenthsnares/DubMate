// studio/line_strip.js - The booth bar's line strip (#timeline-chips): one row of
// fixed-width chips that scrolls sideways inside the 44 px bar. It draws no scrollbar
// (that would eat the bar's height); edge fades say there's more, and the wheel, a
// mouse drag and the arrow keys move along it. booth.js renders the chips.

const SLACK = 1;      // px: a strip within this of an end is at that end
const DRAG_PX = 4;    // a mouse has to move further than this before a press becomes a drag
const LINE_PX = 16;   // one wheel "line" (deltaMode 1)

/** Whether the strip can still scroll towards dir (-1 back, 1 forward). */
export function canScroll(strip, dir) {
  const max = strip.scrollWidth - strip.clientWidth;
  if (max <= SLACK) return false;
  return dir < 0 ? strip.scrollLeft > SLACK : strip.scrollLeft < max - SLACK;
}

/** The edge fades: one at each end the strip can still scroll towards. */
export function updateStripEdges(strip) {
  strip.classList.toggle('fade-start', canScroll(strip, -1));
  strip.classList.toggle('fade-end', canScroll(strip, 1));
}

function chipShows(strip, chip) {
  const left = chip.offsetLeft, right = left + chip.offsetWidth;
  return left >= strip.scrollLeft && right <= strip.scrollLeft + strip.clientWidth;
}

/** Centres the chip in the strip. Only the strip moves (scrollIntoView would scroll the
 *  page as well). A near step glides; a far one, or with reduced motion, jumps. */
export function centreChip(strip, chip, { onlyIfHidden = false } = {}) {
  if (!chip || !strip.clientWidth) return;
  if (onlyIfHidden && chipShows(strip, chip)) return;
  const max = Math.max(0, strip.scrollWidth - strip.clientWidth);
  const left = Math.max(0, Math.min(max, Math.round(chip.offsetLeft - (strip.clientWidth - chip.offsetWidth) / 2)));
  if (Math.abs(left - strip.scrollLeft) < 1) return;
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const far = Math.abs(left - strip.scrollLeft) > strip.clientWidth * 1.5;
  const behavior = onlyIfHidden || reduce || far ? 'auto' : 'smooth';
  if (typeof strip.scrollTo === 'function') strip.scrollTo({ left, behavior });
  else strip.scrollLeft = left;
  updateStripEdges(strip);
}

/** Brings a chip fully into view (past the fades) without centring it. */
function revealChip(strip, chip) {
  const fade = 24;
  const left = chip.offsetLeft, right = left + chip.offsetWidth;
  if (left - fade < strip.scrollLeft) strip.scrollLeft = left - fade;
  else if (right + fade > strip.scrollLeft + strip.clientWidth) strip.scrollLeft = right + fade - strip.clientWidth;
  updateStripEdges(strip);
}

/** Moves focus to a chip and makes it the strip's one tab stop. */
export function focusChip(strip, chip) {
  if (!chip) return;
  for (const c of strip.querySelectorAll('.chip-item[tabindex="0"]')) if (c !== chip) c.tabIndex = -1;
  chip.tabIndex = 0;
  chip.focus({ preventScroll: true });
  revealChip(strip, chip);
}

/** Wires the strip once: wheel, drag, keys, fades, and keeping the current chip in view
 *  when the strip changes size (a resize, the booth opening). */
export function initLineStrip(strip) {
  if (!strip || strip.dataset.stripReady) return;
  strip.dataset.stripReady = '1';

  strip.addEventListener('scroll', () => updateStripEdges(strip), { passive: true });

  // A vertical wheel scrolls the strip sideways, but only while it can move: at an end,
  // or when it all fits, the wheel is left alone. Sideways wheels and trackpads scroll
  // the strip natively; Ctrl+wheel is zoom.
  strip.addEventListener('wheel', (e) => {
    if (e.ctrlKey || Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return;
    const dir = Math.sign(e.deltaY);
    if (!canScroll(strip, dir)) return;
    e.preventDefault();
    const scale = e.deltaMode === 1 ? LINE_PX : e.deltaMode === 2 ? strip.clientWidth : 1;
    strip.scrollLeft += e.deltaY * scale;
    updateStripEdges(strip);
  }, { passive: false });

  // A mouse drag scrolls it too; the click that ends a drag doesn't pick a line.
  let drag = null;
  let swallowClick = false;
  strip.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || (e.pointerType && e.pointerType !== 'mouse')) return;
    drag = { x: e.clientX, left: strip.scrollLeft, id: e.pointerId, moved: false };
  });
  strip.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    if (!drag.moved) {
      if (Math.abs(dx) <= DRAG_PX || !canScroll(strip, -Math.sign(dx))) return;
      drag.moved = true;
      strip.classList.add('is-dragging');
      try { strip.setPointerCapture?.(drag.id); } catch (err) { /* pointer already gone */ }
    }
    strip.scrollLeft = drag.left - dx;
    updateStripEdges(strip);
  });
  const endDrag = () => {
    if (drag?.moved) {
      swallowClick = true;
      setTimeout(() => { swallowClick = false; }, 0);
    }
    drag = null;
    strip.classList.remove('is-dragging');
  };
  strip.addEventListener('pointerup', endDrag);
  strip.addEventListener('pointercancel', endDrag);
  strip.addEventListener('click', (e) => {
    if (!swallowClick) return;
    swallowClick = false;
    e.preventDefault();
    e.stopPropagation();
  }, true);

  // One tab stop (the current chip); the arrows, Home and End move along the strip.
  strip.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const chips = [...strip.querySelectorAll('.chip-item')];
    const at = chips.indexOf(e.target.closest?.('.chip-item'));
    if (at < 0) return;
    const to = { ArrowLeft: at - 1, ArrowRight: at + 1, Home: 0, End: chips.length - 1 }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    focusChip(strip, chips[Math.max(0, Math.min(chips.length - 1, to))]);
  });

  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(() => {
      centreChip(strip, strip.querySelector('.chip-item[aria-current]'), { onlyIfHidden: true });
      updateStripEdges(strip);
    }).observe(strip);
  }
}
