import { useState, type FormEvent } from "react";
import { api, ApiError } from "../../lib/api.ts";

/** A client's first impression is often this screen — a velvet rope, not a
 * login form: quiet canvas, display-type title, one field on a soft surface. */
export function PasswordGate({
  slug,
  title,
  onUnlocked,
}: {
  slug: string;
  title?: string;
  onUnlocked: () => void;
}) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await api.post(`/api/gallery/${slug}/unlock`, { password });
      onUnlocked();
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) {
        const retryAfter = (err.body as { retryAfterSeconds?: number } | null)?.retryAfterSeconds;
        setError(
          retryAfter
            ? `Too many attempts. Try again in ${Math.ceil(retryAfter / 60)} min.`
            : "Too many attempts. Try again later.",
        );
      } else {
        setError("That password isn't right. Try again.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen w-screen flex-col items-center justify-center bg-canvas px-4">
      <div className="w-full max-w-sm text-center">
        <p className="text-[11px] font-medium uppercase tracking-[0.2em] text-text-3">
          Private gallery
        </p>
        <h1 className="mt-3 font-display text-3xl font-light tracking-wide text-text-1 sm:text-4xl">
          {title ?? "Your photos"}
        </h1>
        <p className="mt-3 text-sm text-text-2">
          Enter the password your photographer shared with you.
        </p>

        <form
          onSubmit={handleSubmit}
          className="mt-8 flex flex-col gap-3 rounded-2xl border border-line bg-surface p-6 text-left shadow-lg shadow-black/10"
        >
          <label htmlFor="gallery-password" className="sr-only">
            Gallery password
          </label>
          <input
            id="gallery-password"
            type="password"
            required
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
            className="auth-input py-2.5 text-center"
            autoComplete="current-password"
          />
          {error && <p className="text-center text-sm text-accent-500">{error}</p>}
          <button type="submit" disabled={submitting} className="auth-button">
            {submitting ? "Checking…" : "View gallery"}
          </button>
        </form>
      </div>
    </div>
  );
}
