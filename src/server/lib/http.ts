import { randomBytes } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { CLIENT_TOKEN_COOKIE, CLIENT_TOKEN_TTL_MS } from "../services/auth.ts";
import { config } from "../config.ts";

/** The client's real IP, used to key rate limiting. Prefers `CF-Connecting-IP`
 * when present: Cloudflare *overwrites* it with the true client address on
 * every request (a client behind the tunnel can't forge it), which closes the
 * X-Forwarded-For spoofing gap that would otherwise let an attacker reset the
 * per-IP backoff by rotating the header. Falls back to Fastify's `request.ip`
 * (X-Forwarded-For, trusted per `config.trustProxy`) for non-Cloudflare
 * proxies; the per-gallery and global admin caps backstop that path. */
export function getClientIp(request: FastifyRequest): string {
  const cf = request.headers["cf-connecting-ip"];
  if (typeof cf === "string" && cf.length > 0) return cf;
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
