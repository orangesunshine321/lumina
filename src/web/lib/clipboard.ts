/**
 * Copy text to the clipboard, resiliently. `navigator.clipboard` is undefined
 * in insecure contexts (e.g. http://192.168.x.x — exactly where the public-access
 * wizard is used before HTTPS exists), so fall back to a hidden-textarea +
 * execCommand copy there. Returns whether the copy succeeded so callers can
 * avoid showing a false "Copied" confirmation.
 */
export async function copyText(value: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // fall through to the legacy path
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = value;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "-9999px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
