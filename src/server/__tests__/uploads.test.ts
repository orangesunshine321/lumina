import { describe, it, expect, beforeAll, afterAll } from "vitest";
import sharp from "sharp";
import {
  createApp,
  cleanupDataDir,
  setupAdmin,
  createGallery,
  multipartUpload,
  sqlite,
  ADMIN_COOKIE,
  type App,
} from "./helpers.ts";

let app: App;
let adminCookie: string;
let gallery: { id: string; slug: string };

function makeJpeg(r: number, g: number, b: number): Promise<Buffer> {
  return sharp({ create: { width: 64, height: 48, channels: 3, background: { r, g, b } } })
    .jpeg()
    .toBuffer();
}

function upload(filename: string, contentType: string, data: Buffer) {
  const { payload, headers } = multipartUpload(filename, contentType, data);
  return app.inject({
    method: "POST",
    url: `/api/admin/galleries/${gallery.id}/uploads`,
    payload,
    headers,
    cookies: { [ADMIN_COOKIE]: adminCookie },
  });
}

beforeAll(async () => {
  app = await createApp();
  ({ adminCookie } = await setupAdmin(app));
  gallery = await createGallery(app, adminCookie, "Uploads");
});

afterAll(async () => {
  await app.close();
  sqlite.close();
  cleanupDataDir();
});

describe("upload route", () => {
  it("accepts a JPEG and queues it for processing", async () => {
    const res = await upload("DSC_TEST.jpg", "image/jpeg", await makeJpeg(10, 20, 30));
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("pending");
    expect(body.baseFilename).toBe("DSC_TEST");
    expect(body.originalFilename).toBe("DSC_TEST.jpg");
  });

  it("detects a byte-identical re-upload as a duplicate", async () => {
    const bytes = await makeJpeg(40, 50, 60);
    const first = await upload("DSC_DUP.jpg", "image/jpeg", bytes);
    expect(first.statusCode).toBe(200);

    const second = await upload("DSC_DUP.jpg", "image/jpeg", bytes);
    expect(second.statusCode).toBe(200);
    const body = second.json();
    expect(body.duplicate).toBe(true);
    expect(body.photo.baseFilename).toBe("DSC_DUP");
  });

  it("rejects non-JPEG files", async () => {
    const png = await sharp({
      create: { width: 32, height: 32, channels: 3, background: { r: 0, g: 0, b: 0 } },
    })
      .png()
      .toBuffer();
    const res = await upload("not-a-photo.png", "image/png", png);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "invalid_file_type" });
  });

  it("rejects an over-100MP image (decompression-bomb guard)", async () => {
    // A solid-color 12000×9000 (108MP) JPEG compresses to a few KB but would
    // decode to ~324MB — exactly the shape of a decompression bomb.
    const huge = await sharp({
      create: { width: 12000, height: 9000, channels: 3, background: { r: 5, g: 5, b: 5 } },
    })
      .jpeg()
      .toBuffer();
    const res = await upload("DSC_HUGE.jpg", "image/jpeg", huge);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "image_too_large" });
  });

  it("assigns distinct sortIndex values under concurrency (A1)", async () => {
    const buffers = await Promise.all([
      makeJpeg(100, 0, 0),
      makeJpeg(0, 100, 0),
      makeJpeg(0, 0, 100),
      makeJpeg(100, 100, 0),
    ]);
    const responses = await Promise.all(
      buffers.map((buf, i) => upload(`DSC_RACE_${i}.jpg`, "image/jpeg", buf)),
    );
    for (const res of responses) expect(res.statusCode).toBe(200);

    const sortIndexes = responses.map((res) => res.json().sortIndex as number);
    expect(new Set(sortIndexes).size).toBe(4);
  });
});
