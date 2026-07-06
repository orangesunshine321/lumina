import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../../lib/api.ts";
import type {
  CloudflareProvisionResult,
  CloudflareVerifyResponse,
  NetworkStatusResponse,
  SelfTestResult,
  SettingsResponse,
} from "../../lib/types.ts";
import { caddySnippet, cloudflareManualSteps, nginxSnippet, tailscaleSnippet } from "../../lib/networkSnippets.ts";
import { copyText } from "../../lib/clipboard.ts";

type Method = "cloudflare" | "tailscale" | "caddy" | "nginx";

/** Bare hostname from a base URL / domain input, for prefilling snippets. */
function toHostname(input: string): string {
  return input.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/:\d+$/, "");
}

export function PublicAccessDialog({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const settings = useQuery({
    queryKey: ["admin-settings"],
    queryFn: () => api.get<SettingsResponse>("/api/admin/settings"),
  });
  const configuredDomain = settings.data?.settings.publicBaseUrl ?? "";

  const [method, setMethod] = useState<Method>("cloudflare");

  return (
    <div className="fixed inset-0 z-30 flex items-start justify-center overflow-y-auto bg-black/60 px-4 py-8" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Public access"
        className="w-full max-w-2xl rounded-2xl border border-line-strong bg-surface-2 p-6 shadow-xl shadow-black/30"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold text-text-1">Public access &amp; domain</h2>
            <p className="mt-0.5 text-sm text-text-3">
              Put your gallery on the internet and point your own domain at it.
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="tap-target -mr-2 -mt-2 flex items-center justify-center rounded-lg text-text-3 transition-colors hover:bg-surface-3 hover:text-text-1"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4">
              <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <div className="mt-6 flex flex-col gap-6">
          <DomainSection configuredDomain={configuredDomain} loading={settings.isLoading} />
          <DiagnosticsSection configuredDomain={configuredDomain} />

          <div>
            <h3 className="text-sm font-semibold text-text-1">Connect it to the internet</h3>
            <p className="mt-0.5 text-xs text-text-3">
              Lumina runs on your machine and can&apos;t open your firewall itself — pick one of these and
              run it on your host. The app generates everything you need to paste.
            </p>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {(
                [
                  ["cloudflare", "Cloudflare Tunnel"],
                  ["tailscale", "Tailscale"],
                  ["caddy", "Caddy"],
                  ["nginx", "Nginx"],
                ] as [Method, string][]
              ).map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => setMethod(key)}
                  className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                    method === key
                      ? "bg-text-1 text-invert"
                      : "border border-line text-text-2 hover:bg-surface-3 hover:text-text-1"
                  }`}
                >
                  {label}
                  {key === "cloudflare" && (
                    <span className={method === key ? "ml-1.5 opacity-70" : "ml-1.5 text-text-3"}>· easiest</span>
                  )}
                </button>
              ))}
            </div>

            <div className="mt-4">
              {method === "cloudflare" && <CloudflareSection defaultHostname={toHostname(configuredDomain)} />}
              {method === "tailscale" && (
                <SimpleMethod
                  intro="Zero open ports, HTTPS included. Best if this is mostly you and a few clients. Enable HTTPS + Funnel for your tailnet in the Tailscale admin console, then run:"
                  snippet={tailscaleSnippet()}
                  note="Your gallery lands on a *.ts.net address. Set that as your public URL above (or map your own domain to it with a CNAME)."
                />
              )}
              {method === "caddy" && (
                <SimpleMethod
                  intro="If you run a VPS or a box with a public IP, Caddy gives you automatic HTTPS with a two-line config. Point your domain's DNS at the host first, then add to your Caddyfile:"
                  snippet={caddySnippet(toHostname(configuredDomain))}
                  note="Caddy fetches a certificate automatically on first request."
                />
              )}
              {method === "nginx" && (
                <SimpleMethod
                  intro="Prefer Nginx? Point your domain at the host, get a cert (e.g. certbot), then use this server block:"
                  snippet={nginxSnippet(toHostname(configuredDomain))}
                  note="proxy_buffering off keeps large gallery-zip downloads streaming instead of buffering in memory."
                />
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// --- Custom domain ---------------------------------------------------------

function DomainSection({ configuredDomain, loading }: { configuredDomain: string; loading: boolean }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const value = draft ?? configuredDomain;

  async function save() {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const attempted = value.trim();
      const res = await api.patch<SettingsResponse>("/api/admin/settings", { publicBaseUrl: attempted });
      queryClient.setQueryData(["admin-settings"], res);
      const normalized = res.settings.publicBaseUrl;
      // The server normalizes/rejects the input. If a non-empty entry came back
      // empty, it wasn't a usable public URL — surface that instead of a
      // misleading "Saved ✓", and keep their text on screen so they can fix it.
      if (attempted && !normalized) {
        setError("That doesn't look like a valid public URL. Use something like https://gallery.example.com.");
        return;
      }
      setDraft(normalized);
      setSaved(true);
      setTimeout(() => setSaved(false), 1600);
    } catch {
      setError("Couldn't save. Try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <label htmlFor="public-base-url" className="text-sm font-semibold text-text-1">
        Your public URL
      </label>
      <p className="mt-0.5 text-xs text-text-3">
        Used for the copyable share link and any link in your selection webhook. Leave blank to use whatever
        address you&apos;re browsing on.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <input
          id="public-base-url"
          type="url"
          inputMode="url"
          placeholder="https://gallery.example.com"
          value={loading ? "" : value}
          disabled={loading}
          onChange={(e) => setDraft(e.target.value)}
          className="min-w-0 flex-1 rounded-lg border border-line bg-canvas px-3 py-2 text-sm text-text-1 outline-none focus:border-line-strong"
          autoComplete="off"
          spellCheck={false}
        />
        <button
          onClick={() => void save()}
          disabled={saving || loading || value.trim() === configuredDomain.trim()}
          className="shrink-0 rounded-lg bg-text-1 px-4 py-2 text-sm font-medium text-invert transition-opacity hover:opacity-85 disabled:opacity-40"
        >
          {saving ? "Saving…" : saved ? "Saved ✓" : "Save"}
        </button>
      </div>
      {error && <p className="mt-2 text-xs text-accent-500">{error}</p>}
      <p className="mt-2 text-xs text-text-3">
        A bare domain works too — <code className="rounded bg-surface-2 px-1">gallery.example.com</code>{" "}
        becomes <code className="rounded bg-surface-2 px-1">https://gallery.example.com</code>.
      </p>
    </div>
  );
}

// --- Diagnostics + self-test ----------------------------------------------

function DiagnosticsSection({ configuredDomain }: { configuredDomain: string }) {
  const status = useQuery({
    queryKey: ["network-status"],
    queryFn: () => api.get<NetworkStatusResponse>("/api/admin/network/status"),
  });
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<SelfTestResult | null>(null);
  const [testError, setTestError] = useState<string | null>(null);

  const d = status.data?.diagnostics;

  async function runTest() {
    setTesting(true);
    setTestError(null);
    setResult(null);
    try {
      const res = await api.post<{ result: SelfTestResult }>("/api/admin/network/self-test", {
        url: configuredDomain || undefined,
      });
      setResult(res.result);
    } catch (err) {
      if (err instanceof ApiError && err.message === "no_public_url") {
        setTestError("Set a public URL above first, then run the test.");
      } else {
        setTestError("Test couldn't run. Try again.");
      }
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-text-1">Status</h3>
        <button
          onClick={() => void runTest()}
          disabled={testing}
          className="shrink-0 rounded-lg border border-line px-3 py-1.5 text-xs font-medium text-text-1 transition-colors hover:bg-surface-2 disabled:opacity-50"
        >
          {testing ? "Testing…" : "Test public URL"}
        </button>
      </div>

      {status.isLoading && <p className="mt-2 text-xs text-text-3">Checking…</p>}
      {d && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          <Pill ok={d.behindProxy} okLabel="Behind a proxy" badLabel="Directly exposed / no proxy detected" />
          {d.behindCloudflare && <Pill ok label="Cloudflare detected" />}
          <Pill ok={d.httpsUpstream} okLabel="HTTPS upstream" badLabel="No HTTPS detected" />
          <Pill
            ok={d.trustProxy}
            okLabel="Trusting proxy headers"
            badLabel="Not trusting proxy headers (TRUST_PROXY off)"
          />
          <Pill ok={d.secureCookies} okLabel="Secure cookies" badLabel="Cookies not marked Secure" />
        </div>
      )}
      {d && (
        <p className="mt-2 text-xs text-text-3">
          Seen as <code className="rounded bg-surface-2 px-1">{d.observedProto ?? "?"}://{d.observedHost ?? "?"}</code>
          {" · "}client IP <code className="rounded bg-surface-2 px-1">{d.clientIp}</code>
        </p>
      )}
      {d && d.behindProxy && !d.trustProxy && (
        <p className="mt-2 text-xs text-accent-400">
          You look proxied but <code className="rounded bg-surface-2 px-1">TRUST_PROXY</code> is off — set it to{" "}
          <code className="rounded bg-surface-2 px-1">true</code> in your <code className="rounded bg-surface-2 px-1">.env</code>{" "}
          so rate-limiting keys on the real client IP.
        </p>
      )}

      {testError && <p className="mt-3 text-xs text-accent-500">{testError}</p>}
      {result && (
        <div
          className={`mt-3 rounded-lg border px-3 py-2 text-xs ${
            result.ok ? "border-positive-500/30 bg-positive-500/10 text-positive-400" : "border-accent-500/30 bg-accent-500/10 text-accent-400"
          }`}
        >
          {result.ok ? (
            <>Reachable at <code className="rounded bg-black/20 px-1">{result.url}</code> and it&apos;s this instance ✓ ({result.durationMs}ms)</>
          ) : result.reachable && !result.matchedThisInstance ? (
            <>Something answered at that URL, but it isn&apos;t this Lumina — check the hostname points here.</>
          ) : (
            <>Couldn&apos;t reach <code className="rounded bg-black/20 px-1">{result.url}</code>{result.error ? ` — ${result.error}` : ""}. The tunnel/proxy may not be running yet.</>
          )}
        </div>
      )}
    </div>
  );
}

function Pill({ ok, label, okLabel, badLabel }: { ok: boolean; label?: string; okLabel?: string; badLabel?: string }) {
  const text = label ?? (ok ? okLabel : badLabel) ?? "";
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${
        ok ? "bg-positive-500/12 text-positive-400" : "bg-surface-3 text-text-3"
      }`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${ok ? "bg-positive-400" : "bg-text-3"}`} />
      {text}
    </span>
  );
}

// --- Cloudflare express + manual -------------------------------------------

function CloudflareSection({ defaultHostname }: { defaultHostname: string }) {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<"express" | "manual">("express");
  const [apiToken, setApiToken] = useState("");
  const [verify, setVerify] = useState<CloudflareVerifyResponse | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [hostname, setHostname] = useState(defaultHostname);
  const [tunnelName, setTunnelName] = useState("lumina");
  const [provisioning, setProvisioning] = useState(false);
  const [result, setResult] = useState<CloudflareProvisionResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const manual = cloudflareManualSteps();

  async function doVerify() {
    setVerifying(true);
    setError(null);
    setVerify(null);
    try {
      const res = await api.post<CloudflareVerifyResponse>("/api/admin/network/cloudflare/verify", { apiToken });
      setVerify(res);
      // Deliberately DON'T prefill the hostname with the bare zone name: that
      // led to accidentally provisioning the apex (e.g. example.com) instead of
      // a subdomain. Leave it empty with a subdomain placeholder to fill in.
    } catch (err) {
      setError(err instanceof ApiError ? cfMessage(err) : "Couldn't verify the token.");
    } finally {
      setVerifying(false);
    }
  }

  async function doProvision() {
    setProvisioning(true);
    setError(null);
    setResult(null);
    try {
      const res = await api.post<{ result: CloudflareProvisionResult }>("/api/admin/network/cloudflare/provision", {
        apiToken,
        hostname,
        tunnelName,
      });
      setResult(res.result);
      // Drop the token from memory once we're done with it, and the form below
      // hides itself (gated on !result) so a stray second click can't provision
      // a second tunnel and repoint DNS away from the one they're about to run.
      setApiToken("");
      // publicBaseUrl was updated server-side; refresh so share links pick it up.
      void queryClient.invalidateQueries({ queryKey: ["admin-settings"] });
    } catch (err) {
      setError(err instanceof ApiError ? cfMessage(err) : "Provisioning failed.");
    } finally {
      setProvisioning(false);
    }
  }

  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <div className="flex gap-1.5">
        <ModeTab active={mode === "express"} onClick={() => setMode("express")}>
          Express (recommended)
        </ModeTab>
        <ModeTab active={mode === "manual"} onClick={() => setMode("manual")}>
          Do it myself
        </ModeTab>
      </div>

      {mode === "express" ? (
        <div className="mt-4 flex flex-col gap-3">
          <p className="text-xs text-text-3">
            Paste a Cloudflare API token and Lumina will create the tunnel, its route, and the DNS record for you,
            then hand you one command to run. Requires your domain&apos;s DNS to be on Cloudflare.{" "}
            <span className="text-text-2">Your token is used once and never saved.</span>
          </p>
          <a
            href="https://dash.cloudflare.com/profile/api-tokens"
            target="_blank"
            rel="noreferrer"
            className="text-xs font-medium text-text-1 underline underline-offset-2"
          >
            Create a token → use the “Edit Cloudflare Tunnel” template, add your zone&apos;s DNS edit permission
          </a>

          <div className="flex flex-wrap items-center gap-2">
            <input
              type="password"
              placeholder="Cloudflare API token"
              value={apiToken}
              onChange={(e) => setApiToken(e.target.value)}
              className="min-w-0 flex-1 rounded-lg border border-line bg-canvas px-3 py-2 font-mono text-sm text-text-1 outline-none focus:border-line-strong"
              autoComplete="off"
              spellCheck={false}
            />
            <button
              onClick={() => void doVerify()}
              disabled={verifying || apiToken.trim().length === 0}
              className="shrink-0 rounded-lg border border-line px-3 py-2 text-sm font-medium text-text-1 transition-colors hover:bg-surface-2 disabled:opacity-40"
            >
              {verifying ? "Checking…" : "Verify"}
            </button>
          </div>

          {verify && !result && (
            <div className="flex flex-col gap-3 rounded-lg border border-line bg-surface-2 p-3">
              <p className="text-xs text-text-2">
                Token OK — {verify.zones.length} {verify.zones.length === 1 ? "domain" : "domains"} available
                {verify.zones.length > 0 && <>: {verify.zones.map((z) => z.name).join(", ")}</>}
              </p>
              <label className="text-xs font-medium text-text-2">
                Public hostname
                <input
                  type="text"
                  placeholder={verify.zones[0] ? `gallery.${verify.zones[0].name}` : "gallery.example.com"}
                  value={hostname}
                  onChange={(e) => setHostname(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-line bg-canvas px-3 py-2 text-sm text-text-1 outline-none focus:border-line-strong"
                  autoComplete="off"
                  spellCheck={false}
                />
                <span className="mt-1 block text-[11px] font-normal text-text-3">
                  Use a subdomain like the example — typing just{" "}
                  {verify.zones[0] ? verify.zones[0].name : "your domain"} would publish on the bare apex.
                </span>
              </label>
              <label className="text-xs font-medium text-text-2">
                Tunnel name
                <input
                  type="text"
                  value={tunnelName}
                  onChange={(e) => setTunnelName(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-line bg-canvas px-3 py-2 text-sm text-text-1 outline-none focus:border-line-strong"
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
              <button
                onClick={() => void doProvision()}
                disabled={provisioning || hostname.trim().length === 0}
                className="rounded-lg bg-text-1 px-4 py-2 text-sm font-medium text-invert transition-opacity hover:opacity-85 disabled:opacity-40"
              >
                {provisioning ? "Creating tunnel…" : "Create tunnel & DNS"}
              </button>
            </div>
          )}

          {result && (
            <div className="flex flex-col gap-3 rounded-lg border border-positive-500/30 bg-positive-500/10 p-3">
              <p className="text-xs font-medium text-positive-400">
                Tunnel created for {result.hostname} ✓ &nbsp;One step left — run this on your host:
              </p>
              <CopyBlock label="Add to your .env" value={result.envLine} secret />
              <CopyBlock label="Then run" value={result.command} />
              <p className="text-xs text-text-3">
                Once it&apos;s up, use <b>Test public URL</b> above to confirm. Your share links now use{" "}
                <code className="rounded bg-black/20 px-1">{result.publicBaseUrl}</code>.
              </p>
            </div>
          )}
        </div>
      ) : (
        <div className="mt-4 flex flex-col gap-3">
          <ol className="list-decimal space-y-1.5 pl-4 text-xs text-text-2">
            <li>
              In the{" "}
              <a href="https://one.dash.cloudflare.com/" target="_blank" rel="noreferrer" className="font-medium text-text-1 underline underline-offset-2">
                Zero Trust dashboard
              </a>{" "}
              → Networks → Tunnels, create a tunnel and copy its token.
            </li>
            <li>
              Add a public hostname route on that tunnel pointing at{" "}
              <code className="rounded bg-surface-2 px-1">http://app:3000</code>.
            </li>
            <li>Put the token in your .env and start the tunnel container:</li>
          </ol>
          <CopyBlock label="Add to your .env" value={manual.env} />
          <CopyBlock label="Then run" value={manual.command} />
        </div>
      )}

      {error && <p className="mt-3 text-xs text-accent-500">{error}</p>}
    </div>
  );
}

function ModeTab({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
        active ? "bg-surface-3 text-text-1" : "text-text-3 hover:text-text-1"
      }`}
    >
      {children}
    </button>
  );
}

