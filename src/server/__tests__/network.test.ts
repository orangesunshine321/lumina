import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ADMIN_COOKIE, cleanupDataDir, createApp, setupAdmin, sqlite, type App } from "./helpers.ts";

let app: App;
let adminCookie: string;
let net: typeof import("../services/network.ts");
let settings: typeof import("../services/settings.ts");

beforeAll(async () => {
  app = await createApp();
  ({ adminCookie } = await setupAdmin(app));
  net = await import("../services/network.ts");
  settings = await import("../services/settings.ts");
});

afterAll(async () => {
  await app.close();
  sqlite.close();
  cleanupDataDir();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Minimal Cloudflare-shaped Response for stubbing global fetch. */
function cfResponse(success: boolean, payload: unknown, status = success ? 200 : 400) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => (success ? { success: true, result: payload } : { success: false, errors: [{ message: payload }] }),
  } as unknown as Response;
}

function pingResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

describe("normalizeBaseUrl", () => {
  it("upgrades bare hosts, strips path/slash, and rejects junk", () => {
    const n = settings.normalizeBaseUrl;
    expect(n("gallery.example.com")).toBe("https://gallery.example.com");
    expect(n("http://foo.example.com")).toBe("http://foo.example.com");
    expect(n("https://foo.example.com/g/x/")).toBe("https://foo.example.com");
    expect(n("https://foo.example.com:8443")).toBe("https://foo.example.com:8443");
    expect(n("  bgreen.cloud  ")).toBe("https://bgreen.cloud");
    expect(n("")).toBe("");
    expect(n("localhost")).toBe(""); // no dot → not a public host
    expect(n("ftp://foo.example.com")).toBe("");
    expect(n("not a url")).toBe("");
    expect(n(null)).toBe("");
    expect(n(42)).toBe("");
  });
});

describe("cloudflare client (stubbed fetch)", () => {
  it("verifies a token and lists its zones + accounts", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/user/tokens/verify")) return cfResponse(true, { id: "t", status: "active" });
        if (url.includes("/zones")) {
          return cfResponse(true, [
            { id: "z1", name: "example.com", account: { id: "a1", name: "My Account" } },
            { id: "z2", name: "bgreen.cloud", account: { id: "a1", name: "My Account" } },
          ]);
        }
        return cfResponse(true, {});
      }),
    );
    const res = await net.cfVerifyToken("token123");
    expect(res.zones.map((z) => z.name)).toEqual(["example.com", "bgreen.cloud"]);
    expect(res.accounts).toEqual([{ id: "a1", name: "My Account" }]);
  });

  it("throws CloudflareError with the API message on an invalid token", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => cfResponse(false, "Invalid API Token", 403)));
    await expect(net.cfVerifyToken("bad")).rejects.toThrow(/Invalid API Token/);
  });
});

describe("connectivity self-test (stubbed fetch)", () => {
  it("passes when the probe loops back to this instance", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => pingResponse({ pong: true, matched: true })));
    const r = await net.runSelfTest("https://gallery.example.com");
    expect(r.reachable).toBe(true);
    expect(r.matchedThisInstance).toBe(true);
    expect(r.ok).toBe(true);
  });

  it("flags reaching a different server when the nonce doesn't match", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => pingResponse({ pong: true, matched: false })));
    const r = await net.runSelfTest("https://gallery.example.com");
    expect(r.reachable).toBe(true);
    expect(r.matchedThisInstance).toBe(false);
    expect(r.ok).toBe(false);
  });

  it("reports unreachable when the fetch fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    const r = await net.runSelfTest("https://gallery.example.com");
    expect(r.reachable).toBe(false);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/ECONNREFUSED/);
  });
});

describe("public ping route", () => {
  it("pongs and reports matched=false for an unknown probe", async () => {
    const res = await app.inject({ method: "GET", url: "/api/network/ping?probe=nope" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ pong: true, matched: false });
  });
});

describe("admin network routes", () => {
  it("status requires an admin session", async () => {
    const res = await app.inject({ method: "GET", url: "/api/admin/network/status" });
    expect(res.statusCode).toBe(401);
  });

  it("status returns proxy diagnostics for an admin", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/admin/network/status",
      cookies: { [ADMIN_COOKIE]: adminCookie },
      headers: { "cf-ray": "abc123", "x-forwarded-proto": "https" },
    });
    expect(res.statusCode).toBe(200);
    const d = res.json().diagnostics;
    expect(d.behindCloudflare).toBe(true);
    expect(d.httpsUpstream).toBe(true);
    expect(d).toHaveProperty("trustProxy");
    expect(d).toHaveProperty("secureCookies");
  });

  it("self-test 400s when no public URL is configured", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/network/self-test",
      payload: {},
      cookies: { [ADMIN_COOKIE]: adminCookie },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "no_public_url" });
  });

  it("cloudflare verify 400s without a token", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/network/cloudflare/verify",
      payload: {},
      cookies: { [ADMIN_COOKIE]: adminCookie },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "missing_token" });
  });

  it("cloudflare provision 400s without a hostname", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/network/cloudflare/provision",
      payload: { apiToken: "tok" },
      cookies: { [ADMIN_COOKIE]: adminCookie },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "missing_hostname" });
  });
});
