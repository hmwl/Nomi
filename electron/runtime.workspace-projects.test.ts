import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearElectronRuntimeForTests, setElectronRuntimeForTests } from "./electronAdapter";
import { createProject, deleteProject, listProjects, readProject, resolveProjectRelativePath, saveProject } from "./runtime";
import { workspaceProjectFile } from "./workspace/workspacePaths";

const tempRoots: string[] = [];
let mockedDocumentsRoot = "";
let mockedUserDataRoot = "";

vi.mock("electron", () => ({
  app: {
    getPath: (name: string) => {
      if (name === "documents") return mockedDocumentsRoot;
      if (name === "userData") return mockedUserDataRoot;
      return mockedUserDataRoot;
    },
    getAppPath: () => process.cwd(),
  },
}));

function installElectronRuntimeMock(): void {
  setElectronRuntimeForTests({
    app: {
      getPath: (name: string) => {
        if (name === "documents") return mockedDocumentsRoot;
        if (name === "userData") return mockedUserDataRoot;
        return mockedUserDataRoot;
      },
      getAppPath: () => process.cwd(),
    },
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-05-31T12:00:00Z"));
  mockedDocumentsRoot = makeTempDir("nomi-runtime-documents-");
  mockedUserDataRoot = makeTempDir("nomi-runtime-user-data-");
  installElectronRuntimeMock();
  delete process.env.NOMI_PROJECTS_DIR;
});

afterEach(() => {
  vi.useRealTimers();
  clearElectronRuntimeForTests();
  delete process.env.NOMI_PROJECTS_DIR;
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function makeTempDir(name = "nomi-runtime-workspace-test-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), name));
  tempRoots.push(dir);
  return dir;
}

describe("runtime workspace project APIs", () => {
  it("createProject accepts rootPath and writes .nomi/project.json", () => {
    const workspaceRoot = makeTempDir();

    const created = createProject({ rootPath: workspaceRoot, name: "Runtime Workspace", payload: { scenes: [] } });

    expect(created).toMatchObject({
      name: "Runtime Workspace",
      version: 2,
      payload: { scenes: [] },
    });
    expect(fs.existsSync(workspaceProjectFile(workspaceRoot))).toBe(true);
    expect(listProjects()[0]).toMatchObject({ id: created.id, name: "Runtime Workspace", missing: false });
  });

  it("readProject finds a workspace project outside the default projects root", () => {
    const defaultRoot = path.join(mockedDocumentsRoot, "Nomi Projects");
    const workspaceRoot = makeTempDir();

    const created = createProject({ rootPath: workspaceRoot, name: "Outside Default", payload: { script: "hello" } });

    expect(workspaceRoot.startsWith(defaultRoot)).toBe(false);
    expect(readProject(created.id)).toEqual(created);
  });

  it("saveProject updates workspace manifest payload", () => {
    const workspaceRoot = makeTempDir();
    const created = createProject({ rootPath: workspaceRoot, name: "Save Runtime", payload: { draft: 1 } });
    vi.setSystemTime(new Date("2026-05-31T12:30:00Z"));

    const saved = saveProject(created.id, { name: "Saved Runtime", payload: { draft: 2 } });
    const raw = JSON.parse(fs.readFileSync(workspaceProjectFile(workspaceRoot), "utf8"));

    expect(saved).toMatchObject({
      id: created.id,
      name: "Saved Runtime",
      updatedAt: Date.parse("2026-05-31T12:30:00Z"),
      savedAt: Date.parse("2026-05-31T12:30:00Z"),
      revision: (created.revision ?? 0) + 1,
      payload: { draft: 2 },
    });
    expect(raw.payload).toEqual({ draft: 2 });
  });

  it("deleteProject only removes the recent workspace reference", () => {
    const workspaceRoot = makeTempDir();
    const created = createProject({ rootPath: workspaceRoot, name: "Remove Reference", payload: {} });

    const result = deleteProject(created.id);

    expect(result).toEqual({ id: created.id, deleted: false });
    expect(readProject(created.id)).toBeNull();
    expect(fs.existsSync(workspaceProjectFile(workspaceRoot))).toBe(true);
  });

  it("listProjects migrates legacy projects from the default projects root into the workspace registry", () => {
    const defaultRoot = path.join(mockedDocumentsRoot, "Nomi Projects");
    const legacyRoot = path.join(defaultRoot, "Legacy Project");
    fs.mkdirSync(legacyRoot, { recursive: true });
    fs.writeFileSync(
      path.join(legacyRoot, "project.json"),
      JSON.stringify({
        id: "legacy-id",
        name: "Legacy Project",
        version: 1,
        createdAt: 100,
        updatedAt: 200,
        savedAt: 300,
        revision: 2,
        payload: { old: true },
      }),
    );

    const projects = listProjects();

    expect(projects).toEqual([expect.objectContaining({ id: "legacy-id", name: "Legacy Project", version: 2 })]);
    expect(fs.existsSync(workspaceProjectFile(legacyRoot))).toBe(true);
    expect(readProject("legacy-id")?.payload).toEqual({ old: true });
  });

  it("resolveProjectRelativePath rejects symlink escapes from a workspace project", () => {
    const workspaceRoot = makeTempDir();
    const outsideRoot = makeTempDir("nomi-runtime-outside-");
    const created = createProject({ rootPath: workspaceRoot, name: "Symlink Runtime", payload: {} });
    fs.writeFileSync(path.join(outsideRoot, "secret.txt"), "secret");
    fs.symlinkSync(outsideRoot, path.join(workspaceRoot, "linked-outside"), "dir");

    expect(() => resolveProjectRelativePath(created.id, "linked-outside/secret.txt")).toThrow(/inside the selected workspace|escapes project root/i);
  });

  it("deleteProject does not make migrated legacy projects reappear on the next list", () => {
    const defaultRoot = path.join(mockedDocumentsRoot, "Nomi Projects");
    const legacyRoot = path.join(defaultRoot, "Deleted Legacy");
    fs.mkdirSync(legacyRoot, { recursive: true });
    fs.writeFileSync(
      path.join(legacyRoot, "project.json"),
      JSON.stringify({ id: "delete-legacy-id", name: "Deleted Legacy", version: 1, payload: {} }),
    );
    expect(listProjects()).toEqual([expect.objectContaining({ id: "delete-legacy-id" })]);

    expect(deleteProject("delete-legacy-id")).toEqual({ id: "delete-legacy-id", deleted: false });

    expect(fs.existsSync(legacyRoot)).toBe(true);
    expect(listProjects()).toEqual([]);
    expect(readProject("delete-legacy-id")).toBeNull();
  });

  it("createProject without a rootPath auto-creates a folder under the default projects root", () => {
    // 「新建项目」入口：不带 rootPath 时不再报错，而是在默认根下自动建项目文件夹，
    // 复用 workspace 的初始化/注册/资源落盘（这样用户不必每次选文件夹）。
    const defaultRoot = path.join(mockedDocumentsRoot, "Nomi Projects");

    const created = createProject({ name: "No Folder", payload: { scenes: [] } });

    expect(created).toMatchObject({ name: "No Folder", version: 2, payload: { scenes: [] } });
    expect(fs.existsSync(defaultRoot)).toBe(true);
    const summary = listProjects().find((item) => item.id === created.id);
    expect(summary).toMatchObject({ id: created.id, name: "No Folder", missing: false });
    const rootPath = summary?.rootPath ?? "";
    expect(rootPath.startsWith(defaultRoot)).toBe(true);
    expect(fs.existsSync(workspaceProjectFile(rootPath))).toBe(true);
    expect(readProject(created.id)).toEqual(created);
  });

  it("does not create new fixed-root projects when saving an unknown project id", () => {
    expect(() => saveProject("missing-id", { name: "Missing", payload: {} })).toThrow(/workspace project/i);
    expect(listProjects()).toEqual([]);
  });
});
