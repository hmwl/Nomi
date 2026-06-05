// 运行时基础设施层 —— 路径 / 目录 / JSON 读取的共享地基（见
// docs/plan/2026-06-04-runtime-split-execution.md）。projects / assets / catalog /
// skills 等域都依赖这一层；先抽出来才能解开它们之间的循环依赖。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadElectronRuntime } from "./electronAdapter";
import type { WorkspaceRepositoryDeps } from "./workspace/workspaceRepository";

export const PROJECT_FILE = "project.json";
export const PROJECT_ROOT_ENV = "NOMI_PROJECTS_DIR";
export const CATALOG_FILE = "model-catalog.json";
export const SKILLS_ROOT_ENV = "NOMI_SKILLS_DIR";
export const SETTINGS_ROOT_ENV = "NOMI_SETTINGS_DIR";

type ElectronAppLike = {
  getPath: (name: string) => string;
  getAppPath?: () => string;
};

function getElectronApp(): ElectronAppLike | null {
  const runtime = loadElectronRuntime() as { app?: ElectronAppLike } | null;
  return runtime?.app && typeof runtime.app.getPath === "function" ? runtime.app : null;
}

function getDefaultDocumentsRoot(): string {
  const app = getElectronApp();
  if (app) return app.getPath("documents");
  return path.join(os.homedir(), "Documents");
}

export function getProjectsRoot(): string {
  const configured = String(process.env[PROJECT_ROOT_ENV] || "").trim();
  return configured || path.join(getDefaultDocumentsRoot(), "Nomi Projects");
}

export function getSettingsRoot(): string {
  const configured = String(process.env[SETTINGS_ROOT_ENV] || "").trim();
  if (configured) return configured;
  const app = getElectronApp();
  if (app) return app.getPath("userData");
  return path.join(os.homedir(), ".nomi");
}

export function getWorkspaceRepositoryDeps(): WorkspaceRepositoryDeps {
  return {
    settingsRoot: getSettingsRoot(),
    defaultProjectsRoot: getProjectsRoot(),
  };
}

export function getSkillsRoots(): string[] {
  const app = getElectronApp();
  const appPath = typeof app?.getAppPath === "function" ? app.getAppPath() : "";
  const candidates = [
    String(process.env[SKILLS_ROOT_ENV] || "").trim(),
    path.join(process.cwd(), "skills"),
    appPath ? path.join(appPath, "skills") : "",
    path.join(__dirname, "../skills"),
    path.join(process.resourcesPath || "", "skills"),
  ].filter(Boolean);
  return Array.from(new Set(candidates.map((item) => path.resolve(item))));
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

export function readJson<T>(filePath: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export function readText(filePath: string): string {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}
