// ui_common.js - Small UI helpers shared by the studio (app.js) and the Pack Builder (pack_builder.js)

/**
 * Joins a folder on the engine's computer with names below it, using that computer's
 * separator throughout: a Windows folder (drive letter or any backslash) gets
 * backslashes only, anything else forward slashes.
 */
export function joinLocalPath(dir, ...names) {
  const base = String(dir ?? '');
  const windows = /^[A-Za-z]:/.test(base) || base.includes('\\');
  const sep = windows ? '\\' : '/';
  const fix = (p) => (windows ? String(p).replace(/\//g, sep) : String(p));
  const head = fix(base).replace(/[\\/]+$/, '');
  const rest = names.map((n) => fix(n).replace(/^[\\/]+|[\\/]+$/g, '')).filter(Boolean);
  return [head, ...rest].join(sep);
}

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

/** A count with its word: "1 line", "2 lines", "0 lines". */
export function plural(n, word) {
  return `${n} ${n === 1 ? word : `${word}s`}`;
}

/**
 * Reads text out to screen readers through the hidden #sr-announcer live region.
 * The region is emptied first and filled on the next tick, so the same words said
 * twice in a row are read twice.
 */
export function announce(text) {
  const region = document.getElementById('sr-announcer');
  if (!region) return;
  region.textContent = '';
  setTimeout(() => { region.textContent = text; }, 0);
}

const MAX_TOASTS = 3;

/**
 * Shows a short message at the bottom of the window; at most 3 at once, the oldest goes.
 * tone 'error' is for something the user has to know went wrong: it is announced at once
 * and stays until its Close button is pressed. The entrance motion lives in style.css.
 * action {label, onClick} adds a button that runs onClick and closes the toast ("Undo").
 * duration is how long it shows (3.2 s by default). A toast waits while it is hovered or
 * has focus, then shows for its full duration again. Returns the toast, so its caller can
 * close it early (toast.remove()).
 */
export function showToast(message, { tone, action, duration = 3200 } = {}) {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = 'toast';
  if (action && tone !== 'error') {
    const text = document.createElement('span');
    text.className = 'toast-message';
    text.textContent = message;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-ghost btn-xs toast-action';
    btn.textContent = action.label;
    btn.addEventListener('click', () => {
      toast.remove();
      action.onClick();
    });
    toast.append(text, btn);
  } else if (tone === 'error') {
    toast.classList.add('toast-error');
    toast.setAttribute('role', 'alert');
    const text = document.createElement('span');
    text.className = 'toast-message';
    text.textContent = message;
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'btn btn-ghost btn-xs toast-close';
    close.textContent = 'Close';
    close.addEventListener('click', () => toast.remove());
    toast.append(text, close);
  } else {
    toast.innerText = message;
  }
  container.appendChild(toast);
  const shown = container.querySelectorAll('.toast');
  for (let i = 0; i < shown.length - MAX_TOASTS; i++) shown[i].remove();
  if (tone === 'error') return toast;
  let timer = null;
  let hovered = false;
  const wait = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      toast.classList.add('is-leaving');
      setTimeout(() => toast.remove(), 180);
    }, duration);
  };
  const hold = () => clearTimeout(timer);
  const resume = () => {
    if (!hovered && !toast.contains(document.activeElement)) wait();
  };
  toast.addEventListener('pointerenter', () => { hovered = true; hold(); });
  toast.addEventListener('pointerleave', () => { hovered = false; resume(); });
  toast.addEventListener('focusin', hold);
  toast.addEventListener('focusout', () => setTimeout(resume, 0));
  wait();
  return toast;
}

/**
 * Wires the logo mode dropdown (open/close, keyboard, outside click, Escape).
 * onStudioClick(event, closeMenu), when given, handles clicks on the
 * "Studio" option; without it the option is a plain link.
 */
