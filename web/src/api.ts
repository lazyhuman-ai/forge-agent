import type {
  DeviceState,
  Diagnostics,
  ExtensionCandidate,
  ExtensionInstallResult,
  ExtensionKind,
  ExtensionStatus,
  HtmlFilePreview,
  McpElicitationRequest,
  McpServerStatus,
  McpToolMetadata,
  NetworkUrls,
  PermissionRequest,
  Project,
  RemoteAccessStatus,
  Session,
  SessionBranchState,
  SessionEvent,
  SessionUsageSummary,
  SetupStatus,
  TerminalSession,
  UploadedSessionFile,
} from "./types";

const TOKEN_KEY = "forgeagent.web.token";
const DEVICE_NAME = "ForgeAgent Web Console";

export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export async function ensureDeviceToken(): Promise<string> {
  const cached = localStorage.getItem(TOKEN_KEY);
  if (cached) return cached;

  const codeResponse = await fetch("/auth/pairing-codes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ baseUrl: window.location.origin }),
  });
  const codeData = await parseResponse<{ code: string }>(codeResponse);
  const pairResponse = await fetch("/auth/pair", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: codeData.code, name: DEVICE_NAME, kind: "web" }),
  });
  const pairData = await parseResponse<{ token: string }>(pairResponse);
  localStorage.setItem(TOKEN_KEY, pairData.token);
  return pairData.token;
}

export async function pairWithCode(code: string): Promise<string> {
  const pairResponse = await fetch("/auth/pair", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, name: DEVICE_NAME, kind: "web" }),
  });
  const pairData = await parseResponse<{ token: string }>(pairResponse);
  localStorage.setItem(TOKEN_KEY, pairData.token);
  return pairData.token;
}

export function forgetDeviceToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

export async function apiFetch<T>(
  path: string,
  init: RequestInit = {},
  retry = true,
): Promise<T> {
  const token = await ensureDeviceToken();
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  headers.set("X-ForgeAgent-API", "1");
  headers.set("Authorization", `Bearer ${token}`);
  if (init.body && !(init.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(path, { ...init, headers });
  if (response.status === 401 && retry) {
    forgetDeviceToken();
    return apiFetch<T>(path, init, false);
  }
  return parseResponse<T>(response);
}

export async function parseResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text) as unknown;
    } catch {
      const snippet = text.replace(/\s+/g, " ").trim().slice(0, 160);
      throw new ApiError(
        response.status,
        `ForgeAgent API returned non-JSON content${snippet ? `: ${snippet}` : "."}`,
      );
    }
  }
  if (!response.ok) {
    const message = data && typeof data === "object" && "error" in data
      ? String((data as { error: unknown }).error)
      : `${response.status} ${response.statusText}`;
    throw new ApiError(response.status, message);
  }
  return data as T;
}

