import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { listOnboardingModels, testOnboardingConnection } from "../ai/onboarding/connectionProbe";
import { runOnboardingTrial } from "../ai/onboarding/agent";
import type { ModelKind, ProviderKind } from "../ai/onboarding/types";
import {
  cancelExportJob,
  clearAgentChatV2History,
  clearModelCatalogVendorApiKey,
  commitManualOpenAiCompatibleModels,
  commitOnboardedModelToCatalog,
  createProject,
  deleteModelCatalogMapping,
  deleteModelCatalogModel,
  deleteModelCatalogVendor,
  deleteProject,
  ensureBuiltinModelSeeds,
  exportModelCatalogPackage,
  fetchModelCatalogDocs,
  fetchTaskResult,
  finishExportTempInput,
  getExportJobStatus,
  getModelCatalogHealth,
  importLocalFile,
  importModelCatalogPackage,
  importRemoteAsset,
  listModelCatalogMappings,
  listModelCatalogModels,
  listModelCatalogVendors,
  listProjectAssets,
  listProjects,
  readProject,
  resolveOnboardingAgentFromCatalog,
  runAgentChat,
  runAgentChatV2,
  runTask,
  saveProject,
  startExportJob,
  subscribeExportJobEvents,
  testModelCatalogMapping,
  upsertModelCatalogMapping,
  upsertModelCatalogModel,
  upsertModelCatalogVendor,
  upsertModelCatalogVendorApiKey,
  writeExportTempInput,
} from "../runtime";
import { openWorkspaceFolder } from "../workspace/workspaceIpc";
import type { WorkspaceOpenFolderPayload } from "../workspace/workspaceIpc";
import { listWorkspaceFiles } from "../workspace/workspaceFileIndex";
import { EventHub } from "./eventHub";
import {
  decodeTransportValue,
  handleOptions,
  readJsonBody,
  requestUrl,
  sendError,
  sendJson,
  sendRpcError,
  sendRpcValue,
  type JsonRecord,
} from "./http";
import { attachSse } from "./sse";
import { handleAssetFileRequest } from "./assetFiles";

type PendingConfirmation = {
  resolve: (decision: { ok: true; result: unknown } | { ok: false; message: string }) => void;
};

type AgentSession = {
  sessionId: string;
  hub: EventHub<unknown>;
  pendingConfirmations: Map<string, PendingConfirmation>;
  cancelled: boolean;
};

type OnboardingSession = {
  trialId: string;
  hub: EventHub<unknown>;
  cancelled: boolean;
};

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" ? value as JsonRecord : {};
}

function headersFromPayload(payload: JsonRecord): Record<string, string> {
  const headers: Record<string, string> = {};
  if (!payload.headers || typeof payload.headers !== "object") return headers;
  for (const [key, value] of Object.entries(payload.headers as JsonRecord)) {
    headers[String(key)] = String(value ?? "");
  }
  return headers;
}

function createOnboardingAgent(payload: JsonRecord): {
  providerKind: ProviderKind;
  baseUrl: string;
  modelId: string;
  apiKey: string;
  extraHeaders?: Record<string, string>;
} {
  const agentConfig = asRecord(payload.agent);
  const fromCatalog = resolveOnboardingAgentFromCatalog();
  const agent = {
    providerKind: String(
      agentConfig.providerKind || fromCatalog?.providerKind || process.env.NOMI_ONBOARDING_AGENT_PROVIDER || "openai-compatible",
    ) as ProviderKind,
    baseUrl: String(agentConfig.baseUrl || fromCatalog?.baseUrl || process.env.NOMI_ONBOARDING_AGENT_BASE_URL || ""),
    modelId: String(agentConfig.modelId || fromCatalog?.modelId || process.env.NOMI_ONBOARDING_AGENT_MODEL || ""),
    apiKey: String(agentConfig.apiKey || fromCatalog?.apiKey || process.env.NOMI_ONBOARDING_AGENT_KEY || ""),
    ...(fromCatalog?.extraHeaders ? { extraHeaders: fromCatalog.extraHeaders } : {}),
  };
  if (!agent.baseUrl || !agent.modelId || !agent.apiKey) {
    throw new Error("Onboarding agent not configured. Add a text model in 模型设置 first.");
  }
  return agent;
}

