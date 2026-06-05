import type { DesktopBridge } from '../desktop/bridge'

type RpcEnvelope =
  | { ok: true; value?: unknown }
  | { ok: false; error?: string }

type TransportBytes = { __nomiBytesBase64: string }

function webRuntimeEnabled(): boolean {
  return import.meta.env.VITE_NOMI_RUNTIME === 'web'
}

function apiBase(): string {
  return (import.meta.env.VITE_NOMI_API_BASE || '/api').replace(/\/+$/, '')
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize)
    binary += String.fromCharCode(...chunk)
  }
  return btoa(binary)
}

function base64ToBytes(value: string): ArrayBuffer {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes.buffer
}

function isTransportBytes(value: unknown): value is TransportBytes {
  return Boolean(
    value &&
    typeof value === 'object' &&
    typeof (value as { __nomiBytesBase64?: unknown }).__nomiBytesBase64 === 'string',
  )
}

function encodeTransportValue(value: unknown): unknown {
  if (value instanceof ArrayBuffer) return { __nomiBytesBase64: bytesToBase64(new Uint8Array(value)) }
  if (ArrayBuffer.isView(value)) {
    const view = value as Uint8Array
    return { __nomiBytesBase64: bytesToBase64(new Uint8Array(view.buffer, view.byteOffset, view.byteLength)) }
  }
  if (Array.isArray(value)) return value.map((item) => encodeTransportValue(item))
  if (!value || typeof value !== 'object') return value
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = encodeTransportValue(item)
  return out
}

function decodeTransportValue(value: unknown): unknown {
  if (isTransportBytes(value)) return base64ToBytes(value.__nomiBytesBase64)
  if (Array.isArray(value)) return value.map((item) => decodeTransportValue(item))
  if (!value || typeof value !== 'object') return value
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = decodeTransportValue(item)
  return out
}

function toWebAssetUrl(value: string): string {
  if (!value.startsWith('nomi-local://')) return value
  try {
    const url = new URL(value)
    if (url.hostname !== 'asset' || !url.pathname) return value
    return `${apiBase()}/assets/file${url.pathname}`
  } catch {
    return value
  }
}

function toRuntimeAssetUrl(value: string): string {
  try {
    const baseUrl = new URL(apiBase(), window.location.origin)
    const candidate = new URL(value, window.location.origin)
    const assetPrefix = `${baseUrl.pathname.replace(/\/+$/, '')}/assets/file/`
    if (candidate.origin !== baseUrl.origin || !candidate.pathname.startsWith(assetPrefix)) return value
    return `nomi-local://asset/${candidate.pathname.slice(assetPrefix.length)}`
  } catch {
    return value
  }
}

export function toWebRuntimeValue(value: unknown): unknown {
  if (typeof value === 'string') return toWebAssetUrl(value)
  if (Array.isArray(value)) return value.map((item) => toWebRuntimeValue(item))
  if (!value || typeof value !== 'object') return value
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = toWebRuntimeValue(item)
  return out
}

export function toBackendRuntimeValue(value: unknown): unknown {
  if (typeof value === 'string') return toRuntimeAssetUrl(value)
  if (Array.isArray(value)) return value.map((item) => toBackendRuntimeValue(item))
  if (!value || typeof value !== 'object') return value
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = toBackendRuntimeValue(item)
  return out
}

