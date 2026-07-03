import type { FastifyInstance } from "fastify";
import { consumeProbe } from "../services/network.ts";

/**
 * Public, unauthenticated loop-back target for the admin connectivity self-test.
 * The self-test issues a one-time nonce, then fetches its own public URL; if the
 * request really loops back to THIS instance, the nonce matches. `matched:false`
 * (or unreachable) tells the operator the public URL doesn't point here yet.
 * Revealing "this is Lumina" is already true of the whole app; the nonce is
 * 128-bit and single-use, so this leaks nothing.
 */
export async function publicNetworkRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { probe?: string } }>("/api/network/ping", async (request) => {
    const probe = request.query?.probe;
    const matched = typeof probe === "string" && probe.length > 0 ? consumeProbe(probe) : false;
    return { pong: true, matched, app: "lumina" };
  });
}
