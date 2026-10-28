import { createReadStream } from "node:fs";
import { access, constants, stat } from "node:fs/promises";
import { extname, join, normalize, relative, resolve, sep } from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

export async function registerAdminStatic(app: FastifyInstance, distDir: string | null): Promise<void> {
  if (!distDir) {
    return;
  }
  try {
    await access(join(distDir, "index.html"), constants.R_OK);
  } catch {
    app.log.warn({ distDir }, "admin UI dist not found");
    return;
  }

  app.get("/", async (request, reply) => redirectToPortal(request, reply));
  app.get("/portal", async (_request, reply) => sendFile(reply, join(distDir, "index.html")));
  app.get("/portal/*", async (_request, reply) => sendFile(reply, join(distDir, "index.html")));

  await app.register(
    async (scope) => {
      scope.get("/", async (_request, reply) => sendFile(reply, join(distDir, "index.html")));
      scope.get("/*", async (request, reply) => {
        const rest = String((request.params as Record<string, string>)["*"] ?? "");
        const candidate = resolve(distDir, rest);
        if (!isInside(distDir, candidate)) {
          return reply.code(404).send();
        }
        try {
          const info = await stat(candidate);
          if (info.isFile()) {
            return sendFile(reply, candidate);
          }
        } catch {
          // SPA fallback
        }
        return sendFile(reply, join(distDir, "index.html"));
      });
    },
    { prefix: "/admin" },
  );
}

function redirectToPortal(request: FastifyRequest, reply: FastifyReply) {
  const queryIndex = request.url.indexOf("?");
  const query = queryIndex === -1 ? "" : request.url.slice(queryIndex);
  return reply.code(302).header("location", `/portal${query}`).send();
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || (!rel.startsWith("..") && !normalize(rel).startsWith(`..${sep}`));
}

function sendFile(reply: FastifyReply, path: string) {
  const type = CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
  reply.header("content-type", type);
  reply.header("cache-control", path.endsWith("index.html") ? "no-store" : "public, max-age=31536000, immutable");
  return reply.send(createReadStream(path));
}
