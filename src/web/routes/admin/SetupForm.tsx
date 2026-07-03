import { useState, type FormEvent } from "react";
import { api, ApiError } from "../../lib/api.ts";
import type { AppSettings, SettingsLimits } from "../../lib/types.ts";
import { ProcessingSettingsFields } from "./ProcessingSettingsFields.tsx";

export function SetupForm({
  onComplete,
  settingsDefaults,
  settingsLimits,
}: {
  onComplete: () => void;
  settingsDefaults: AppSettings;
  settingsLimits: SettingsLimits;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [setupToken, setSetupToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [settings, setSettings] = useState<AppSettings>(settingsDefaults);
  const [showAdvanced, setShowAdvanced] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    if (password.length < 12) {
      setError("Password must be at least 12 characters.");
      return;
    }
    if (password !== confirm) {
      setError("Passwords don't match.");
      return;
    }

    setSubmitting(true);
    try {
      // Only send settings the operator actually changed, so defaults aren't
      // pinned into the store on a plain setup.
      const changed = JSON.stringify(settings) !== JSON.stringify(settingsDefaults);
      await api.post("/api/setup", {
        email,
        password,
        setupToken: setupToken.trim(),
        ...(changed ? { settings } : {}),
      });
      onComplete();
    } catch (err) {
      if (err instanceof ApiError && err.message === "invalid_setup_token") {
        setError("That setup code isn't right. Find it in the installer output or your server logs.");
      } else {
        setError(err instanceof ApiError ? err.message : "Something went wrong. Try again.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthLayout title="Welcome to Lumina" subtitle="Create your admin account to get started.">
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <Field
          label="Setup code"
          htmlFor="setup-token"
          hint="Shown by the installer, or in your server logs as “LUMINA SETUP CODE”."
        >
          <input
            id="setup-token"
            type="text"
            required
            autoFocus
            value={setupToken}
            onChange={(e) => setSetupToken(e.target.value)}
            className="auth-input font-mono"
            autoComplete="off"
            spellCheck={false}
          />
        </Field>
        <Field label="Email" htmlFor="email">
          <input
            id="email"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="auth-input"
            autoComplete="email"
          />
        </Field>
        <Field label="Password" htmlFor="password" hint="At least 12 characters.">
          <input
            id="password"
            type="password"
            required
            minLength={12}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="auth-input"
            autoComplete="new-password"
          />
        </Field>
        <Field label="Confirm password" htmlFor="confirm">
          <input
            id="confirm"
            type="password"
            required
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            className="auth-input"
            autoComplete="new-password"
          />
        </Field>
        <div className="border-t border-line pt-3">
          <button
            type="button"
            onClick={() => setShowAdvanced((v) => !v)}
            aria-expanded={showAdvanced}
            className="flex w-full items-center justify-between text-sm font-medium text-text-2 transition-colors hover:text-text-1"
          >
            Advanced — processing &amp; uploads
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className={`h-4 w-4 transition-transform ${showAdvanced ? "rotate-180" : ""}`}
            >
              <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          {showAdvanced && (
            <div className="mt-4">
              <ProcessingSettingsFields
                value={settings}
                limits={settingsLimits}
                onChange={setSettings}
              />
              <p className="mt-3 text-xs text-text-3">
                Optional — you can change these any time from <b>App settings</b>.
              </p>
            </div>
          )}
        </div>
        {error && <p className="text-sm text-accent-500">{error}</p>}
        <button type="submit" disabled={submitting} className="auth-button">
          {submitting ? "Creating account…" : "Create account"}
        </button>
      </form>
    </AuthLayout>
  );
}

export function AuthLayout({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex h-screen w-screen items-center justify-center bg-canvas px-4">
      <div className="w-full max-w-sm rounded-2xl border border-line bg-surface p-8">
        <h1 className="font-display text-xl font-medium tracking-tight text-text-1">{title}</h1>
        <p className="mt-1 text-sm text-text-3">{subtitle}</p>
        <div className="mt-6">{children}</div>
      </div>
    </div>
  );
}

export function Field({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-sm font-medium text-text-2">
        {label}
      </label>
      {children}
      {hint && <span className="text-xs text-text-3">{hint}</span>}
    </div>
  );
}
