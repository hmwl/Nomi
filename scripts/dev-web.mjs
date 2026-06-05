import { spawn } from "node:child_process";

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const backendHost = process.env.NOMI_WEB_HOST || "127.0.0.1";
const backendPort = process.env.NOMI_WEB_PORT || "8787";
const rendererPort = process.env.NOMI_WEB_RENDERER_PORT || "5173";
const backendUrl = `http://${backendHost}:${backendPort}`;

function start(command, args, env = {}) {
  const child = spawn(command, args, {
    stdio: "inherit",
    shell: false,
    env: { ...process.env, ...env },
  });
  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    if (signal) process.kill(process.pid, signal);
    else if (typeof code === "number" && code !== 0) process.exit(code);
  });
  return child;
}

async function waitForHealth(url) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 60_000) {
    try {
      const response = await fetch(`${url}/api/health`);
      if (response.ok) return;
    } catch {
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`Web backend did not become ready: ${url}`);
}

let shuttingDown = false;
let renderer;
const backend = start(pnpm, ["exec", "tsx", "electron/web/server.ts"], {
  NOMI_WEB_HOST: backendHost,
  NOMI_WEB_PORT: backendPort,
});

const shutdown = () => {
  shuttingDown = true;
  backend.kill();
  renderer?.kill();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("exit", shutdown);

await waitForHealth(backendUrl);
console.log(`[nomi:web] backend ready at ${backendUrl}`);

renderer = start(pnpm, ["exec", "vite", "--host", "127.0.0.1", "--port", rendererPort, "--strictPort"], {
  VITE_NOMI_RUNTIME: "web",
  VITE_NOMI_API_BASE: "/api",
  VITE_NOMI_API_PROXY_TARGET: backendUrl,
});

console.log(`[nomi:web] renderer starting at http://127.0.0.1:${rendererPort}`);
