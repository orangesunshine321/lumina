import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  createApp,
  cleanupDataDir,
  cookieValue,
  db,
  schema,
  sqlite,
  ADMIN_COOKIE,
  type App,
} from "./helpers.ts";

let app: App;

beforeAll(async () => {
  app = await createApp();
});

afterAll(async () => {
  await app.close();
  sqlite.close();
  cleanupDataDir();
});

async function token() {
  const { ensureSetupToken } = await import("../services/setupToken.ts");
  return ensureSetupToken();
}

describe("first-run setup", () => {
  it("reports needsSetup until an admin exists", async () => {
    const res = await app.inject({ method: "GET", url: "/api/setup/status" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ needsSetup: true });
  });

  it("rejects setup without the correct setup code", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/setup",
      payload: { email: "nobody@test.dev", password: "a-long-enough-password", setupToken: "wrong-code" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "invalid_setup_token" });
    const admins = await db.select({ id: schema.adminUsers.id }).from(schema.adminUsers);
    expect(admins).toHaveLength(0);
  });

  it("only one of two concurrent setup requests can win (A7 race)", async () => {
    const setupToken = await token();
    const post = (email: string) =>
      app.inject({
        method: "POST",
        url: "/api/setup",
        payload: { email, password: "a-long-enough-password", setupToken },
      });

    const [a, b] = await Promise.all([post("first@test.dev"), post("second@test.dev")]);
    const statuses = [a.statusCode, b.statusCode].sort();
    expect(statuses).toEqual([200, 403]);

    const admins = await db.select({ id: schema.adminUsers.id }).from(schema.adminUsers);
    expect(admins).toHaveLength(1);

    const winner = a.statusCode === 200 ? a : b;
    expect(cookieValue(winner, ADMIN_COOKIE)).toBeTruthy();
  });

  it("permanently disables itself once an admin exists", async () => {
    const status = await app.inject({ method: "GET", url: "/api/setup/status" });
    expect(status.json()).toEqual({ needsSetup: false });

    const res = await app.inject({
      method: "POST",
      url: "/api/setup",
      payload: { email: "third@test.dev", password: "a-long-enough-password", setupToken: "anything" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "setup_already_completed" });
  });
});
