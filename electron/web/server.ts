import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { contentTypeFromPath } from "../assets/assetPaths";
import { createRuntimeWebApi } from "./runtimeApi";
import { requestUrl, sendError } from "./http";

type WebServerOptions = {
  host?: string;
  port?: number;
  staticDir?: string;
};

export type StartedWebServer = {
  close: () => Promise<void>;
  url: string;
};

function defaultStaticDir(): string {
  return path.resolve(__dirname, "../../dist");
}

function resolveStaticPath(staticDir: string, pathname: string): string | null {
  const decoded = decodeURIComponent(pathname);
  const relative = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const absolutePath = path.resolve(staticDir, relative);
  const root = path.resolve(staticDir);
  if (absolutePath !== root && !absolutePath.startsWith(`${root}${path.sep}`)) return null;
  if (fs.existsSync(absolutePath) && fs.statSync(absolutePath).isFile()) return absolutePath;
  const fallback = path.join(root, "index.html");
  return fs.existsSync(fallback) ? fallback : null;
}

function staticContentType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".js" || ext === ".mjs") return "text/javascript; charset=utf-8";
  if (ext === ".map") return "application/json; charset=utf-8";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".woff") return "font/woff";
  if (ext === ".woff2") return "font/woff2";
  return contentTypeFromPath(filePath);
}

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, staticDir: string): void {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { allow: "GET, HEAD" });
    res.end();
    return;
  }
  try {
    const { pathname } = requestUrl(req);
    const filePath = resolveStaticPath(staticDir, pathname);
    if (!filePath) {
      sendError(req, res, 404, `Static file not found. Build the Web renderer first: ${staticDir}`);
      return;
    }
    const stat = fs.statSync(filePath);
    res.writeHead(200, {
      "content-type": staticContentType(filePath),
      "content-length": stat.size,
      "cache-control": path.basename(filePath) === "index.html" ? "no-cache" : "public, max-age=31536000, immutable",
    });
    if (req.method === "HEAD") res.end();
    else fs.createReadStream(filePath).pipe(res);
  } catch (error) {
    sendError(req, res, 500, error);
  }
}

export async function startWebServer(options: WebServerOptions = {}): Promise<StartedWebServer> {
  const host = options.host || process.env.NOMI_WEB_HOST || "127.0.0.1";
  const port = Number(options.port || process.env.NOMI_WEB_PORT || 8787);
  const staticDir = path.resolve(options.staticDir || process.env.NOMI_WEB_STATIC_DIR || defaultStaticDir());
  const api = createRuntimeWebApi();
  const server = http.createServer((req, res) => {
    void api.handle(req, res)
      .then((handled) => {
        if (!handled) serveStatic(req, res, staticDir);
      })
      .catch((error) => {
        sendError(req, res, 500, error);
      });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return {
    url: `http://${host}:${port}`,
    close: async () => {
      api.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    },
  };
}

if (require.main === module) {
  startWebServer()
    .then((server) => {
      console.log(`[nomi:web] backend listening at ${server.url}`);
    })
    .catch((error) => {
      console.error("[nomi:web] failed to start backend", error);
      process.exitCode = 1;
    });
}
