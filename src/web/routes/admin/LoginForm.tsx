import { useState, type FormEvent } from "react";
import { api, ApiError } from "../../lib/api.ts";
import { AuthLayout, Field } from "./SetupForm.tsx";

export function LoginForm({ onComplete }: { onComplete: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [needsCode, setNeedsCode] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await api.post("/api/admin/login", {
        email,
        password,
        ...(needsCode && code.trim() ? { code: code.trim() } : {}),
      });
      onComplete();
    } catch (err) {
      if (err instanceof ApiError && err.message === "totp_required") {
        // Password was right — now ask for the second factor.
        setNeedsCode(true);
        setError(null);
      } else if (err instanceof ApiError && err.message === "invalid_code") {
        setNeedsCode(true);
        setError("That code isn't right. Try the current one from your app, or a backup code.");
      } else if (err instanceof ApiError && err.status === 429) {
        const retryAfter = (err.body as { retryAfterSeconds?: number } | null)?.retryAfterSeconds;
        setError(
          retryAfter
            ? `Too many attempts. Try again in ${Math.ceil(retryAfter / 60)} min.`
            : "Too many attempts. Try again later.",
        );
      } else {
        setError("Incorrect email or password.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthLayout title="Sign in" subtitle="Welcome back to your Lumina admin.">
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <Field label="Email" htmlFor="login-email">
          <input
            id="login-email"
            type="email"
            required
            autoFocus
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="auth-input"
            autoComplete="email"
          />
        </Field>
        <Field label="Password" htmlFor="login-password">
          <input
            id="login-password"
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="auth-input"
            autoComplete="current-password"
          />
        </Field>
        {needsCode && (
          <Field label="Authentication code" htmlFor="login-code" hint="From your authenticator app, or a backup code.">
            <input
              id="login-code"
              type="text"
              required
              autoFocus
              value={code}
              onChange={(e) => setCode(e.target.value)}
              className="auth-input font-mono"
              autoComplete="one-time-code"
              spellCheck={false}
            />
          </Field>
        )}
        {error && <p className="text-sm text-accent-500">{error}</p>}
        <button type="submit" disabled={submitting} className="auth-button">
          {submitting ? "Signing in…" : needsCode ? "Verify" : "Sign in"}
        </button>
      </form>
    </AuthLayout>
  );
}
