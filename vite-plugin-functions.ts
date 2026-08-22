/* =====================================================================
   Run the Netlify functions inside the Vite dev server.

   Without this, `npm run dev` serves the two pages and nothing else, so
   every /api/* call 404s and you cannot sign in locally at all. The
   alternative is installing the Netlify CLI; this is a few lines and no
   dependency, and it runs exactly the same handler code that deploys.

   Routes come from each function's own `config.path` export, so adding a
   function needs no change here — and a path that is wrong in production
   is wrong here too, rather than working locally and breaking on deploy.
   ===================================================================== */

import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import type { IncomingMessage } from "node:http";
import type { Plugin, ViteDevServer } from "vite";
import { loadEnv } from "vite";

const FUNCTIONS_DIR = "netlify/functions";

type Handler = (request: Request) => Promise<Response>;

export function netlifyFunctions(): Plugin {
  let routes: Map<string, string> | null = null;

  return {
    name: "master-booker:functions",
    apply: "serve",

    config(_config, { mode }) {
      // The functions read process.env directly, as they do on Netlify.
      // Vite only exposes VITE_-prefixed variables to the browser, which
      // is right: COACH_PASSCODE must never reach the client bundle.
      Object.assign(process.env, loadEnv(mode, process.cwd(), ""));
    },

    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        if (!url.pathname.startsWith("/api/")) return next();

        const reply = (status: number, body: unknown) => {
          res.statusCode = status;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(body));
        };

        try {
          routes ??= await discoverRoutes(server);
          let file = routes.get(url.pathname);

          // A function added since the server started is not in the
          // table yet. Rebuild once before giving up, so writing a new
          // function does not mean restarting the dev server to see it.
          if (!file) {
            routes = await discoverRoutes(server);
            file = routes.get(url.pathname);
          }
          if (!file) {
            reply(404, { error: `No function serves ${url.pathname}` });
            return;
          }

          const module = await server.ssrLoadModule(file);
          const response = await (module.default as Handler)(await toRequest(req, url));

          res.statusCode = response.status;
          response.headers.forEach((value, key) => res.setHeader(key, value));
          res.end(Buffer.from(await response.arrayBuffer()));
        } catch (error) {
          // Surfaced in full here. The handler wrapper hides internals
          // from callers, which is right in production and unhelpful
          // when you are the one debugging it.
          console.error(`[api] ${req.method} ${url.pathname}`, error);
          reply(500, { error: error instanceof Error ? error.message : "Function failed" });
        }
      });
    }
  };
}

/** Path -> module, read from each function's own `config.path`. */
async function discoverRoutes(server: ViteDevServer): Promise<Map<string, string>> {
  const files = readdirSync(resolve(process.cwd(), FUNCTIONS_DIR))
    .filter(name => name.endsWith(".ts") && !name.startsWith("_"));

  const routes = new Map<string, string>();
  for (const name of files) {
    const file = `/${FUNCTIONS_DIR}/${name}`;
    const module = await server.ssrLoadModule(file);
    const path = (module.config as { path?: string } | undefined)?.path;
    if (path) routes.set(path, file);
  }

  console.log(`  API  ${[...routes.keys()].sort().join("  ")}`);
  return routes;
}

async function toRequest(req: IncomingMessage, url: URL): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const body = Buffer.concat(chunks);

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    headers.set(key, Array.isArray(value) ? value.join(", ") : value);
  }

  return new Request(`http://localhost${url.pathname}${url.search}`, {
    method: req.method ?? "GET",
    headers,
    body: body.length > 0 ? body : undefined
  });
}
