// Light / dark theme, remembered in the browser.

const KEY = "wd:theme";

function apply(dark) {
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? "#121316" : "#f4f1ea");
}

export function initTheme() {
  let saved = null;
  try {
    saved = localStorage.getItem(KEY);
  } catch {
    /* private mode */
  }
  apply(saved ? saved === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches);
}

export const isDark = () => document.documentElement.dataset.theme === "dark";

export function toggleTheme() {
  const dark = !isDark();
  const root = document.documentElement;
  root.classList.add("theme-fade");
  setTimeout(() => root.classList.remove("theme-fade"), 450);
  apply(dark);
  try {
    localStorage.setItem(KEY, dark ? "dark" : "light");
  } catch {
    /* ignore */
  }
  return dark;
}
