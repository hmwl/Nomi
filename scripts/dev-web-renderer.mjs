import { spawn } from "node:child_process";

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const backendTarget = process.env.VITE_NOMI_API_PROXY_TARGET || `http://127.0.0.1:${process.env.NOMI_WEB_PORT || "8787"}`;
const port = process.env.NOMI_WEB_RENDERER_PORT || "5173";

const child = spawn(pnpm, ["exec", "vite", "--host", "127.0.0.1", "--port", port, "--strictPort"], {
  stdio: "inherit",
  shell: false,
  env: {
    ...process.env,
    VITE_NOMI_RUNTIME: "web",
    VITE_NOMI_API_BASE: process.env.VITE_NOMI_API_BASE || "/api",
    VITE_NOMI_API_PROXY_TARGET: backendTarget,
  },
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});

