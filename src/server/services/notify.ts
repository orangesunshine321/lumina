import { eq } from "drizzle-orm";
import { db, schema } from "../db/client.ts";
import { getPublicBaseUrl } from "./settings.ts";

/**
 * Fire-and-forget outgoing notification when a client submits their selection.
 * Reads the (single) admin's configured webhook URL and POSTs a JSON body that
 * the common services accept as-is: `content` for Discord, `text` for Slack,
 * plus a plain `message`. Never throws and never blocks the client's request.
 */
export async function notifySelectionSubmitted(params: {
  galleryTitle: string;
  gallerySlug: string;
  favoriteCount: number;
  note: string | null;
}): Promise<void> {
  const [admin] = await db
    .select({ url: schema.adminUsers.notifyWebhookUrl })
    .from(schema.adminUsers)
    .limit(1);
  const url = admin?.url?.trim();
  if (!url) return;

  const picks = `${params.favoriteCount} ${params.favoriteCount === 1 ? "favorite" : "favorites"}`;
  let message = `“${params.galleryTitle}” — your client submitted their selection (${picks}).`;
  if (params.note) message += `\nNote: ${params.note}`;
  // Only build an absolute click-through link when a custom domain is set — the
  // server has no other way to know its own public origin, and a relative path
  // is useless inside a Discord/Slack message.
  const base = await getPublicBaseUrl();
  if (base) message += `\n${base}/g/${params.gallerySlug}`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: message, text: message, message }),
      signal: controller.signal,
    }).finally(() => clearTimeout(timeout));
  } catch {
    // A down or misconfigured webhook must never affect the client experience.
  }
}

export async function setWebhookUrl(adminId: string, url: string | null): Promise<void> {
  await db
    .update(schema.adminUsers)
    .set({ notifyWebhookUrl: url && url.trim().length > 0 ? url.trim() : null, updatedAt: new Date() })
    .where(eq(schema.adminUsers.id, adminId));
}
