import { createReadStream, statSync } from "node:fs";
import type { FastifyReply, FastifyRequest } from "fastify";

/** Sends a file with its content type, honouring Range requests (preview players seek with them). */
export function sendFile(req: FastifyRequest, reply: FastifyReply, path: string, type: string) {
  const size = statSync(path).size;
  reply.type(type).header("accept-ranges", "bytes");
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : Math.max(size - Number(range[2]), 0);
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start > end || start >= size) return reply.code(416).header("content-range", `bytes */${size}`).send();
    reply.code(206).header("content-range", `bytes ${start}-${end}/${size}`).header("content-length", end - start + 1);
    return reply.send(createReadStream(path, { start, end }));
  }
  reply.header("content-length", size);
  return reply.send(createReadStream(path));
}
