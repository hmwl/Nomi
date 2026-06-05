import { spawn } from "node:child_process";

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const child = spawn(pnpm, ["exec", "vite", "build", "--mode", "production"], {
  stdio: "inherit",
  shell: false,
  env: {
    ...process.env,
    VITE_NOMI_RUNTIME: "web",
    VITE_NOMI_API_BASE: process.env.VITE_NOMI_API_BASE || "/api",
  },
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});

