import { useState, type FormEvent } from "react";
import { api, ApiError } from "../../lib/api.ts";
import { AuthLayout, Field } from "../admin/SetupForm.tsx";

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
        setError("Incorrect password. Try again.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthLayout title={title ?? "This gallery is private"} subtitle="Enter the password to view your photos.">
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <Field label="Password" htmlFor="gallery-password">
          <input
            id="gallery-password"
            type="password"
            required
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="auth-input"
            autoComplete="current-password"
          />
        </Field>
        {error && <p className="text-sm text-accent-500">{error}</p>}
        <button type="submit" disabled={submitting} className="auth-button">
          {submitting ? "Checking…" : "View gallery"}
        </button>
      </form>
    </AuthLayout>
  );
}
