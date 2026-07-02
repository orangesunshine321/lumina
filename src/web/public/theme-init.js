// Applies the persisted theme before first paint (dark is the default).
// External file, not inline, so a strict script-src 'self' CSP needs no hash.
try {
  if (localStorage.getItem("pixset-theme") === "light") {
    document.documentElement.setAttribute("data-theme", "light");
  }
} catch (e) {}
