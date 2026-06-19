// App theme (dark default / light "report" aesthetic). The chosen class lives on
// <html>; both variants are defined as CSS-variable blocks in index.css.

export type ThemeName = "dark" | "light";

const KEY = "ftdc.theme";

export function getTheme(): ThemeName {
  try {
    return localStorage.getItem(KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

export function applyTheme(t: ThemeName): void {
  const el = document.documentElement;
  el.classList.remove("dark", "light");
  el.classList.add(t);
  try {
    localStorage.setItem(KEY, t);
  } catch {
    /* best-effort persistence */
  }
}

export function nextTheme(t: ThemeName): ThemeName {
  return t === "dark" ? "light" : "dark";
}