export function initModeDropdown({ onStudioClick, onAboutClick } = {}) {
  const container = document.getElementById('logo-dropdown-container');
  const btnDropdown = document.getElementById('btn-mode-dropdown');
  const menu = document.getElementById('mode-dropdown-menu');
  const optStudio = document.getElementById('mode-opt-studio');
  const optAbout = document.getElementById('mode-opt-about');
  if (!container || !btnDropdown || !menu) return;

  const toggleMenu = (show) => {
    const isCurrentlyOpen = container.classList.contains('open');
    const target = (typeof show === 'boolean') ? show : !isCurrentlyOpen;
    if (target) {
      container.classList.add('open');
      menu.style.display = 'flex';
      btnDropdown.setAttribute('aria-expanded', 'true');
    } else {
      container.classList.remove('open');
      menu.style.display = 'none';
      btnDropdown.setAttribute('aria-expanded', 'false');
    }
  };

  btnDropdown.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleMenu();
  });

  btnDropdown.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
      e.preventDefault();
      toggleMenu(true);
    }
  });

  if (optStudio && onStudioClick) {
    optStudio.addEventListener('click', (e) => onStudioClick(e, () => toggleMenu(false)));
  }

  // About opens a dialog; when it closes, focus goes back to the menu button.
  if (optAbout && onAboutClick) {
    optAbout.addEventListener('click', () => {
      toggleMenu(false);
      onAboutClick(btnDropdown);
    });
  }

  document.addEventListener('click', (e) => {
    if (!container.contains(e.target)) {
      toggleMenu(false);
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && container.classList.contains('open')) {
      toggleMenu(false);
      btnDropdown.focus();
    }
  });
}

/**
 * Tooltips for any element with a data-tip attribute. One floating element is
 * positioned in JS because many triggers sit inside cards that clip overflow.
 * Shows on hover and on keyboard focus (:focus-visible); Escape hides it.
 * For screen readers the text is mirrored into aria-label when the trigger has
 * no name of its own, otherwise into a hidden description via aria-describedby.
 * Safe to call more than once.
 */
export function initTooltips(root = document) {
  if (!root || !root.body || root.getElementById('dm-tip')) return;

  const tip = root.createElement('div');
  tip.id = 'dm-tip';
  tip.className = 'dm-tip';
  tip.setAttribute('role', 'tooltip');
  tip.setAttribute('aria-hidden', 'true');
  root.body.appendChild(tip);

  const descs = root.createElement('div');
  descs.id = 'dm-tip-descriptions';
  descs.hidden = true;
  root.body.appendChild(descs);

  let seq = 0;
  let current = null;

  // Text a screen reader would read as the element's name (skips aria-hidden parts and icons).
  const visibleText = (node) => {
    let out = '';
    node.childNodes.forEach((c) => {
      if (c.nodeType === 3) out += c.nodeValue;
      else if (c.nodeType === 1 && c.getAttribute('aria-hidden') !== 'true' && c.localName !== 'svg') out += visibleText(c);
    });
    return out;
  };

  const describe = (el) => {
    const text = el.getAttribute('data-tip') || '';
    if (!text && !el.dataset.tipDesc && el.dataset.tipLabel !== '1') return;
    if (el.dataset.tipLabel === '1' || (!el.hasAttribute('aria-label') && !el.hasAttribute('aria-labelledby') && !visibleText(el).trim())) {
      el.setAttribute('aria-label', text);
      el.dataset.tipLabel = '1';
      return;
    }
    // A tip that only repeats the accessible name would be read twice.
    if (text && text === el.getAttribute('aria-label')) return;
    let id = el.dataset.tipDesc;
    let node = id ? root.getElementById(id) : null;
    if (!node) {
      id = `dm-tip-desc-${++seq}`;
      node = root.createElement('span');
      node.id = id;
      descs.appendChild(node);
      el.dataset.tipDesc = id;
      const ids = (el.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean);
      if (!ids.includes(id)) el.setAttribute('aria-describedby', [...ids, id].join(' '));
    }
    node.textContent = text;
  };

  const scan = (node) => {
    if (!node || node.nodeType !== 1) return;
    if (node.hasAttribute('data-tip')) describe(node);
    node.querySelectorAll('[data-tip]').forEach(describe);
  };
  scan(root.body);

  if (typeof MutationObserver !== 'undefined') {
    new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === 'attributes') {
          describe(r.target);
          // A control whose tip follows its state (the record button) updates the open tip.
          if (r.target === current) show(current);
        } else r.addedNodes.forEach(scan);
      }
    }).observe(root.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-tip'] });
  }

  const hide = () => {
    current = null;
    tip.classList.remove('is-visible');
  };

  const show = (el) => {
    const text = el.getAttribute('data-tip');
    if (!text) return;
    current = el;
    tip.textContent = text;
    tip.classList.add('is-visible');
    const win = root.defaultView;
    const r = el.getBoundingClientRect();
    const t = tip.getBoundingClientRect();
    const gap = 8;
    let top = r.top - t.height - gap;
    if (top < 4) top = r.bottom + gap;
    let left = r.left + r.width / 2 - t.width / 2;
    left = Math.max(6, Math.min(left, win.innerWidth - t.width - 6));
    tip.style.top = `${Math.round(top)}px`;
    tip.style.left = `${Math.round(left)}px`;
  };

  const triggerOf = (target) => (target && target.closest ? target.closest('[data-tip]') : null);

  root.addEventListener('pointerover', (e) => {
    const el = triggerOf(e.target);
    if (el && el !== current) show(el);
  });
  root.addEventListener('pointerout', (e) => {
    const el = triggerOf(e.target);
    if (el && el === current && !el.contains(e.relatedTarget)) hide();
  });
  root.addEventListener('focusin', (e) => {
    const el = triggerOf(e.target);
    if (!el) return;
    let keyboard = true;
    try { keyboard = e.target.matches(':focus-visible'); } catch (_) { /* older engines */ }
    if (keyboard) show(el);
  });
  root.addEventListener('focusout', (e) => {
    if (triggerOf(e.target) === current) hide();
  });
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && current) hide();
  });
  root.addEventListener('pointerdown', hide);
  // A control pressed from the keyboard keeps its focus, so its tip would stay up over
  // what it opened (Audio settings).
  root.addEventListener('click', hide);
  root.defaultView.addEventListener('scroll', hide, true);
}

