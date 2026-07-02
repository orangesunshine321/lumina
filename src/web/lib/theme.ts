export type Theme = "dark" | "light";

const STORAGE_KEY = "lumina-theme";

/** Dark is the product default; light is a persisted per-browser opt-in.
 * index.html applies the stored value inline before first paint — this
 * module is for reading/toggling after the app is up. */
export function getTheme(): Theme {
  try {
    return localStorage.getItem(STORAGE_KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

export function setTheme(theme: Theme): void {
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Private-mode storage failures shouldn't break theming for the session.
  }
  if (theme === "light") {
    document.documentElement.setAttribute("data-theme", "light");
  } else {
    document.documentElement.removeAttribute("data-theme");
  }
}

export function toggleTheme(): Theme {
  const next: Theme = getTheme() === "light" ? "dark" : "light";
  setTheme(next);
  return next;
}
