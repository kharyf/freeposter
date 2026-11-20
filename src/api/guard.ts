import type { FastifyRequest } from "fastify";
import { config } from "../config.ts";

/** A local agent, or this app's own page; never another website the user happens to have open. */
export function trustedRequest(req: FastifyRequest): string | null {
  const origin = req.headers.origin;
  const own = [`http://localhost:${config.port}`, `http://127.0.0.1:${config.port}`, `http://[::1]:${config.port}`, config.baseUrl];
  if (origin && !own.includes(origin)) return `origin ${origin} may not use FreePoster's MCP server`;
  // DNS rebinding: a page on evil.example resolving to 127.0.0.1 still sends Host: evil.example.
  const host = req.headers.host ?? "";
  const ownHosts = [`localhost:${config.port}`, `127.0.0.1:${config.port}`, `[::1]:${config.port}`, new URL(config.baseUrl).host];
  if (!ownHosts.includes(host)) return `host ${host} is not FreePoster`;
  return null;
}
