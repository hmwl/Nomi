import { createRequire } from "node:module";
import path from "node:path";

const requireFromProject = createRequire(path.join(process.cwd(), "package.json"));

let hasRuntimeOverride = false;
let runtimeOverride: unknown = null;

export function setElectronRuntimeForTests(runtime: unknown): void {
  hasRuntimeOverride = true;
  runtimeOverride = runtime;
}

export function clearElectronRuntimeForTests(): void {
  hasRuntimeOverride = false;
  runtimeOverride = null;
}

export function loadElectronRuntime(): unknown {
  if (hasRuntimeOverride) return runtimeOverride;
  try {
    return requireFromProject("electron") as unknown;
  } catch {
    return null;
  }
}

