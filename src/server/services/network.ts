import { randomBytes } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { config } from "../config.ts";
import { getClientIp } from "../lib/http.ts";

/**
 * Networking / public-access helpers for the admin "Public access" wizard.
 *
 * The app runs in a deliberately hardened container (read-only root fs, no
 * Docker socket, only ./data mounted), so it *cannot* apply any of this itself —
 * it can only DIAGNOSE (read the request headers it's receiving), VERIFY
 * (loop-back self-test against its own public URL), and DRIVE THE CLOUDFLARE API
 * on the operator's behalf, handing back a token + command for them to paste.
 * Nothing here ever writes compose/.env or starts a container.
 */

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// ---------------------------------------------------------------------------
// Proxy diagnostics — what does the outside world look like from in here?
// ---------------------------------------------------------------------------

export interface ProxyDiagnostics {
  /** The operator-configured custom origin (or "" if none). */
  publicBaseUrl: string;
  /** Host header as received (post-proxy). */
  observedHost: string | null;
  /** Effective scheme the request arrived as (X-Forwarded-Proto or socket). */
  observedProto: string | null;
  forwardedFor: string | null;
  cfConnectingIp: string | null;
  cfRay: string | null;
  via: string | null;
  /** Any forwarding header present → something is in front of us. */
  behindProxy: boolean;
  /** CF-Ray present → specifically Cloudflare. */
  behindCloudflare: boolean;
  /** Request arrived as https upstream (needed for Secure cookies to be sent). */
  httpsUpstream: boolean;
  /** config.trustProxy — whether we parse X-Forwarded-* / CF-Connecting-IP. */
  trustProxy: boolean;
  /** config.isProduction — whether cookies are marked Secure. */
  secureCookies: boolean;
  /** The client IP we'd key rate-limiting on, given the current trust settings. */
  clientIp: string;
}

export function buildProxyDiagnostics(request: FastifyRequest, publicBaseUrl: string): ProxyDiagnostics {
  const h = request.headers;
  const forwardedFor = str(h["x-forwarded-for"]);
  const cfConnectingIp = str(h["cf-connecting-ip"]);
  const cfRay = str(h["cf-ray"]);
  const via = str(h["via"]);
  const observedProto = str(h["x-forwarded-proto"]) ?? request.protocol ?? null;
  const behindCloudflare = cfRay !== null;
  const behindProxy = behindCloudflare || forwardedFor !== null || via !== null;
  return {
    publicBaseUrl,
    observedHost: str(h["host"]),
    observedProto,
    forwardedFor,
    cfConnectingIp,
    cfRay,
    via,
    behindProxy,
    behindCloudflare,
    httpsUpstream: observedProto === "https",
    trustProxy: config.trustProxy,
    secureCookies: config.isProduction,
    clientIp: getClientIp(request),
  };
}

// ---------------------------------------------------------------------------
// Connectivity self-test — fetch our own public URL and prove it loops back
// to THIS instance via a one-time nonce echoed by GET /api/network/ping.
// ---------------------------------------------------------------------------

const pendingProbes = new Set<string>();
const PROBE_TTL_MS = 30_000;

function registerProbe(nonce: string): void {
  pendingProbes.add(nonce);
  const t = setTimeout(() => pendingProbes.delete(nonce), PROBE_TTL_MS);
  // Don't keep the event loop alive just for a probe's expiry timer.
  (t as { unref?: () => void }).unref?.();
}

/** Returns true (and consumes) if this nonce was issued by a live self-test. */
export function consumeProbe(nonce: string): boolean {
  if (pendingProbes.has(nonce)) {
    pendingProbes.delete(nonce);
    return true;
  }
  return false;
}

export interface SelfTestResult {
  /** Reached the app AND confirmed it's this instance. */
  ok: boolean;
  url: string;
  reachable: boolean;
  status: number | null;
  https: boolean;
  /** The loop-back nonce came back — the public URL really points at us. */
  matchedThisInstance: boolean;
  error: string | null;
  durationMs: number;
}

