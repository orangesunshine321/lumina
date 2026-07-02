import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { config } from "../config.ts";

const tokenPath = resolve(config.dataDir, "db/setup-token");

/** First-run guard against an internet-exposed "land-grab": on a public URL
 * there's a window between the container going live and the operator finishing
 * the setup form, during which anyone could claim the admin account. A random
 * code — printed to the container logs and surfaced by the installer — must be
 * presented to /api/setup, so only someone with access to the server (its logs
 * or its ./data dir) can create the account. The code is deleted the moment
 * setup succeeds. */
export function ensureSetupToken(): string {
  if (existsSync(tokenPath)) return readFileSync(tokenPath, "utf-8").trim();
  const token = randomBytes(8).toString("hex"); // 64 bits — infeasible to guess online
  mkdirSync(dirname(tokenPath), { recursive: true });
  writeFileSync(tokenPath, token, { mode: 0o600 });
  return token;
}

export function verifySetupToken(provided: string | undefined): boolean {
  if (!provided || !existsSync(tokenPath)) return false;
  const expected = readFileSync(tokenPath, "utf-8").trim();
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function clearSetupToken(): void {
  try {
    rmSync(tokenPath, { force: true });
  } catch {
    // best-effort; setup also self-disables once an admin row exists
  }
}