// --- Simple (snippet-only) methods -----------------------------------------

function SimpleMethod({ intro, snippet, note }: { intro: string; snippet: string; note: string }) {
  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <p className="text-xs text-text-2">{intro}</p>
      <div className="mt-3">
        <CopyBlock value={snippet} />
      </div>
      <p className="mt-2 text-xs text-text-3">{note}</p>
    </div>
  );
}

// --- Copy helpers ----------------------------------------------------------

function CopyBlock({ value, label, secret = false }: { value: string; label?: string; secret?: boolean }) {
  const [copied, setCopied] = useState(false);
  const [revealed, setRevealed] = useState(!secret);
  const shown = useMemo(() => (revealed ? value : value.replace(/.(?=.{4})/g, "•")), [revealed, value]);

  async function copy() {
    // Reveal a masked secret before copying so the fallback textarea path (used
    // in insecure/LAN contexts) copies the real value, and only confirm on
    // actual success — navigator.clipboard is absent over plain HTTP.
    if (!revealed) setRevealed(true);
    const ok = await copyText(value);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  }

  return (
    <div>
      {label && <p className="mb-1 text-xs font-medium text-text-3">{label}</p>}
      <div className="flex items-stretch gap-2">
        <pre className="min-w-0 flex-1 overflow-x-auto rounded-lg border border-line bg-canvas px-3 py-2 font-mono text-xs text-text-1">
          {shown}
        </pre>
        <div className="flex shrink-0 flex-col gap-1">
          <button
            onClick={() => void copy()}
            className="rounded-lg bg-text-1 px-3 py-1.5 text-xs font-medium text-invert transition-opacity hover:opacity-85"
          >
            {copied ? "Copied" : "Copy"}
          </button>
          {secret && (
            <button
              onClick={() => setRevealed((v) => !v)}
              className="rounded-lg border border-line px-3 py-1.5 text-xs font-medium text-text-2 transition-colors hover:bg-surface-2"
            >
              {revealed ? "Hide" : "Show"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function cfMessage(err: ApiError): string {
  const body = err.body as { message?: string; error?: string } | null;
  if (body?.message) return body.message;
  if (err.message === "missing_token") return "Enter your Cloudflare API token.";
  if (err.message === "missing_hostname") return "Enter a hostname.";
  return "Cloudflare request failed.";
}
