import { useSyncExternalStore } from "react";

export type Theme = "light" | "dark";

const KEY = "cropcompass:theme";
const listeners = new Set<() => void>();

/** Dark is the default; index.html applies the saved choice before first paint to avoid a flash. */
function current(): Theme {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

export function setTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "dark" ? "#0c100f" : "#047857");
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // Storage can be blocked (private mode); the choice then lasts for this page only.
  }
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, current, () => "dark");
}
