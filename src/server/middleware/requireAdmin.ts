import type { FastifyReply, FastifyRequest } from "fastify";
import { ADMIN_SESSION_COOKIE, verifyAdminSession } from "../services/auth.ts";

export async function requireAdmin(request: FastifyRequest, reply: FastifyReply) {
  const token = request.cookies[ADMIN_SESSION_COOKIE];
  const session = await verifyAdminSession(token);
  if (!session) {
    return reply.code(401).send({ error: "unauthorized" });
  }
  request.adminSession = session;
}
