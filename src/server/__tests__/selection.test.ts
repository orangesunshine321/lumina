import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import {
  ADMIN_COOKIE,
  cleanupDataDir,
  cookieValue,
  createApp,
  createGallery,
  db,
  insertReadyPhoto,
  schema,
  setupAdmin,
  sqlite,
  type App,
} from "./helpers.ts";
import { eq } from "drizzle-orm";

let app: App;
let adminCookie: string;

beforeAll(async () => {
  app = await createApp();
  ({ adminCookie } = await setupAdmin(app));
});

afterAll(async () => {
  await app.close();
  sqlite.close();
  cleanupDataDir();
});

async function unlockedGallery(title: string) {
  const gallery = await createGallery(app, adminCookie, title);
  const p1 = await insertReadyPhoto(gallery.id);
  await db.insert(schema.favorites).values({
    galleryId: gallery.id,
    photoId: p1.id,
    toggledByClientToken: "client-1",
  });
  // No password → client already has access; grab the client_token cookie.
  const meta = await app.inject({ method: "GET", url: `/api/gallery/${gallery.slug}` });
  const clientCookie = cookieValue(meta, "lumina_client");
  return { gallery, clientCookie };
}

describe("selection submission", () => {
  it("records a submission with a note and surfaces it to the admin, then clears on review", async () => {
    const { gallery } = await unlockedGallery("Submit Me");

    const submit = await app.inject({
      method: "POST",
      url: `/api/gallery/${gallery.slug}/submit`,
      payload: { note: "Please crop the third one tighter." },
    });
    expect(submit.statusCode).toBe(200);
    expect(submit.json().favoriteCount).toBe(1);

    // Admin sees the submission + note.
    const detail = await app.inject({
      method: "GET",
      url: `/api/admin/galleries/${gallery.id}`,
      cookies: { [ADMIN_COOKIE]: adminCookie },
    });
    expect(detail.json().selectionSubmittedAt).not.toBeNull();
    expect(detail.json().selectionNote).toBe("Please crop the third one tighter.");

    // Client meta reflects the submitted state.
    const meta = await app.inject({ method: "GET", url: `/api/gallery/${gallery.slug}` });
    expect(meta.json().selectionSubmittedAt).not.toBeNull();

    // Mark reviewed → signal clears, note stays.
    const reviewed = await app.inject({
      method: "POST",
      url: `/api/admin/galleries/${gallery.id}/selection/reviewed`,
      cookies: { [ADMIN_COOKIE]: adminCookie },
    });
    expect(reviewed.json().selectionSubmittedAt).toBeNull();
    expect(reviewed.json().selectionNote).toBe("Please crop the third one tighter.");
  });

  it("fires the configured webhook on submit", async () => {
    // A throwaway HTTP server standing in for Discord/Slack/ntfy.
    const received: string[] = [];
    const server: Server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        received.push(body);
        res.writeHead(204).end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as { port: number }).port;

    const set = await app.inject({
      method: "POST",
      url: "/api/admin/account/webhook",
      payload: { webhookUrl: `http://127.0.0.1:${port}/hook` },
      cookies: { [ADMIN_COOKIE]: adminCookie },
    });
    expect(set.statusCode).toBe(200);

    const { gallery } = await unlockedGallery("Webhook Gallery");
    await app.inject({
      method: "POST",
      url: `/api/gallery/${gallery.slug}/submit`,
      payload: { note: "loved these" },
    });

    // The webhook fire is fire-and-forget; give it a moment.
    await new Promise((r) => setTimeout(r, 300));
    expect(received.length).toBe(1);
    const payload = JSON.parse(received[0]!);
    expect(payload.content).toContain("Webhook Gallery");
    expect(payload.content).toContain("loved these");
    // Slack + Discord shapes both present.
    expect(payload.text).toBe(payload.content);

    server.close();
  });

  it("rejects a non-http webhook url", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/account/webhook",
      payload: { webhookUrl: "javascript:alert(1)" },
      cookies: { [ADMIN_COOKIE]: adminCookie },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_url");
  });

  it("clears the webhook when set to null", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/account/webhook",
      payload: { webhookUrl: null },
      cookies: { [ADMIN_COOKIE]: adminCookie },
    });
    expect(res.json().webhookUrl).toBeNull();
    const [admin] = await db.select().from(schema.adminUsers).limit(1);
    expect(admin!.notifyWebhookUrl).toBeNull();
  });
});
