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
