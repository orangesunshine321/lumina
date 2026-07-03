import { randomBytes } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { CLIENT_TOKEN_COOKIE, CLIENT_TOKEN_TTL_MS } from "../services/auth.ts";
import { config } from "../config.ts";

/** The client's real IP, used to key rate limiting. `CF-Connecting-IP` is only
 * honored when the operator has declared a trusted proxy is in front
 * (`TRUST_PROXY=true`, which the Cloudflare-Tunnel compose profile sets):
 * Cloudflare *overwrites* that header with the true client address on every
 * request, closing the X-Forwarded-For spoofing gap. On a directly-exposed
 * instance (no proxy, `TRUST_PROXY` unset) the header is attacker-controlled —
 * a client could forge a fresh value per request to reset the per-IP backoff —
 * so we ignore it and key on the real socket address (`request.ip`), which is
 * unspoofable there. Behind a non-Cloudflare proxy (Caddy/Nginx) that does not
 * strip inbound `CF-Connecting-IP`, the per-gallery and global admin caps
 * (which are IP-independent) remain the backstop; strip the header at the proxy
 * to fully restore the per-IP control. */
export function getClientIp(request: FastifyRequest): string {
  if (config.trustProxy) {
    const cf = request.headers["cf-connecting-ip"];
    if (typeof cf === "string" && cf.length > 0) return cf;
  }
  return request.ip;
}

/** Ensures every visitor has a long-lived anonymous identity used ONLY to
 * attribute favorite-toggle provenance — never for access control. */
export function ensureClientToken(request: FastifyRequest, reply: FastifyReply): string {
  const existing = request.cookies[CLIENT_TOKEN_COOKIE];
  if (existing) {
    request.clientToken = existing;
    return existing;
  }
  const token = randomBytes(16).toString("hex");
  reply.setCookie(CLIENT_TOKEN_COOKIE, token, {
    httpOnly: true,
    secure: config.isProduction,
    sameSite: "lax",
    path: "/",
    maxAge: CLIENT_TOKEN_TTL_MS / 1000,
  });
  request.clientToken = token;
  return token;
}
