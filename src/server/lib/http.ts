import { randomBytes } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { CLIENT_TOKEN_COOKIE, CLIENT_TOKEN_TTL_MS } from "../services/auth.ts";
import { config } from "../config.ts";

/** Reads the client's real IP, honoring X-Forwarded-For only because Fastify's
 * `trustProxy` option (config.trustProxy) is enabled solely when the operator
 * has confirmed the app sits behind their own reverse proxy. */
export function getClientIp(request: FastifyRequest): string {
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
