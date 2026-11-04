import { useEffect, useState } from 'react';

export type ConsoleTheme = 'dark' | 'light';
const storageKey = 'superbot:theme';

export function storedTheme(): ConsoleTheme {
  try {
    const value = localStorage.getItem(storageKey);
    if (value === 'dark' || value === 'light') return value;
  } catch {
    /* Storage can be unavailable; the console then starts dark. */
  }
  return 'dark';
}

/** Applies the console palette to <html> while the console is mounted and remembers the choice. */
export function useConsoleTheme() {
  const [theme, setTheme] = useState<ConsoleTheme>(storedTheme);
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.consoleTheme = theme;
    const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    const previousColor = meta?.content;
    if (meta) meta.content = theme === 'dark' ? '#0a0d0c' : '#f5f7f6';
    try {
      localStorage.setItem(storageKey, theme);
    } catch {
      /* Optional preference. */
    }
    return () => {
      delete root.dataset.consoleTheme;
      if (meta && previousColor) meta.content = previousColor;
    };
  }, [theme]);
  return [theme, setTheme] as const;
}