async function rpc(method: string, ...args: unknown[]): Promise<unknown> {
  const response = await fetch(`${apiBase()}/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      method,
      args: encodeTransportValue(toBackendRuntimeValue(args)),
    }),
  })
  if (!response.ok) throw new Error(`Web runtime HTTP ${response.status}`)
  const envelope = (await response.json()) as RpcEnvelope
  if (!envelope.ok) throw new Error(envelope.error || `Web runtime failed: ${method}`)
  return toWebRuntimeValue(decodeTransportValue(envelope.value))
}

function rpcSync(method: string, ...args: unknown[]): unknown {
  const request = new XMLHttpRequest()
  request.open('POST', `${apiBase()}/rpc`, false)
  request.setRequestHeader('content-type', 'application/json')
  request.send(JSON.stringify({
    method,
    args: encodeTransportValue(toBackendRuntimeValue(args)),
  }))
  if (request.status < 200 || request.status >= 300) throw new Error(`Web runtime HTTP ${request.status}`)
  const envelope = JSON.parse(request.responseText || '{}') as RpcEnvelope
  if (!envelope.ok) throw new Error(envelope.error || `Web runtime failed: ${method}`)
  return toWebRuntimeValue(decodeTransportValue(envelope.value))
}

function subscribeSse(path: string, callback: (event: unknown) => void): () => void {
  const events = new EventSource(`${apiBase()}${path}`)
  events.onmessage = (event) => {
    try {
      callback(toWebRuntimeValue(JSON.parse(event.data)))
    } catch {
      /* ignore malformed event */
    }
  }
  return () => events.close()
}

export function createWebBridge(): DesktopBridge {
  return {
    platform: 'web',
    logRendererCrash: (message: unknown) => {
      console.error('[nomi:web:renderer]', message)
    },
    workspace: {
      selectFolder: () => rpc('workspace.selectFolder') as Promise<{ canceled: true } | { canceled: false; rootPath: string }>,
      openFolder: (payload) => rpc('workspace.openFolder', payload),
      listFiles: (payload) => rpc('workspace.listFiles', payload) as ReturnType<DesktopBridge['workspace']['listFiles']>,
      revealFile: (payload) => rpc('workspace.revealFile', payload) as Promise<{ ok: boolean }>,
    },
    projects: {
      list: () => rpcSync('projects.list') as unknown[],
      create: (record) => rpcSync('projects.create', record),
      read: (projectId) => rpcSync('projects.read', projectId) as unknown | null,
      save: (projectId, record) => rpcSync('projects.save', projectId, record),
      delete: (projectId) => rpcSync('projects.delete', projectId) as { id: string; deleted: boolean },
    },
    assets: {
      list: (payload) => rpc('assets.list', payload) as ReturnType<DesktopBridge['assets']['list']>,
      importRemoteUrl: (payload) => rpc('assets.importRemoteUrl', payload) as ReturnType<DesktopBridge['assets']['importRemoteUrl']>,
      importFile: (payload) => rpc('assets.importFile', payload) as ReturnType<DesktopBridge['assets']['importFile']>,
    },
    exports: {
      startJob: (payload) => rpc('exports.startJob', payload) as ReturnType<DesktopBridge['exports']['startJob']>,
      writeTempInput: (payload) => rpc('exports.writeTempInput', payload) as ReturnType<DesktopBridge['exports']['writeTempInput']>,
      finishTempInput: (payload) => rpc('exports.finishTempInput', payload) as ReturnType<DesktopBridge['exports']['finishTempInput']>,
      status: (jobId) => rpc('exports.status', jobId) as ReturnType<DesktopBridge['exports']['status']>,
      cancel: (jobId) => rpc('exports.cancel', jobId) as ReturnType<DesktopBridge['exports']['cancel']>,
      onEvent: (callback) => subscribeSse('/events/exports', callback as (event: unknown) => void),
      showInFolder: (payload) => rpc('exports.showInFolder', payload) as Promise<{ ok: boolean }>,
    },
    tasks: {
      run: (payload) => rpc('tasks.run', payload),
      result: (payload) => rpc('tasks.result', payload),
    },
    agents: {
      chat: (payload) => rpc('agents.chat', payload),
      chatV2Start: (payload) => rpc('agents.chatV2Start', payload) as Promise<{ sessionId: string }>,
      confirmTool: (sessionId, toolCallId, decision) =>
        rpc('agents.confirmTool', sessionId, toolCallId, decision) as Promise<{ ok: boolean; error?: string }>,
      cancelChatV2: (sessionId) => rpc('agents.cancelChatV2', sessionId) as Promise<{ ok: boolean; error?: string }>,
      clearChatV2Session: (sessionKey) =>
        rpc('agents.clearChatV2Session', sessionKey) as Promise<{ ok: boolean; error?: string }>,
      onChatV2Event: (sessionId, callback) => subscribeSse(`/events/agents/${encodeURIComponent(sessionId)}`, callback),
    },
    onboarding: {
      start: (payload) => rpc('onboarding.start', payload) as Promise<{ trialId: string }>,
      cancel: (trialId) => rpc('onboarding.cancel', trialId) as Promise<{ ok: boolean; error?: string }>,
      onEvent: (trialId, callback) => subscribeSse(`/events/onboarding/${encodeURIComponent(trialId)}`, callback),
      manualCommit: (payload) => rpc('onboarding.manualCommit', payload) as ReturnType<DesktopBridge['onboarding']['manualCommit']>,
      testConnection: (payload) => rpc('onboarding.testConnection', payload) as ReturnType<DesktopBridge['onboarding']['testConnection']>,
      listModels: (payload) => rpc('onboarding.listModels', payload) as ReturnType<DesktopBridge['onboarding']['listModels']>,
    },
    modelCatalog: {
      listVendors: () => rpcSync('modelCatalog.listVendors') as unknown[],
      listModels: (params) => rpcSync('modelCatalog.listModels', params) as unknown[],
      listMappings: (params) => rpcSync('modelCatalog.listMappings', params) as unknown[],
      health: () => rpcSync('modelCatalog.health'),
      upsertVendor: (payload) => rpcSync('modelCatalog.upsertVendor', payload),
      deleteVendor: (key) => { rpcSync('modelCatalog.deleteVendor', key) },
      upsertVendorApiKey: (vendorKey, payload) => rpcSync('modelCatalog.upsertVendorApiKey', vendorKey, payload),
      clearVendorApiKey: (vendorKey) => rpcSync('modelCatalog.clearVendorApiKey', vendorKey),
      upsertModel: (payload) => rpcSync('modelCatalog.upsertModel', payload),
      deleteModel: (vendorKey, modelKey) => { rpcSync('modelCatalog.deleteModel', vendorKey, modelKey) },
      upsertMapping: (payload) => rpcSync('modelCatalog.upsertMapping', payload),
      deleteMapping: (id) => { rpcSync('modelCatalog.deleteMapping', id) },
      exportPackage: (params) => rpcSync('modelCatalog.exportPackage', params),
      importPackage: (payload) => rpcSync('modelCatalog.importPackage', payload),
      testMapping: (id, payload) => rpc('modelCatalog.testMapping', id, payload),
      fetchDocs: (payload) => rpc('modelCatalog.fetchDocs', payload),
    },
  }
}

export function installWebBridge(): void {
  if (typeof window === 'undefined') return
  if (!webRuntimeEnabled()) return
  if (window.nomiDesktop) return
  window.nomiDesktop = createWebBridge()
}
