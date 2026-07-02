import { useEffect, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../../lib/api.ts";

export function AccountDialog({ email, onClose }: { email: string; onClose: () => void }) {
  const queryClient = useQueryClient();

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-30 flex items-center justify-center bg-ink-950/40 px-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Account settings"
        className="max-h-[85vh] w-full max-w-md overflow-y-auto rounded-2xl bg-white p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-ink-900">Account settings</h2>
            <p className="mt-0.5 truncate text-sm text-ink-400">{email}</p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="tap-target -mr-2 -mt-2 flex items-center justify-center rounded-lg text-ink-400 transition-colors hover:bg-ink-100 hover:text-ink-900"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4">
              <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <ChangePasswordForm />
        <div className="my-6 border-t border-ink-100" />
        <ChangeEmailForm
          onChanged={() => queryClient.invalidateQueries({ queryKey: ["admin-me"] })}
        />
      </div>
    </div>
  );
}

function ChangePasswordForm() {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(false);

    if (newPassword.length < 12) {
      setError("New password must be at least 12 characters.");
      return;
    }
    if (newPassword !== confirm) {
      setError("New passwords don't match.");
      return;
    }

    setSaving(true);
    try {
      await api.post("/api/admin/account/password", { currentPassword, newPassword });
      setSuccess(true);
      setCurrentPassword("");
      setNewPassword("");
      setConfirm("");
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        setError("Current password is incorrect.");
      } else {
        setError("Couldn't update the password. Try again.");
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="mt-6 flex flex-col gap-3">
      <h3 className="text-sm font-medium text-ink-900">Change password</h3>
      <DialogField
        id="current-password"
        label="Current password"
        type="password"
        value={currentPassword}
        onChange={setCurrentPassword}
        autoComplete="current-password"
      />
      <DialogField
        id="new-password"
        label="New password"
        type="password"
        value={newPassword}
        onChange={setNewPassword}
        autoComplete="new-password"
        hint="At least 12 characters."
      />
      <DialogField
        id="confirm-password"
        label="Confirm new password"
        type="password"
        value={confirm}
        onChange={setConfirm}
        autoComplete="new-password"
      />
      {error && <p className="text-sm text-accent-500">{error}</p>}
      {success && (
        <p className="text-sm text-ink-600">Password updated. Other devices have been signed out.</p>
      )}
      <button
        type="submit"
        disabled={saving || !currentPassword || !newPassword || !confirm}
        className="self-start rounded-lg bg-ink-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-ink-800 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {saving ? "Updating…" : "Update password"}
      </button>
    </form>
  );
}

function ChangeEmailForm({ onChanged }: { onChanged: () => void }) {
  const [password, setPassword] = useState("");
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(false);
    setSaving(true);
    try {
      await api.post("/api/admin/account/email", { password, email });
      setSuccess(true);
      setPassword("");
      setEmail("");
      onChanged();
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        setError("Password is incorrect.");
      } else if (err instanceof ApiError && err.status === 400) {
        setError("That doesn't look like a valid email address.");
      } else {
        setError("Couldn't update the email. Try again.");
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3">
      <h3 className="text-sm font-medium text-ink-900">Change email</h3>
      <DialogField
        id="account-email"
        label="New email"
        type="email"
        value={email}
        onChange={setEmail}
        autoComplete="email"
      />
      <DialogField
        id="email-password"
        label="Password"
        type="password"
        value={password}
        onChange={setPassword}
        autoComplete="current-password"
      />
      {error && <p className="text-sm text-accent-500">{error}</p>}
      {success && <p className="text-sm text-ink-600">Email updated.</p>}
      <button
        type="submit"
        disabled={saving || !password || !email}
        className="self-start rounded-lg border border-ink-200 px-4 py-2 text-sm font-medium text-ink-700 transition-colors hover:bg-ink-100 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {saving ? "Updating…" : "Update email"}
      </button>
    </form>
  );
}

function DialogField({
  id,
  label,
  type,
  value,
  onChange,
  autoComplete,
  hint,
}: {
  id: string;
  label: string;
  type: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete?: string;
  hint?: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-ink-700">
        {label}
      </label>
      <input
        id={id}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete={autoComplete}
        className="w-full rounded-lg border border-ink-200 px-3 py-2 text-sm text-ink-900 outline-none transition-colors focus:border-ink-900 focus:ring-2 focus:ring-ink-900/10"
      />
      {hint && <span className="text-xs text-ink-400">{hint}</span>}
    </div>
  );
}