export const api = {
  setupStatus: () => apiFetch<SetupStatus>("/setup/status"),
  saveProvider: (input: { apiKey?: string; baseUrl?: string; model?: string; contextWindowTokens?: number }) =>
    apiFetch<SetupStatus>("/setup/provider", { method: "POST", body: JSON.stringify(input) }),
  testProvider: (input: { apiKey?: string; baseUrl?: string; model?: string; contextWindowTokens?: number }) =>
    apiFetch<{ ok: boolean; message: string }>("/setup/provider/test", { method: "POST", body: JSON.stringify(input) }),
  networkUrls: () => apiFetch<NetworkUrls>("/network-urls"),
  remoteAccess: () => apiFetch<RemoteAccessStatus>("/remote-access"),
  optimizeTailscale: () => apiFetch<RemoteAccessStatus>("/remote-access/tailscale/optimize", { method: "POST" }),
  createPairingCode: (baseUrl: string) =>
    apiFetch<{ code: string; expiresAt: string; pairingUrl: string }>("/auth/pairing-codes", {
      method: "POST",
      body: JSON.stringify({ baseUrl }),
    }),
  diagnostics: () => apiFetch<Diagnostics>("/diagnostics"),
  deviceState: () => apiFetch<DeviceState>("/device-state"),
  patchDeviceState: (input: Partial<Pick<DeviceState, "selectedProjectId" | "selectedSessionId" | "selectedBranchBySession" | "sessionReadSeq" | "mutedSessionIds" | "notificationSettings">>) =>
    apiFetch<DeviceState>("/device-state", { method: "PATCH", body: JSON.stringify(input) }),
  projects: () => apiFetch<Project[]>("/projects"),
  createProject: (input: { name?: string; path?: string; create?: boolean; trustState?: "trusted" | "untrusted" }) =>
    apiFetch<Project>("/projects", { method: "POST", body: JSON.stringify(input) }),
  updateProject: (projectId: string, input: { name?: string; trustState?: "trusted" | "untrusted" }) =>
    apiFetch<Project>(`/projects/${projectId}`, { method: "PATCH", body: JSON.stringify(input) }),
  archiveProject: (projectId: string) =>
    apiFetch<Project>(`/projects/${projectId}`, { method: "DELETE" }),
  sessions: (projectId?: string) => apiFetch<Session[]>(projectId ? `/sessions?projectId=${encodeURIComponent(projectId)}` : "/sessions"),
  projectSessions: (projectId: string) => apiFetch<Session[]>(`/projects/${projectId}/sessions`),
  createSession: (title: string, projectId?: string) => apiFetch<Session>("/sessions", { method: "POST", body: JSON.stringify({ title, ...(projectId ? { projectId } : {}) }) }),
  updateSession: (sessionId: string, input: { dangerouslyAllowAllTools?: boolean; title?: string; muted?: boolean }) =>
    apiFetch<Session>(`/sessions/${sessionId}`, { method: "PATCH", body: JSON.stringify(input) }),
  deleteSession: (sessionId: string) => apiFetch<{ deleted: boolean }>(`/sessions/${sessionId}`, { method: "DELETE" }),
  branches: (sessionId: string) => apiFetch<SessionBranchState>(`/sessions/${sessionId}/branches`),
  thread: (sessionId: string, afterSeq = 0, branchId?: string) => {
    const params = new URLSearchParams({ afterSeq: String(afterSeq) });
    if (branchId) params.set("branchId", branchId);
    return apiFetch<SessionEvent[]>(`/sessions/${sessionId}/thread?${params.toString()}`);
  },
  usage: (sessionId: string) => apiFetch<SessionUsageSummary>(`/sessions/${sessionId}/usage`),
  sendMessage: (sessionId: string, text: string, branchId?: string) => apiFetch<Session>(`/sessions/${sessionId}/messages`, {
    method: "POST",
    body: JSON.stringify({ text, ...(branchId ? { branchId } : {}) }),
  }),
  createMessageVariant: (sessionId: string, sourceSeq: number, replacementText: string) =>
    apiFetch<SessionBranchState>(`/sessions/${sessionId}/messages/${sourceSeq}/variants`, {
      method: "POST",
      body: JSON.stringify({ replacementText }),
    }),
  uploadFiles: (sessionId: string, files: File[]) => {
    const form = new FormData();
    for (const file of files) form.append("files", file, file.name);
    return apiFetch<{ files: UploadedSessionFile[] }>(`/sessions/${sessionId}/uploads`, {
      method: "POST",
      body: form,
    });
  },
  transcribeVoice: (audio: Blob, options?: { mode?: "final" | "preview" }) => {
    const form = new FormData();
    const extension = audio.type.includes("wav")
      ? "wav"
      : audio.type.includes("mp4")
        ? "mp4"
        : audio.type.includes("ogg")
          ? "ogg"
          : "webm";
    form.append("audio", audio, `voice-input.${extension}`);
    const query = options?.mode === "preview" ? "?mode=preview" : "";
    return apiFetch<{ text: string; model: string; language: string }>(`/voice/transcriptions${query}`, {
      method: "POST",
      body: form,
    });
  },
  interrupt: (sessionId: string) => apiFetch<Record<string, unknown>>(`/sessions/${sessionId}/interrupt`, { method: "POST" }),
  retry: (sessionId: string) => apiFetch<Record<string, unknown>>(`/sessions/${sessionId}/retry`, { method: "POST" }),
  pendingPermissions: () => apiFetch<PermissionRequest[]>("/permission-requests?status=pending"),
  respondPermission: (id: string, decision: "allow_once" | "allow_session" | "deny") =>
    apiFetch<PermissionRequest>(`/permission-requests/${id}/respond`, {
      method: "POST",
      body: JSON.stringify({ decision }),
    }),
  extensions: () => apiFetch<ExtensionStatus>("/extensions"),
  searchExtensions: (input: { query?: string; link?: string; includeInstalled?: boolean }) => {
    const params = new URLSearchParams();
    if (input.query) params.set("query", input.query);
    if (input.link) params.set("link", input.link);
    if (input.includeInstalled) params.set("includeInstalled", "true");
    return apiFetch<{ candidates: ExtensionCandidate[] }>(`/extensions/search?${params.toString()}`);
  },
  installExtension: (installInput: Record<string, unknown>) =>
    apiFetch<ExtensionInstallResult>("/extensions/install", {
      method: "POST",
      body: JSON.stringify({ installInput }),
    }),
  extensionSources: () => apiFetch<ExtensionStatus["registry"]["sources"]>("/extensions/sources"),
  addExtensionSource: (input: { kind: "file" | "http" | "github"; name: string; url?: string; path?: string; trustUnsigned?: boolean }) =>
    apiFetch<ExtensionStatus["registry"]["sources"][number]>("/extensions/sources", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  removeExtensionSource: (sourceId: string) =>
    apiFetch<{ removed: boolean }>(`/extensions/sources/${encodeURIComponent(sourceId)}`, { method: "DELETE" }),
  refreshExtensionSource: (sourceId: string) =>
    apiFetch<ExtensionStatus["registry"]["sources"][number]>(`/extensions/sources/${encodeURIComponent(sourceId)}/refresh`, { method: "POST" }),
  extensionEvents: (afterSeq?: number) =>
    apiFetch<ExtensionStatus["registry"]["events"]>(`/extensions/events${afterSeq ? `?afterSeq=${afterSeq}` : ""}`),
  enableExtension: (kind: ExtensionKind, idOrName: string, version?: string, options?: { trustWarnings?: boolean }) =>
    apiFetch<ExtensionInstallResult>("/extensions/enable", {
      method: "POST",
      body: JSON.stringify({ kind, idOrName, ...(version ? { version } : {}), ...(options?.trustWarnings !== undefined ? { trustWarnings: options.trustWarnings } : {}) }),
    }),
  mcpServers: () => apiFetch<McpServerStatus[]>("/mcp/servers"),
  mcpTools: () => apiFetch<McpToolMetadata[]>("/mcp/tools"),
  enableMcpServer: (serverId: string) =>
    apiFetch<McpServerStatus>(`/mcp/servers/${serverId}/enable`, { method: "POST" }),
  disableMcpServer: (serverId: string) =>
    apiFetch<{ disabled: boolean }>(`/mcp/servers/${serverId}/disable`, { method: "POST" }),
  retryMcpServer: (serverId: string) =>
    apiFetch<McpServerStatus>(`/mcp/servers/${serverId}/retry`, { method: "POST" }),
  startMcpAuth: (serverId: string) =>
    apiFetch<{ status: "authorized" | "redirect"; authorizationUrl?: string }>(`/mcp/servers/${serverId}/auth`, { method: "POST" }),
  mcpElicitations: () => apiFetch<McpElicitationRequest[]>("/mcp/elicitations"),
  respondMcpElicitation: (id: string, input: { accept: boolean; content?: Record<string, unknown>; message?: string }) =>
    apiFetch<McpElicitationRequest>(`/mcp/elicitation/${id}/respond`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  artifact: (artifactId: string) => apiFetch<{
    info: { artifactId: string; mimeType: string; sizeBytes: number };
    encoding: "utf8" | "base64";
    content: string;
    truncated: boolean;
  }>(`/artifacts/${artifactId}`),
  htmlPreview: (path: string, sessionId?: string) => {
    const params = new URLSearchParams({ path });
    if (sessionId) params.set("sessionId", sessionId);
    return apiFetch<HtmlFilePreview>(`/files/preview?${params.toString()}`);
  },
  terminalSessions: () => apiFetch<TerminalSession[]>("/terminal/sessions"),
  createTerminalSession: (input: { projectId?: string; cwd?: string; shell?: string; cols?: number; rows?: number }) =>
    apiFetch<TerminalSession>("/terminal/sessions", { method: "POST", body: JSON.stringify(input) }),
  terminalSnapshot: (terminalId: string, afterSeq = 0) =>
    apiFetch<TerminalSession>(`/terminal/sessions/${terminalId}?afterSeq=${afterSeq}`),
  writeTerminalInput: (terminalId: string, data: string) =>
    apiFetch<TerminalSession>(`/terminal/sessions/${terminalId}/input`, {
      method: "POST",
      body: JSON.stringify({ data }),
    }),
  resizeTerminal: (terminalId: string, cols: number, rows: number) =>
    apiFetch<TerminalSession>(`/terminal/sessions/${terminalId}/resize`, {
      method: "POST",
      body: JSON.stringify({ cols, rows }),
    }),
  stopTerminal: (terminalId: string) =>
    apiFetch<{ stopped: boolean }>(`/terminal/sessions/${terminalId}/stop`, { method: "POST" }),
  deleteTerminal: (terminalId: string) =>
    apiFetch<{ deleted: boolean }>(`/terminal/sessions/${terminalId}`, { method: "DELETE" }),
  streamToken: () => apiFetch<{ code: string; expiresAt: string }>("/auth/stream-token", { method: "POST" }),
};