export async function runSelfTest(baseUrl: string): Promise<SelfTestResult> {
  const base = baseUrl.replace(/\/+$/, "");
  const nonce = randomBytes(16).toString("hex");
  const url = `${base}/api/network/ping`;
  const https = base.toLowerCase().startsWith("https:");
  const started = Date.now();
  registerProbe(nonce);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(`${url}?probe=${nonce}`, {
      signal: controller.signal,
      redirect: "manual",
      headers: { "user-agent": "Lumina-SelfTest" },
    });
    const body = (await res.json().catch(() => null)) as { matched?: boolean } | null;
    const matched = Boolean(body?.matched);
    return {
      ok: res.ok && matched,
      url,
      reachable: true,
      status: res.status,
      https,
      matchedThisInstance: matched,
      error: res.ok ? (matched ? null : "reached_a_server_but_not_this_instance") : `HTTP ${res.status}`,
      durationMs: Date.now() - started,
    };
  } catch (err) {
    consumeProbe(nonce); // never fired — reclaim it
    return {
      ok: false,
      url,
      reachable: false,
      status: null,
      https,
      matchedThisInstance: false,
      error: errMessage(err),
      durationMs: Date.now() - started,
    };
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// Cloudflare API — express tunnel provisioning. The API token is passed in per
// request and NEVER persisted (a stored token would leak into DB backups).
// ---------------------------------------------------------------------------

const CF_API = "https://api.cloudflare.com/client/v4";
/** Where the tunnel forwards to inside the compose network. */
const TUNNEL_SERVICE = "http://app:3000";

export class CloudflareError extends Error {}

async function cfFetch(apiToken: string, method: string, path: string, body?: unknown): Promise<unknown> {
  const controller = new AbortController();
  // Keep the abort timer live across BOTH the fetch and the body read — a
  // server that returns headers then stalls the body would otherwise hang this
  // (admin) request indefinitely.
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(`${CF_API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const json = (await res.json().catch(() => null)) as
      | { success?: boolean; result?: unknown; errors?: { message?: string }[] }
      | null;
    if (!json || json.success !== true) {
      const msg =
        json?.errors?.map((e) => e.message).filter(Boolean).join("; ") || `Cloudflare returned HTTP ${res.status}`;
      throw new CloudflareError(msg);
    }
    return json.result;
  } catch (err) {
    if (err instanceof CloudflareError) throw err;
    throw new CloudflareError(`Couldn't reach Cloudflare: ${errMessage(err)}`);
  } finally {
    clearTimeout(timeout);
  }
}

interface CfZone {
  id: string;
  name: string;
  accountId: string;
  accountName: string;
}

async function cfListZones(apiToken: string): Promise<CfZone[]> {
  // /zones caps per_page at 50, so an account with more than 50 zones needs
  // pagination — otherwise the operator's domain can be in the un-fetched tail
  // and provisioning wrongly reports "no zone found". Page until a short page;
  // hard-cap at 20 pages (1000 zones) as a runaway guard.
  const zones: CfZone[] = [];
  for (let page = 1; page <= 20; page++) {
    const raw = (await cfFetch(apiToken, "GET", `/zones?per_page=50&page=${page}`)) as
      | { id: string; name: string; account?: { id?: string; name?: string } }[]
      | null;
    const batch = raw ?? [];
    for (const z of batch) {
      zones.push({ id: z.id, name: z.name, accountId: z.account?.id ?? "", accountName: z.account?.name ?? "" });
    }
    if (batch.length < 50) break;
  }
  return zones;
}

export interface CloudflareVerifyResult {
  accounts: { id: string; name: string }[];
  zones: { id: string; name: string; accountId: string; accountName: string }[];
}

/** Confirm the token works and list the domains (zones) it can manage, so the
 * UI can tell the operator whether their domain is on Cloudflare at all. */
export async function cfVerifyToken(apiToken: string): Promise<CloudflareVerifyResult> {
  await cfFetch(apiToken, "GET", "/user/tokens/verify"); // throws CloudflareError if invalid
  const zones = await cfListZones(apiToken);
  const accounts = new Map<string, string>();
  for (const z of zones) if (z.accountId) accounts.set(z.accountId, z.accountName);
  return {
    accounts: [...accounts].map(([id, name]) => ({ id, name })),
    zones,
  };
}

/** Strip scheme/path and lowercase → a bare hostname, or "" if unusable. */
function toHostname(input: string): string {
  const cleaned = input.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/:\d+$/, "");
  return cleaned;
}