/**
 * Copies every own prototype property of each Source onto Target.prototype
 * (getters/setters included). Refuses to overwrite an existing name.
 */
export function mixin(Target, ...Sources) {
  for (const Source of Sources) {
    for (const name of Reflect.ownKeys(Source.prototype)) {
      if (name === 'constructor') continue;
      if (Object.prototype.hasOwnProperty.call(Target.prototype, name)) {
        throw new Error(`mixin: ${String(name)} already defined`);
      }
      Object.defineProperty(Target.prototype, name, Object.getOwnPropertyDescriptor(Source.prototype, name));
    }
  }
  return Target;
}

let openDialogCount = 0;

/** True while a dialog opened by openDialog() is showing. */
export function isDialogOpen() {
  return openDialogCount > 0;
}

const FOCUSABLE = 'a[href], summary, button:not([disabled]), input:not([disabled]), select:not([disabled]), '
  + 'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Shows a modal overlay: focuses its first control, keeps Tab / Shift+Tab inside,
 * closes on Escape or a click on the backdrop (the overlay itself), and gives
 * focus back to returnFocus. While canClose() is false, Escape and the backdrop do
 * nothing (the export modal while it saves). Returns close().
 */
export function openDialog(overlay, { returnFocus = document.activeElement, canClose = () => true } = {}) {
  const doc = overlay.ownerDocument;
  const focusables = () => Array.from(overlay.querySelectorAll(FOCUSABLE)).filter((el) => !el.closest('[hidden]'));
  let isOpen = true;

  const onKeydown = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (canClose()) close();
      return;
    }
    if (e.key !== 'Tab') return;
    const items = focusables();
    if (!items.length) {
      e.preventDefault();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = doc.activeElement;
    if (e.shiftKey && (active === first || !overlay.contains(active))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || !overlay.contains(active))) {
      e.preventDefault();
      first.focus();
    }
  };
  const onClick = (e) => {
    if (e.target === overlay && canClose()) close();
  };

  function close() {
    if (!isOpen) return;
    isOpen = false;
    openDialogCount -= 1;
    doc.removeEventListener('keydown', onKeydown, true);
    overlay.removeEventListener('click', onClick);
    overlay.classList.remove('is-open');
    overlay.hidden = true;
    if (returnFocus && typeof returnFocus.focus === 'function' && returnFocus.isConnected) returnFocus.focus();
  }

  openDialogCount += 1;
  overlay.hidden = false;
  overlay.classList.add('is-open');
  // Capture phase, so Escape closes only this dialog and not what is behind it.
  doc.addEventListener('keydown', onKeydown, true);
  overlay.addEventListener('click', onClick);
  const first = focusables()[0];
  if (first) first.focus();
  return close;
}
