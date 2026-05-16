// Theme store — persists base color theme + dark mode to localStorage
// Migrated to Preact Signals
import { signal, effect } from '@preact/signals-core';

export type BaseTheme =
  | 'neutral' | 'stone' | 'zinc' | 'gray'
  | 'amber' | 'blue' | 'cyan' | 'emerald' | 'fuchsia' | 'green'
  | 'indigo' | 'lime' | 'orange' | 'pink' | 'purple' | 'red'
  | 'rose' | 'sky' | 'teal' | 'violet';

const THEME_KEY = 'ribbit_base_theme';
const DARK_KEY = 'ribbit_dark_mode';

const VALID_THEMES: Set<string> = new Set([
  'neutral', 'stone', 'zinc', 'gray',
  'amber', 'blue', 'cyan', 'emerald', 'fuchsia', 'green',
  'indigo', 'lime', 'orange', 'pink', 'purple', 'red',
  'rose', 'sky', 'teal', 'violet',
]);

// ─── Signals ───

export const baseTheme = signal<BaseTheme>('lime');
export const darkMode = signal<boolean>(false);

// ─── Actions ───

export function getBaseTheme(): BaseTheme { return baseTheme.value; }

export function setBaseTheme(theme: BaseTheme) {
  localStorage.setItem(THEME_KEY, theme);
  baseTheme.value = theme;
  applyTheme();
}

export function isDarkMode(): boolean { return darkMode.value; }

export function setDarkMode(dark: boolean) {
  localStorage.setItem(DARK_KEY, String(dark));
  darkMode.value = dark;
  applyTheme();
}

export function toggleDarkMode() {
  setDarkMode(!darkMode.value);
}

export function applyTheme() {
  const html = document.documentElement;
  const dark = darkMode.value;
  const base = baseTheme.value;

  if (dark) html.classList.add('dark');
  else html.classList.remove('dark');

  Array.from(html.classList)
    .filter((c) => c.startsWith('theme-'))
    .forEach((c) => html.classList.remove(c));
  if (base !== 'neutral') html.classList.add(`theme-${base}`);
}

// Migrate from old 'theme' key used by the previous ThemeToggle
function migrateOldKey() {
  const old = localStorage.getItem('theme');
  if (old && localStorage.getItem(DARK_KEY) === null) {
    localStorage.setItem(DARK_KEY, old === 'dark' ? 'true' : 'false');
    localStorage.removeItem('theme');
  }
  // Migrate removed identity themes to their closest match
  const stored = localStorage.getItem(THEME_KEY);
  if (stored === 'ribbit') localStorage.setItem(THEME_KEY, 'emerald');
  else if (stored === 'nostr') localStorage.setItem(THEME_KEY, 'violet');
  else if (stored === 'bitcoin') localStorage.setItem(THEME_KEY, 'orange');
}

// Initialize on load
export function initTheme() {
  migrateOldKey();
  // Load stored values into signals
  const storedTheme = localStorage.getItem(THEME_KEY);
  if (storedTheme && VALID_THEMES.has(storedTheme)) baseTheme.value = storedTheme as BaseTheme;
  const storedDark = localStorage.getItem(DARK_KEY);
  if (storedDark !== null) darkMode.value = storedDark === 'true';
  else darkMode.value = window.matchMedia('(prefers-color-scheme: dark)').matches;
  applyTheme();
}

// ─── Legacy compat ───

const _legacyListeners: Set<() => void> = new Set();
let _bridgeActive = false;

export function subscribeTheme(fn: () => void): () => void {
  _legacyListeners.add(fn);
  if (!_bridgeActive) {
    _bridgeActive = true;
    effect(() => {
      baseTheme.value; darkMode.value;
      for (const fn of _legacyListeners) fn();
    });
  }
  return () => { _legacyListeners.delete(fn); };
}