export type RuntimeWebApi = {
  handle: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
  close: () => void;
};

export function createRuntimeWebApi(): RuntimeWebApi {
  ensureBuiltinModelSeeds();

  const selectedWorkspaceRoots = new Set<string>();
  const exportHub = new EventHub<unknown>();
  const agentSessions = new Map<string, AgentSession>();
  const onboardingSessions = new Map<string, OnboardingSession>();
  const unsubscribeExportEvents = subscribeExportJobEvents((event) => exportHub.emit(event));

  const createAgentSession = (payload: unknown): { sessionId: string } => {
    const sessionId = `chatV2-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const session: AgentSession = {
      sessionId,
      hub: new EventHub<unknown>(100),
      pendingConfirmations: new Map(),
      cancelled: false,
    };
    agentSessions.set(sessionId, session);
    queueMicrotask(() => {
      void runAgentChatV2(payload as Parameters<typeof runAgentChatV2>[0], {
        emit: (event) => session.hub.emit(event),
        awaitToolConfirmation: ({ toolCallId, toolName, args }) => new Promise((resolve) => {
          if (session.cancelled) {
            resolve({ ok: false, message: "session cancelled" });
            return;
          }
          session.pendingConfirmations.set(toolCallId, { resolve });
          session.hub.emit({ type: "tool-call-pending", toolCallId, toolName, args });
        }),
      })
        .then((result) => {
          session.hub.emit({ type: "result", result });
          session.hub.emit({ type: "done", reason: "finished" });
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          session.hub.emit({ type: "error", message });
          session.hub.emit({ type: "done", reason: "error" });
        })
        .finally(() => {
          setTimeout(() => agentSessions.delete(sessionId), 60_000);
        });
    });
    return { sessionId };
  };

  const startOnboarding = (payload: unknown): { trialId: string } => {
    const raw = asRecord(payload);
    const docsUrl = String(raw.docsUrl || "").trim();
    const userApiKey = String(raw.userApiKey || "").trim();
    if (!docsUrl) throw new Error("docsUrl required");
    if (!userApiKey) throw new Error("userApiKey required");
    const trialId = `onboard-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const session: OnboardingSession = { trialId, hub: new EventHub<unknown>(200), cancelled: false };
    onboardingSessions.set(trialId, session);
    const agent = createOnboardingAgent(raw);
    const targetKind = raw.targetKind as ModelKind | undefined;
    queueMicrotask(() => {
      void runOnboardingTrial({
        trialId,
        docsUrl,
        targetKind: targetKind ?? ("image" as ModelKind),
        userApiKey,
        agent,
        maxSteps: Number(raw.maxSteps) || 14,
        onEvent: (event) => session.hub.emit(event),
      })
        .then((outcome) => {
          let committedModel: unknown = null;
          if (outcome.status === "success") {
            try {
              committedModel = commitOnboardedModelToCatalog({ outcome, userApiKey });
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              session.hub.emit({ type: "commit-error", message });
            }
          }
          session.hub.emit({ type: "result", outcome, committedModel });
          session.hub.emit({ type: "done", reason: "finished" });
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          session.hub.emit({ type: "error", message });
          session.hub.emit({ type: "done", reason: "error" });
        })
        .finally(() => {
          setTimeout(() => onboardingSessions.delete(trialId), 60_000);
        });
    });
    return { trialId };
  };

  const callRpc = async (method: string, args: unknown[]): Promise<unknown> => {
    switch (method) {
      case "workspace.selectFolder":
        return { canceled: true };
      case "workspace.openFolder": {
        const payload = asRecord(args[0]);
        const rootPath = path.resolve(String(payload.rootPath || ""));
        selectedWorkspaceRoots.add(rootPath);
        return openWorkspaceFolder(payload as WorkspaceOpenFolderPayload, {
          createProject,
          selectedRootPaths: selectedWorkspaceRoots,
          confirmInitialize: () => Boolean(payload.initialize),
        });
      }
      case "workspace.listFiles": {
        const payload = asRecord(args[0]);
        const projectId = String(payload.projectId || "").trim();
        if (!projectId) throw new Error("projectId is required");
        const project = readProject(projectId) as { lastKnownRootPath?: unknown } | null;
        const rootPath = typeof project?.lastKnownRootPath === "string" ? project.lastKnownRootPath : "";
        if (!rootPath) throw new Error("Project folder is unavailable");
        return listWorkspaceFiles({ rootPath, maxFiles: typeof payload.limit === "number" ? payload.limit : undefined });
      }
      case "workspace.revealFile":
        return { ok: false };
      case "projects.list":
        return listProjects();
      case "projects.create":
        return createProject(args[0]);
      case "projects.read":
        return readProject(String(args[0] || ""));
      case "projects.save":
        return saveProject(String(args[0] || ""), args[1]);
      case "projects.delete":
        return deleteProject(String(args[0] || ""));
      case "assets.list":
        return listProjectAssets(args[0]);
      case "assets.importRemoteUrl":
        return importRemoteAsset(args[0]);
      case "assets.importFile":
        return importLocalFile(args[0]);
      case "exports.startJob":
        return startExportJob(args[0]);
      case "exports.writeTempInput":
        return writeExportTempInput(args[0]);
      case "exports.finishTempInput":
        return finishExportTempInput(args[0]);
      case "exports.status":
        return getExportJobStatus(String(args[0] || ""));
      case "exports.cancel":
        return cancelExportJob(String(args[0] || ""));
      case "exports.showInFolder":
        return { ok: false };
      case "tasks.run":
        return runTask(args[0]);
      case "tasks.result":
        return fetchTaskResult(args[0]);
      case "agents.chat":
        return runAgentChat(args[0]);
      case "agents.chatV2Start":
        return createAgentSession(args[0]);
      case "agents.confirmTool": {
        const [sessionId, toolCallId, decision] = args as [string, string, JsonRecord];
        const session = agentSessions.get(sessionId);
        if (!session) return { ok: false, error: "session not found" };
        const pending = session.pendingConfirmations.get(toolCallId);
        if (!pending) return { ok: false, error: "tool call not pending" };
        session.pendingConfirmations.delete(toolCallId);
        pending.resolve(decision?.ok === true
          ? { ok: true, result: decision.result ?? null }
          : { ok: false, message: String(decision?.message || "rejected by user") });
        return { ok: true };
      }
      case "agents.cancelChatV2": {
        const session = agentSessions.get(String(args[0] || ""));
        if (!session) return { ok: false, error: "session not found" };
        session.cancelled = true;
        for (const [toolCallId, pending] of session.pendingConfirmations) {
          pending.resolve({ ok: false, message: "session cancelled" });
          session.pendingConfirmations.delete(toolCallId);
        }
        return { ok: true };
      }
      case "agents.clearChatV2Session":
        clearAgentChatV2History(String(args[0] || ""));
        return { ok: true };
      case "onboarding.start":
        return startOnboarding(args[0]);
      case "onboarding.cancel": {
        const session = onboardingSessions.get(String(args[0] || ""));
        if (!session) return { ok: false, error: "session not found" };
        session.cancelled = true;
        session.hub.emit({ type: "cancelled" });
        return { ok: true };
      }
      case "onboarding.manualCommit": {
        const payload = asRecord(args[0]);
        try {
          const result = commitManualOpenAiCompatibleModels({
            vendorName: String(payload.vendorName || ""),
            baseUrl: String(payload.baseUrl || ""),
            apiKey: String(payload.apiKey || ""),
            providerKind: payload.providerKind === "anthropic" ? "anthropic" : "openai-compatible",
            headers: headersFromPayload(payload),
            models: Array.isArray(payload.models)
              ? (payload.models as JsonRecord[]).map((model) => ({
                  id: String(model?.id || ""),
                  displayName: model?.displayName ? String(model.displayName) : undefined,
                }))
              : [],
          });
          return { ok: true, vendorKey: result.vendorKey, committed: result.committed };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { ok: false, error: message };
        }
      }
      case "onboarding.testConnection":
        return testOnboardingConnection(asRecord(args[0]));
      case "onboarding.listModels":
        return listOnboardingModels(asRecord(args[0]));
      case "modelCatalog.listVendors":
        return listModelCatalogVendors();
      case "modelCatalog.listModels":
        return listModelCatalogModels(args[0]);
      case "modelCatalog.listMappings":
        return listModelCatalogMappings(args[0]);
      case "modelCatalog.health":
        return getModelCatalogHealth();
      case "modelCatalog.upsertVendor":
        return upsertModelCatalogVendor(args[0]);
      case "modelCatalog.deleteVendor":
        return deleteModelCatalogVendor(String(args[0] || ""));
      case "modelCatalog.upsertVendorApiKey":
        return upsertModelCatalogVendorApiKey(String(args[0] || ""), args[1]);
      case "modelCatalog.clearVendorApiKey":
        return clearModelCatalogVendorApiKey(String(args[0] || ""));
      case "modelCatalog.upsertModel":
        return upsertModelCatalogModel(args[0]);
      case "modelCatalog.deleteModel":
        return deleteModelCatalogModel(String(args[0] || ""), String(args[1] || ""));
      case "modelCatalog.upsertMapping":
        return upsertModelCatalogMapping(args[0]);
      case "modelCatalog.deleteMapping":
        return deleteModelCatalogMapping(String(args[0] || ""));
      case "modelCatalog.exportPackage":
        return exportModelCatalogPackage(args[0]);
      case "modelCatalog.importPackage":
        return importModelCatalogPackage(args[0]);
      case "modelCatalog.testMapping":
        return testModelCatalogMapping(String(args[0] || ""), args[1]);
      case "modelCatalog.fetchDocs":
        return fetchModelCatalogDocs(args[0]);
      default:
        throw new Error(`Unknown Web RPC method: ${method}`);
    }
  };

  const handleRpc = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const body = asRecord(await readJsonBody(req));
    const method = String(body.method || "");
    const args = Array.isArray(body.args) ? decodeTransportValue(body.args) as unknown[] : [];
    if (!method) throw new Error("method is required");
    sendRpcValue(req, res, await callRpc(method, args));
  };

  const handleEvents = (req: IncomingMessage, res: ServerResponse, pathname: string): boolean => {
    if (pathname === "/api/events/exports") {
      attachSse(req, res, exportHub);
      return true;
    }
    const agentPrefix = "/api/events/agents/";
    if (pathname.startsWith(agentPrefix)) {
      const session = agentSessions.get(decodeURIComponent(pathname.slice(agentPrefix.length)));
      if (!session) sendError(req, res, 404, "session not found");
      else attachSse(req, res, session.hub);
      return true;
    }
    const onboardingPrefix = "/api/events/onboarding/";
    if (pathname.startsWith(onboardingPrefix)) {
      const session = onboardingSessions.get(decodeURIComponent(pathname.slice(onboardingPrefix.length)));
      if (!session) sendError(req, res, 404, "trial not found");
      else attachSse(req, res, session.hub);
      return true;
    }
    return false;
  };

  return {
    handle: async (req, res) => {
      const { pathname } = requestUrl(req);
      if (!pathname.startsWith("/api/")) return false;
      if (handleOptions(req, res)) return true;
      if (handleAssetFileRequest(req, res, pathname)) return true;
      if (handleEvents(req, res, pathname)) return true;
      if (pathname === "/api/health") {
        sendJson(req, res, 200, { ok: true, runtime: "web", time: new Date().toISOString() });
        return true;
      }
      if (pathname === "/api/rpc" && req.method === "POST") {
        try {
          await handleRpc(req, res);
        } catch (error) {
          sendRpcError(req, res, error);
        }
        return true;
      }
      sendError(req, res, 404, "API route not found");
      return true;
    },
    close: () => {
      unsubscribeExportEvents();
    },
  };
}