export interface CloudflareProvisionResult {
  hostname: string;
  zoneName: string;
  tunnelId: string;
  tunnelName: string;
  tunnelToken: string;
}

/**
 * Create a named Cloudflare tunnel with a remotely-managed config, point its
 * ingress at the app, and upsert a proxied CNAME so `hostname` routes through
 * the tunnel. Returns the connector token the operator pastes into their .env.
 */
export async function cfProvisionTunnel(
  apiToken: string,
  hostnameInput: string,
  tunnelName: string,
): Promise<CloudflareProvisionResult> {
  const hostname = toHostname(hostnameInput);
  if (!hostname || !hostname.includes(".")) {
    throw new CloudflareError("Enter a full hostname like gallery.example.com");
  }

  // Pick the zone whose name is the longest suffix of the hostname.
  const zones = await cfListZones(apiToken);
  const zone = zones
    .filter((z) => hostname === z.name || hostname.endsWith(`.${z.name}`))
    .sort((a, b) => b.name.length - a.name.length)[0];
  if (!zone) {
    throw new CloudflareError(
      `No Cloudflare zone found for ${hostname}. Add the domain to your Cloudflare account first, or use the manual setup instead.`,
    );
  }

  // Idempotency: reuse a tunnel that already has this name (from an earlier run
  // or a double-click) instead of creating a duplicate. Its connector token is
  // stable, so re-running yields the same token + the same DNS target.
  const acct = zone.accountId;
  const existingTunnels = (await cfFetch(
    apiToken,
    "GET",
    `/accounts/${acct}/cfd_tunnel?name=${encodeURIComponent(tunnelName)}&is_deleted=false`,
  )) as { id: string; name: string }[] | null;
  const reuse = existingTunnels?.find((t) => t.name === tunnelName);

  let tunnelId: string;
  let tunnelToken: string | undefined;
  let createdNew = false;
  if (reuse) {
    tunnelId = reuse.id;
  } else {
    // config_src: "cloudflare" → we manage ingress via the API.
    const created = (await cfFetch(apiToken, "POST", `/accounts/${acct}/cfd_tunnel`, {
      name: tunnelName,
      config_src: "cloudflare",
    })) as { id: string; token?: string };
    tunnelId = created.id;
    tunnelToken = created.token;
    createdNew = true;
  }

  try {
    if (!tunnelToken) {
      tunnelToken = (await cfFetch(apiToken, "GET", `/accounts/${acct}/cfd_tunnel/${tunnelId}/token`)) as string;
    }

    // Route the hostname to the app inside the tunnel, with a catch-all 404.
    await cfFetch(apiToken, "PUT", `/accounts/${acct}/cfd_tunnel/${tunnelId}/configurations`, {
      config: {
        ingress: [
          { hostname, service: TUNNEL_SERVICE },
          { service: "http_status:404" },
        ],
      },
    });

    // Upsert the proxied CNAME → <tunnelId>.cfargotunnel.com.
    const content = `${tunnelId}.cfargotunnel.com`;
    const dnsBody = { type: "CNAME", name: hostname, content, proxied: true, ttl: 1 };
    const existing = (await cfFetch(
      apiToken,
      "GET",
      `/zones/${zone.id}/dns_records?name=${encodeURIComponent(hostname)}`,
    )) as { id: string }[] | null;
    const existingRecord = existing?.[0];
    if (existingRecord) {
      await cfFetch(apiToken, "PUT", `/zones/${zone.id}/dns_records/${existingRecord.id}`, dnsBody);
    } else {
      await cfFetch(apiToken, "POST", `/zones/${zone.id}/dns_records`, dnsBody);
    }
  } catch (err) {
    // Roll back a tunnel we just created so a mid-provision failure doesn't
    // orphan it (a reused pre-existing tunnel is left alone). A fresh tunnel has
    // no active connections, so delete is safe; ignore cleanup errors.
    if (createdNew) {
      try {
        await cfFetch(apiToken, "DELETE", `/accounts/${acct}/cfd_tunnel/${tunnelId}`);
      } catch {
        // best-effort — surface the original failure below
      }
    }
    throw err;
  }

  return { hostname, zoneName: zone.name, tunnelId, tunnelName, tunnelToken };
}
