// ui_common.js - Small UI helpers shared by the studio (app.js) and the Pack Builder (pack_builder.js)

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

export function showToast(message) {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.innerText = message;
  toast.style.opacity = '0';
  toast.style.transform = 'translateY(-6px)';
  toast.style.transition = 'opacity 160ms var(--ease-out), transform 160ms var(--ease-out)';
  container.appendChild(toast);
  requestAnimationFrame(() => {
    toast.style.opacity = '1';
    toast.style.transform = 'translateY(0)';
  });
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(-6px)';
    setTimeout(() => toast.remove(), 180);
  }, 3200);
}

/**
 * Wires the logo mode dropdown (open/close, keyboard, outside click, Escape).
 * onStudioClick(event, closeMenu), when given, handles clicks on the
 * "Studio" option; without it the option is a plain link.
 */
export function initModeDropdown({ onStudioClick } = {}) {
  const container = document.getElementById('logo-dropdown-container');
  const btnDropdown = document.getElementById('btn-mode-dropdown');
  const menu = document.getElementById('mode-dropdown-menu');
  const optStudio = document.getElementById('mode-opt-studio');
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
        if (r.type === 'attributes') describe(r.target);
        else r.addedNodes.forEach(scan);
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
