import { createHash, randomInt } from "node:crypto";
import * as OTPAuth from "otpauth";
import QRCode from "qrcode";

const ISSUER = "Lumina";
const BACKUP_CODE_COUNT = 10;

interface BackupCodeEntry {
  hash: string;
  usedAt: number | null;
}

function buildTotp(secretBase32: string, label: string): OTPAuth.TOTP {
  return new OTPAuth.TOTP({
    issuer: ISSUER,
    label,
    algorithm: "SHA1", // the near-universal authenticator-app default
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secretBase32),
  });
}

/** Generates a fresh TOTP secret plus the provisioning URI and a QR data URL
 * for enrollment. The secret is base32 (what authenticator apps and manual
 * entry expect). */
export async function generateTotpEnrollment(accountLabel: string): Promise<{
  secret: string;
  otpauthUri: string;
  qrDataUrl: string;
}> {
  const secret = new OTPAuth.Secret({ size: 20 }).base32;
  const totp = buildTotp(secret, accountLabel);
  const otpauthUri = totp.toString();
  const qrDataUrl = await QRCode.toDataURL(otpauthUri, { margin: 1, width: 240 });
  return { secret, otpauthUri, qrDataUrl };
}

/** Verifies a 6-digit code against the secret, allowing one step of clock
 * drift on either side. Returns true on match. */
export function verifyTotpCode(secretBase32: string, code: string): boolean {
  const normalized = code.replace(/\s+/g, "");
  if (!/^\d{6}$/.test(normalized)) return false;
  const totp = buildTotp(secretBase32, ISSUER);
  const delta = totp.validate({ token: normalized, window: 1 });
  return delta !== null;
}

function hashCode(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/** Ten single-use recovery codes shown once to the operator; only their
 * hashes are persisted. Format like `a1b2-c3d4` for easy transcription. */
export function generateBackupCodes(): { plaintext: string[]; stored: string } {
  const plaintext: string[] = [];
  const entries: BackupCodeEntry[] = [];
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789"; // no ambiguous chars
  for (let i = 0; i < BACKUP_CODE_COUNT; i++) {
    let code = "";
    for (let j = 0; j < 8; j++) code += alphabet[randomInt(alphabet.length)];
    const formatted = `${code.slice(0, 4)}-${code.slice(4)}`;
    plaintext.push(formatted);
    entries.push({ hash: hashCode(formatted), usedAt: null });
  }
  return { plaintext, stored: JSON.stringify(entries) };
}

/** Consumes a backup code if it matches an unused one. Returns the updated
 * JSON to persist, or null if the code was invalid/already used. */
export function consumeBackupCode(storedJson: string | null, raw: string): string | null {
  if (!storedJson) return null;
  const normalized = raw.trim().toLowerCase();
  let entries: BackupCodeEntry[];
  try {
    entries = JSON.parse(storedJson);
  } catch {
    return null;
  }
  const target = hashCode(normalized);
  const entry = entries.find((e) => e.hash === target && e.usedAt === null);
  if (!entry) return null;
  entry.usedAt = Date.now();
  return JSON.stringify(entries);
}

export function countUnusedBackupCodes(storedJson: string | null): number {
  if (!storedJson) return 0;
  try {
    return (JSON.parse(storedJson) as BackupCodeEntry[]).filter((e) => e.usedAt === null).length;
  } catch {
    return 0;
  }
}
