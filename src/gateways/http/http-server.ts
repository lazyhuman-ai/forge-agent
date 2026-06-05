import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
  type Server,
} from "node:http";
import { hostname, networkInterfaces } from "node:os";
import {
  dirname,
  extname,
  join,
  resolve as pathResolve,
  sep,
} from "node:path";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import type { CoreAPI } from "../../core/core-api.js";
import { HttpGateway } from "./http-gateway.js";
import { validateSchedule } from "../../core/cron-parser.js";
import type { Trigger } from "../../core/scheduler.js";
import { DeepSeekProvider } from "../../agent/deepseek-provider.js";
import {
  AuthError,
  AuthStore,
  type AuthenticatedRequestContext,
  type DeviceKind,
  type DeviceState,
  type PublicDevice,
} from "../../auth/auth-store.js";
import type { Session, SessionEvent, SystemEvent } from "../../streams/event-types.js";
import type { ToolRequestSource } from "../../permissions/tool-policy.js";
import { FORGE_AGENT_APP_NAME, FORGE_AGENT_VERSION } from "../../core/app-info.js";
import {
  ProviderConfigStore,
  deepSeekOptionsFromConfig,
  type ProviderConfigInput,
  type SetupStatus,
} from "../../config/provider-config-store.js";
import type { McpCatalogEntry, McpLaunchMode, McpServerConfig, McpTransportKind, McpTrust } from "../../mcp/types.js";
import type { ExtensionInstallInput, ExtensionKind } from "../../extensions/types.js";

export type HttpAuthMode = "device" | "disabled";

export type HttpServerOptions = {
  authMode?: HttpAuthMode;
  authStore?: AuthStore;
  allowedOrigins?: string[];
  maxBodyBytes?: number;
  enableUi?: boolean;
  uiDir?: string;
  providerConfigStore?: ProviderConfigStore;
  applyProviderConfig?: (status: SetupStatus) => void;
  testProviderConfig?: (input: ProviderConfigInput) => Promise<{ ok: boolean; message: string }>;
  discovery?: {
    host?: string;
    port?: number;
    dataDir?: string;
  };
};

const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
const DEFAULT_ALLOWED_ORIGINS = [
  "http://localhost",
  "http://127.0.0.1",
  "http://[::1]",
];

type ResolvedHttpServerOptions = {
  authMode: HttpAuthMode;
  authStore: AuthStore;
  allowedOrigins: string[];
  maxBodyBytes: number;
  enableUi: boolean;
  uiDir: string;
  providerConfigStore: ProviderConfigStore;
  applyProviderConfig?: (status: SetupStatus) => void;
  testProviderConfig?: (input: ProviderConfigInput) => Promise<{ ok: boolean; message: string }>;
  discovery: {
    host?: string;
    port?: number;
    dataDir?: string;
  };
};

type RouteMatch = {
  handler: string;
  params: Record<string, string>;
};

type CoreIdentity = {
  coreId: string;
  desktopName: string;
  app: string;
  version: string;
  protocolVersion: number;
};

type NetworkUrls = {
  localUrl: string;
  lanUrls: string[];
  preferredUrl: string;
};

type HttpSessionView = Session & {
  latestSeq: number;
  latestAgentResultSeq: number;
  unread: boolean;
};

class JsonParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JsonParseError";
  }
}

class BodyTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BodyTooLargeError";
  }
}

type UploadedMultipartFile = {
  fieldName: string;
  filename: string;
  contentType: string;
  data: Buffer;
};

class UnauthorizedError extends Error {
  constructor(message = "Unauthorized") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

class ForbiddenError extends Error {
  constructor(message = "Forbidden") {
    super(message);
    this.name = "ForbiddenError";
  }
}

function resolveOptions(options?: HttpServerOptions): ResolvedHttpServerOptions {
  const dataDir = options?.discovery?.dataDir ?? (options?.authStore ? dirname(options.authStore.baseDir) : ".forge");
  const resolved: ResolvedHttpServerOptions = {
    authMode: options?.authMode ?? "device",
    authStore: options?.authStore ?? new AuthStore(join(dataDir, "auth")),
    allowedOrigins: options?.allowedOrigins ?? DEFAULT_ALLOWED_ORIGINS,
    maxBodyBytes: options?.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
    enableUi: options?.enableUi ?? Boolean(options?.uiDir),
    uiDir: pathResolve(options?.uiDir ?? join(process.cwd(), "web", "dist")),
    providerConfigStore: options?.providerConfigStore ?? new ProviderConfigStore(join(dataDir, "config")),
    discovery: {
      ...(options?.discovery ?? {}),
      dataDir,
    },
  };
  if (options?.applyProviderConfig) resolved.applyProviderConfig = options.applyProviderConfig;
  if (options?.testProviderConfig) resolved.testProviderConfig = options.testProviderConfig;
  return resolved;
}

function parseEnvOrigins(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const origins = raw.split(",").map((origin) => origin.trim()).filter(Boolean);
  return origins.length > 0 ? origins : undefined;
}

export function httpOptionsFromEnv(dataDir = ".forge"): HttpServerOptions {
  const options: HttpServerOptions = {
    authStore: new AuthStore(join(dataDir, "auth")),
  };
  const allowedOrigins = parseEnvOrigins(process.env.FORGE_HTTP_ALLOWED_ORIGINS);
  if (allowedOrigins) options.allowedOrigins = allowedOrigins;
  if (process.env.FORGE_HTTP_MAX_BODY_BYTES) {
    options.maxBodyBytes = Math.max(1, parseInt(process.env.FORGE_HTTP_MAX_BODY_BYTES, 10));
  }
  return options;
}

function routeUrl(req: IncomingMessage): URL {
  return new URL(req.url ?? "/", "http://localhost");
}

function isLocalhostOrigin(origin: string): boolean {
  try {
    const parsed = new URL(origin);
    return parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "::1";
  } catch {
    return false;
  }
}

function isSameHostOrigin(req: IncomingMessage, origin: string): boolean {
  try {
    const parsed = new URL(origin);
    const requestHost = req.headers.host;
    return typeof requestHost === "string" && parsed.host.toLowerCase() === requestHost.toLowerCase();
  } catch {
    return false;
  }
}

function allowedCorsOrigin(
  req: IncomingMessage,
  options: ResolvedHttpServerOptions,
): string | null | false {
  const origin = req.headers.origin;
  if (!origin) return null;
  if (options.allowedOrigins.includes(origin)) return origin;
  if (isSameHostOrigin(req, origin)) return origin;
  if (options.allowedOrigins === DEFAULT_ALLOWED_ORIGINS && isLocalhostOrigin(origin)) return origin;
  if (origin.startsWith("chrome-extension://")) return origin;
  return false;
}

function corsHeaders(origin: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
  };
  if (origin) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Vary"] = "Origin";
  }
  return headers;
}

function sendJson(
  res: ServerResponse,
  status: number,
  data: unknown,
  origin: string | null,
): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    ...corsHeaders(origin),
  });
  res.end(body);
}

function sendError(
  res: ServerResponse,
  status: number,
  message: string,
  origin: string | null,
): void {
  sendJson(res, status, { error: message }, origin);
}

function sendHtml(
  res: ServerResponse,
  status: number,
  html: string,
  origin: string | null,
): void {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    ...corsHeaders(origin),
  });
  res.end(html);
}

function serveStaticUi(
  req: IncomingMessage,
  res: ServerResponse,
  options: ResolvedHttpServerOptions,
  origin: string | null,
): boolean {
  const indexPath = pathResolve(options.uiDir, "index.html");
  if (!existsSync(options.uiDir) || !existsSync(indexPath)) {
    sendHtml(res, 200, missingUiHtml(), origin);
    return true;
  }

  const url = routeUrl(req);
  const target = resolveUiFile(options.uiDir, url.pathname);
  if (!target) {
    sendError(res, 404, "Not found", origin);
    return true;
  }

  let filePath = target;
  if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
    if (extname(url.pathname)) {
      sendError(res, 404, "Not found", origin);
      return true;
    }
    filePath = indexPath;
  }

  const content = readFileSync(filePath);
  res.writeHead(200, {
    "Content-Type": contentType(filePath),
    ...corsHeaders(origin),
  });
  if (req.method === "HEAD") {
    res.end();
  } else {
    res.end(content);
  }
  return true;
}

const API_ROUTE_PREFIXES = new Set([
  "artifacts",
  "auth",
  "device-state",
  "diagnostics",
  "discovery",
  "events",
  "extensions",
  "files",
  "health",
  "identity",
  "mcp",
  "network-urls",
  "permission-requests",
  "projects",
  "sessions",
  "setup",
  "skill-events",
  "skill-sources",
  "skills",
  "system-events",
  "webridge",
]);

function isApiLikeRequest(req: IncomingMessage): boolean {
  if (req.headers["x-forgeagent-api"] === "1") return true;
  const accept = String(req.headers.accept ?? "");
  if (accept.includes("application/json") && !accept.includes("text/html")) return true;
  const pathname = routeUrl(req).pathname;
  const first = pathname.split("/").filter(Boolean)[0];
  return first !== undefined && API_ROUTE_PREFIXES.has(first);
}

function resolveUiFile(root: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const relative = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const candidate = pathResolve(root, relative);
  const rootWithSep = root.endsWith(sep) ? root : `${root}${sep}`;
  if (candidate !== root && !candidate.startsWith(rootWithSep)) return null;
  return candidate;
}

function contentType(filePath: string): string {
  switch (extname(filePath).toLowerCase()) {
    case ".html": return "text/html; charset=utf-8";
    case ".js": return "text/javascript; charset=utf-8";
    case ".css": return "text/css; charset=utf-8";
    case ".svg": return "image/svg+xml";
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".json": return "application/json; charset=utf-8";
    case ".ico": return "image/x-icon";
    default: return "application/octet-stream";
  }
}

function missingUiHtml(): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>ForgeAgent Web Console</title></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; padding: 48px; line-height: 1.5;">
  <h1>ForgeAgent Web Console is not built yet.</h1>
  <p>Run <code>npm run ui:build</code>, then restart the ForgeAgent gateway.</p>
  <p>The JSON API is still available.</p>
</body>
</html>`;
}

function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    let size = 0;
    let done = false;
    req.on("data", (chunk: Buffer) => {
      if (done) return;
      size += chunk.length;
      if (size > maxBytes) {
        done = true;
        req.pause();
        reject(new BodyTooLargeError(`Request body exceeds ${maxBytes} bytes.`));
        return;
      }
      data += chunk.toString("utf-8");
    });
    req.on("end", () => {
      if (!done) resolve(data);
    });
    req.on("error", (err) => {
      if (!done) reject(err);
    });
  });
}

function atomicWrite(filePath: string, content: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  writeFileSync(tmp, content, "utf-8");
  renameSync(tmp, filePath);
}

function readJson<T>(filePath: string): T | null {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, "utf-8")) as T;
  } catch {
    return null;
  }
}

function identityPath(options: ResolvedHttpServerOptions): string {
  return join(options.discovery.dataDir ?? ".forge", "identity.json");
}

function getCoreIdentity(options: ResolvedHttpServerOptions): CoreIdentity {
  const filePath = identityPath(options);
  const existing = readJson<Partial<CoreIdentity>>(filePath);
  if (
    typeof existing?.coreId === "string" &&
    existing.coreId.length > 0 &&
    typeof existing.desktopName === "string" &&
    existing.desktopName.length > 0
  ) {
    return {
      coreId: existing.coreId,
      desktopName: existing.desktopName,
      app: FORGE_AGENT_APP_NAME,
      version: FORGE_AGENT_VERSION,
      protocolVersion: 1,
    };
  }
  const identity: CoreIdentity = {
    coreId: `forge-core-${randomUUID()}`,
    desktopName: hostname() || "ForgeAgent Desktop",
    app: FORGE_AGENT_APP_NAME,
    version: FORGE_AGENT_VERSION,
    protocolVersion: 1,
  };
  atomicWrite(filePath, JSON.stringify(identity, null, 2));
  return identity;
}

function readBodyBuffer(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    req.on("data", (chunk: Buffer) => {
      if (done) return;
      size += chunk.length;
      if (size > maxBytes) {
        done = true;
        req.pause();
        reject(new BodyTooLargeError(`Request body exceeds ${maxBytes} bytes.`));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!done) resolvePromise(Buffer.concat(chunks));
    });
    req.on("error", (err) => {
      if (!done) reject(err);
    });
  });
}

async function parseJson(
  req: IncomingMessage,
  maxBodyBytes: number,
): Promise<Record<string, unknown>> {
  const raw = await readBody(req, maxBodyBytes);
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new JsonParseError("Invalid JSON");
  }
}

function parseHeaderParams(value: string): Record<string, string> {
  const params: Record<string, string> = {};
  for (const part of value.split(";").slice(1)) {
    const [rawKey, ...rawRest] = part.trim().split("=");
    if (!rawKey || rawRest.length === 0) continue;
    const rawValue = rawRest.join("=").trim();
    params[rawKey.toLowerCase()] = rawValue.replace(/^"|"$/g, "");
  }
  return params;
}

async function parseMultipartFiles(
  req: IncomingMessage,
  maxBodyBytes: number,
): Promise<UploadedMultipartFile[]> {
  const contentTypeHeader = req.headers["content-type"];
  const contentType = Array.isArray(contentTypeHeader) ? contentTypeHeader[0] : contentTypeHeader;
  const boundary = /boundary=([^;]+)/i.exec(contentType ?? "")?.[1]?.replace(/^"|"$/g, "");
  if (!boundary) throw new JsonParseError("Expected multipart/form-data with a boundary.");

  const body = await readBodyBuffer(req, maxBodyBytes);
  const boundaryBuffer = Buffer.from(`--${boundary}`);
  const files: UploadedMultipartFile[] = [];
  let position = body.indexOf(boundaryBuffer);
  while (position >= 0) {
    let partStart = position + boundaryBuffer.length;
    if (body.subarray(partStart, partStart + 2).toString("latin1") === "--") break;
    if (body.subarray(partStart, partStart + 2).toString("latin1") === "\r\n") partStart += 2;

    const nextBoundary = body.indexOf(boundaryBuffer, partStart);
    if (nextBoundary < 0) break;
    let partEnd = nextBoundary;
    if (body.subarray(partEnd - 2, partEnd).toString("latin1") === "\r\n") partEnd -= 2;
    const part = body.subarray(partStart, partEnd);
    const headerEnd = part.indexOf(Buffer.from("\r\n\r\n"));
    if (headerEnd >= 0) {
      const rawHeaders = part.subarray(0, headerEnd).toString("utf-8");
      const data = part.subarray(headerEnd + 4);
      const headers = new Map<string, string>();
      for (const line of rawHeaders.split("\r\n")) {
        const idx = line.indexOf(":");
        if (idx <= 0) continue;
        headers.set(line.slice(0, idx).trim().toLowerCase(), line.slice(idx + 1).trim());
      }
      const disposition = headers.get("content-disposition") ?? "";
      const params = parseHeaderParams(disposition);
      if (params.filename) {
        files.push({
          fieldName: params.name ?? "files",
          filename: params.filename,
          contentType: headers.get("content-type") ?? "application/octet-stream",
          data,
        });
      }
    }
    position = nextBoundary;
  }
  return files;
}

function matchRoute(method: string, reqUrl: string): RouteMatch | null {
  const path = reqUrl.split("?")[0]!;
  const segments = path.split("/").filter(Boolean);
  const s = (i: number): string | undefined => segments[i];

  if (method === "GET" && segments.length === 1 && s(0) === "health") {
    return { handler: "health", params: {} };
  }
  if (method === "GET" && segments.length === 1 && s(0) === "identity") {
    return { handler: "identity", params: {} };
  }
  if (method === "GET" && segments.length === 1 && s(0) === "discovery") {
    return { handler: "discovery", params: {} };
  }

  if (segments.length >= 1 && s(0) === "auth") {
    if (method === "GET" && segments.length === 2 && s(1) === "status") {
      return { handler: "authStatus", params: {} };
    }
    if (method === "POST" && segments.length === 2 && s(1) === "pair") {
      return { handler: "pairDevice", params: {} };
    }
    if (method === "POST" && segments.length === 2 && s(1) === "pairing-codes") {
      return { handler: "createPairingCode", params: {} };
    }
    if (method === "GET" && segments.length === 2 && s(1) === "devices") {
      return { handler: "listDevices", params: {} };
    }
    if (method === "DELETE" && segments.length === 3 && s(1) === "devices") {
      return { handler: "revokeDevice", params: { deviceId: s(2)! } };
    }
    if (method === "POST" && segments.length === 2 && s(1) === "stream-token") {
      return { handler: "createStreamToken", params: {} };
    }
  }

  if (segments.length >= 1 && s(0) === "setup") {
    if (method === "GET" && segments.length === 2 && s(1) === "status") {
      return { handler: "setupStatus", params: {} };
    }
    if (method === "POST" && segments.length === 2 && s(1) === "provider") {
      return { handler: "saveProviderConfig", params: {} };
    }
    if (method === "POST" && segments.length === 3 && s(1) === "provider" && s(2) === "test") {
      return { handler: "testProviderConfig", params: {} };
    }
  }

  if (segments.length >= 1 && s(0) === "webridge") {
    if (method === "GET" && segments.length === 2 && s(1) === "status") {
      return { handler: "webridgeStatus", params: {} };
    }
    if (method === "POST" && segments.length === 2 && s(1) === "register") {
      return { handler: "webridgeRegister", params: {} };
    }
    if (method === "POST" && segments.length === 2 && s(1) === "heartbeat") {
      return { handler: "webridgeHeartbeat", params: {} };
    }
    if (method === "GET" && segments.length === 2 && s(1) === "commands") {
      return { handler: "webridgePollCommand", params: {} };
    }
    if (method === "POST" && segments.length === 2 && s(1) === "results") {
      return { handler: "webridgeSubmitResult", params: {} };
    }
  }

  if (method === "GET" && segments.length === 1 && s(0) === "device-state") {
    return { handler: "getDeviceState", params: {} };
  }
  if (method === "PATCH" && segments.length === 1 && s(0) === "device-state") {
    return { handler: "patchDeviceState", params: {} };
  }
  if (method === "GET" && segments.length === 1 && s(0) === "projects") {
    return { handler: "listProjects", params: {} };
  }
  if (method === "POST" && segments.length === 1 && s(0) === "projects") {
    return { handler: "createProject", params: {} };
  }
  if (segments.length >= 2 && s(0) === "projects") {
    const projectId = s(1)!;
    if (method === "PATCH" && segments.length === 2) {
      return { handler: "updateProject", params: { projectId } };
    }
    if (method === "DELETE" && segments.length === 2) {
      return { handler: "archiveProject", params: { projectId } };
    }
    if (method === "GET" && segments.length === 3 && s(2) === "sessions") {
      return { handler: "listProjectSessions", params: { projectId } };
    }
  }
  if (method === "GET" && segments.length === 1 && s(0) === "system-events") {
    return { handler: "getSystemEvents", params: {} };
  }
  if (method === "GET" && segments.length === 1 && s(0) === "permission-requests") {
    return { handler: "listPermissionRequests", params: {} };
  }
  if (method === "GET" && segments.length === 1 && s(0) === "network-urls") {
    return { handler: "networkUrls", params: {} };
  }
  if (segments.length >= 1 && s(0) === "extensions") {
    if (method === "GET" && segments.length === 1) {
      return { handler: "getExtensions", params: {} };
    }
    if (method === "GET" && segments.length === 2 && s(1) === "search") {
      return { handler: "searchExtensions", params: {} };
    }
    if (method === "GET" && segments.length === 2 && s(1) === "sources") {
      return { handler: "listExtensionSources", params: {} };
    }
    if (method === "POST" && segments.length === 2 && s(1) === "sources") {
      return { handler: "addExtensionSource", params: {} };
    }
    if (method === "DELETE" && segments.length === 3 && s(1) === "sources") {
      return { handler: "removeExtensionSource", params: { sourceId: s(2)! } };
    }
    if (method === "POST" && segments.length === 4 && s(1) === "sources" && s(3) === "refresh") {
      return { handler: "refreshExtensionSource", params: { sourceId: s(2)! } };
    }
    if (method === "GET" && segments.length === 2 && s(1) === "events") {
      return { handler: "listExtensionEvents", params: {} };
    }
    if (method === "POST" && segments.length === 2 && s(1) === "install") {
      return { handler: "installExtension", params: {} };
    }
    if (method === "POST" && segments.length === 2 && s(1) === "enable") {
      return { handler: "enableExtension", params: {} };
    }
  }
  if (method === "POST" && segments.length === 3 && s(0) === "permission-requests" && s(2) === "respond") {
    return { handler: "respondPermissionRequest", params: { requestId: s(1)! } };
  }
  if (segments.length >= 1 && s(0) === "mcp") {
    if (method === "GET" && segments.length === 2 && s(1) === "servers") {
      return { handler: "listMcpServers", params: {} };
    }
    if (method === "POST" && segments.length === 2 && s(1) === "servers") {
      return { handler: "addMcpServer", params: {} };
    }
    if (method === "GET" && segments.length === 2 && s(1) === "tools") {
      return { handler: "listMcpTools", params: {} };
    }
    if (method === "GET" && segments.length === 2 && s(1) === "events") {
      return { handler: "getMcpEvents", params: {} };
    }
    if (method === "GET" && segments.length === 2 && s(1) === "catalog") {
      return { handler: "listMcpCatalog", params: {} };
    }
    if (method === "POST" && segments.length === 2 && s(1) === "catalog") {
      return { handler: "addMcpCatalogEntry", params: {} };
    }
    if (method === "POST" && segments.length === 3 && s(1) === "catalog-install") {
      return { handler: "installMcpCatalogEntry", params: { id: s(2)! } };
    }
    if (method === "GET" && segments.length === 3 && s(1) === "oauth" && s(2) === "callback") {
      return { handler: "finishMcpOAuthCallback", params: {} };
    }
    if (method === "GET" && segments.length === 2 && s(1) === "elicitations") {
      return { handler: "listMcpElicitations", params: {} };
    }
    if (method === "POST" && segments.length === 4 && s(1) === "elicitation" && s(3) === "respond") {
      return { handler: "respondMcpElicitation", params: { id: s(2)! } };
    }
    if (segments.length >= 3 && s(1) === "servers") {
      const serverId = s(2)!;
      if (method === "PATCH" && segments.length === 3) {
        return { handler: "updateMcpServer", params: { serverId } };
      }
      if (method === "DELETE" && segments.length === 3) {
        return { handler: "removeMcpServer", params: { serverId } };
      }
      if (method === "POST" && segments.length === 4 && s(3) === "enable") {
        return { handler: "enableMcpServer", params: { serverId } };
      }
      if (method === "POST" && segments.length === 4 && s(3) === "disable") {
        return { handler: "disableMcpServer", params: { serverId } };
      }
      if (method === "POST" && segments.length === 4 && s(3) === "retry") {
        return { handler: "retryMcpServer", params: { serverId } };
      }
      if (method === "POST" && segments.length === 4 && s(3) === "auth") {
        return { handler: "startMcpOAuth", params: { serverId } };
      }
    }
  }
  if (method === "GET" && segments.length === 1 && s(0) === "skills") {
    return { handler: "listSkills", params: {} };
  }
  if (method === "GET" && segments.length === 2 && s(0) === "skills") {
    return { handler: "getSkill", params: { name: s(1)! } };
  }
  if (method === "POST" && segments.length === 2 && s(0) === "skills" && s(1) === "install") {
    return { handler: "installSkill", params: {} };
  }
  if (method === "POST" && segments.length === 3 && s(0) === "skills" && s(2) === "enable") {
    return { handler: "enableSkill", params: { name: s(1)! } };
  }
  if (method === "POST" && segments.length === 3 && s(0) === "skills" && s(2) === "disable") {
    return { handler: "disableSkill", params: { name: s(1)! } };
  }
  if (method === "POST" && segments.length === 3 && s(0) === "skills" && s(2) === "rollback") {
    return { handler: "rollbackSkill", params: { name: s(1)! } };
  }
  if (method === "GET" && segments.length === 1 && s(0) === "skill-sources") {
    return { handler: "listSkillSources", params: {} };
  }
  if (method === "POST" && segments.length === 1 && s(0) === "skill-sources") {
    return { handler: "addSkillSource", params: {} };
  }
  if (method === "DELETE" && segments.length === 2 && s(0) === "skill-sources") {
    return { handler: "removeSkillSource", params: { sourceId: s(1)! } };
  }
  if (method === "GET" && segments.length === 1 && s(0) === "skill-events") {
    return { handler: "getSkillEvents", params: {} };
  }
  if (method === "GET" && segments.length === 1 && s(0) === "diagnostics") {
    return { handler: "diagnostics", params: {} };
  }
  if (method === "GET" && segments.length === 2 && s(0) === "artifacts") {
    return { handler: "getArtifact", params: { artifactId: s(1)! } };
  }
  if (method === "GET" && segments.length === 2 && s(0) === "files" && s(1) === "preview") {
    return { handler: "previewFile", params: {} };
  }

  if (method === "POST" && segments.length === 1 && s(0) === "sessions") {
    return { handler: "createSession", params: {} };
  }
  if (method === "GET" && segments.length === 1 && s(0) === "sessions") {
    return { handler: "listSessions", params: {} };
  }
  if (method === "GET" && segments.length === 1 && s(0) === "events") {
    return { handler: "handleSse", params: {} };
  }

  if (segments.length >= 2 && s(0) === "sessions") {
    const id = s(1)!;
    if (method === "GET" && segments.length === 2) {
      return { handler: "getSession", params: { id } };
    }
    if (method === "DELETE" && segments.length === 2) {
      return { handler: "deleteSession", params: { id } };
    }
    if (method === "PATCH" && segments.length === 2) {
      return { handler: "updateSession", params: { id } };
    }
    if (method === "GET" && segments.length === 3 && s(2) === "thread") {
      return { handler: "getThread", params: { id } };
    }
    if (method === "GET" && segments.length === 3 && s(2) === "branches") {
      return { handler: "getBranches", params: { id } };
    }
    if (method === "GET" && segments.length === 3 && s(2) === "usage") {
      return { handler: "getSessionUsage", params: { id } };
    }
    if (method === "GET" && segments.length === 3 && s(2) === "usage-records") {
      return { handler: "getUsageRecords", params: { id } };
    }
    if (method === "GET" && segments.length === 3 && s(2) === "artifacts") {
      return { handler: "listSessionArtifacts", params: { id } };
    }
    if (method === "POST" && segments.length === 3 && s(2) === "messages") {
      return { handler: "appendMessage", params: { id } };
    }
    if (method === "POST" && segments.length === 5 && s(2) === "messages" && s(4) === "variants") {
      return { handler: "createMessageVariant", params: { id, seq: s(3)! } };
    }
    if (method === "POST" && segments.length === 3 && s(2) === "uploads") {
      return { handler: "uploadSessionFiles", params: { id } };
    }
    if (method === "POST" && segments.length === 3 && s(2) === "run") {
      return { handler: "runTurn", params: { id } };
    }
    if (method === "POST" && segments.length === 3 && s(2) === "interrupt") {
      return { handler: "interruptSession", params: { id } };
    }
    if (method === "POST" && segments.length === 3 && s(2) === "retry") {
      return { handler: "retrySession", params: { id } };
    }
    if (method === "GET" && segments.length === 3 && s(2) === "triggers") {
      return { handler: "listTriggers", params: { id } };
    }
    if (method === "POST" && segments.length === 3 && s(2) === "triggers") {
      return { handler: "createTrigger", params: { id } };
    }
    if (method === "DELETE" && segments.length === 4 && s(2) === "triggers") {
      return { handler: "deleteTrigger", params: { id, triggerId: s(3)! } };
    }
  }

  return null;
}

function bearerToken(req: IncomingMessage): string | null {
  const raw = req.headers.authorization;
  if (!raw) return null;
  const match = /^Bearer\s+(.+)$/i.exec(raw.trim());
  return match?.[1] ?? null;
}

function isLoopback(req: IncomingMessage): boolean {
  const addr = req.socket.remoteAddress ?? "";
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

function disabledContext(): AuthenticatedRequestContext {
  return {
    authMethod: "disabled",
    device: {
      id: "auth-disabled",
      name: "Auth disabled",
      kind: "unknown",
      scopes: ["gateway:all"],
      createdAt: new Date(0).toISOString(),
    },
  };
}

function authenticateBearer(
  req: IncomingMessage,
  options: ResolvedHttpServerOptions,
): AuthenticatedRequestContext {
  if (options.authMode === "disabled") return disabledContext();
  const token = bearerToken(req);
  if (!token) throw new UnauthorizedError();
  const device = options.authStore.authenticateBearer(token);
  if (!device) throw new UnauthorizedError();
  return { authMethod: "bearer", device };
}

function authenticateSse(
  req: IncomingMessage,
  options: ResolvedHttpServerOptions,
): AuthenticatedRequestContext {
  if (options.authMode === "disabled") return disabledContext();
  const url = routeUrl(req);
  const streamToken = url.searchParams.get("stream_token");
  if (streamToken) {
    const device = options.authStore.consumeStreamToken(streamToken);
    if (!device) throw new UnauthorizedError();
    return { authMethod: "stream_token", device };
  }
  return authenticateBearer(req, options);
}

function parseSeq(value: string | null): number {
  if (!value) return 0;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function maxEventSeq(events: SessionEvent[]): number {
  return events.reduce((max, event) => Math.max(max, event.seq), 0);
}

function isAgentResultEvent(session: Session, event: SessionEvent): boolean {
  if (event.type === "assistant_message" || event.type === "permission_request") {
    return true;
  }
  return session.status === "blocked" && event.type === "runtime_event";
}

function latestAgentResultSeq(session: Session, events: SessionEvent[]): number {
  return events.reduce((max, event) => (
    isAgentResultEvent(session, event) ? Math.max(max, event.seq) : max
  ), 0);
}

function sessionViewForDevice(
  api: CoreAPI,
  session: Session,
  state: DeviceState | null,
): HttpSessionView {
  const branchId = state?.selectedBranchBySession?.[session.id] ?? session.activeBranchId;
  let events: SessionEvent[];
  try {
    events = api.getVisibleThread(session.id, branchId);
  } catch {
    events = api.getVisibleThread(session.id);
  }
  const latestSeq = maxEventSeq(events);
  const latestAgentSeq = latestAgentResultSeq(session, events);
  const readSeq = state?.sessionReadSeq[session.id] ?? 0;
  const muted = session.muted || state?.mutedSessionIds.includes(session.id) === true;
  return {
    ...session,
    latestSeq,
    latestAgentResultSeq: latestAgentSeq,
    unread: !muted && session.status !== "running" && latestAgentSeq > readSeq,
  };
}

function sessionViewsForDevice(
  api: CoreAPI,
  context: AuthenticatedRequestContext | null,
  options: ResolvedHttpServerOptions,
  projectId?: string,
): HttpSessionView[] {
  const state = context ? options.authStore.getDeviceState(context.device.id) : null;
  const sessions = projectId ? api.getProjectSessions(projectId) : api.listSessions();
  return sessions.map((session) => sessionViewForDevice(api, session, state));
}

function normalizeKind(value: unknown): DeviceKind {
  return value === "android" || value === "desktop" || value === "web" || value === "cli"
    ? value
    : "unknown";
}

function requestBaseUrl(req: IncomingMessage): string {
  const proto = typeof req.headers["x-forwarded-proto"] === "string"
    ? req.headers["x-forwarded-proto"].split(",")[0]!.trim()
    : "http";
  const host = req.headers.host ?? "127.0.0.1:3000";
  return `${proto}://${host}`;
}

function pairingUrl(baseUrl: string, code: string): string {
  return `forgeagent://pair?baseUrl=${encodeURIComponent(baseUrl)}&code=${encodeURIComponent(code)}`;
}

function sourceFromContext(context: AuthenticatedRequestContext): ToolRequestSource {
  return {
    kind: "http",
    interactive: true,
    deviceId: context.device.id,
    deviceKind: context.device.kind,
    deviceName: context.device.name,
  };
}

function providerConfigInputFromBody(body: Record<string, unknown>): ProviderConfigInput {
  const input: ProviderConfigInput = {};
  if (typeof body.apiKey === "string") input.apiKey = body.apiKey;
  if (typeof body.baseUrl === "string") input.baseUrl = body.baseUrl;
  if (typeof body.model === "string") input.model = body.model;
  if (typeof body.contextWindowTokens === "number") input.contextWindowTokens = body.contextWindowTokens;
  return input;
}

async function defaultProviderConfigTest(
  store: ProviderConfigStore,
  input: ProviderConfigInput,
): Promise<{ ok: boolean; message: string }> {
  const current = store.getEffectiveConfig();
  const config = {
    ...current,
    ...(typeof input.apiKey === "string" && input.apiKey.trim() ? { apiKey: input.apiKey.trim() } : {}),
    ...(typeof input.baseUrl === "string" && input.baseUrl.trim() ? { baseUrl: input.baseUrl.trim() } : {}),
    ...(typeof input.model === "string" && input.model.trim() ? { model: input.model.trim() } : {}),
    ...(typeof input.contextWindowTokens === "number" && input.contextWindowTokens > 0
      ? { contextWindowTokens: Math.floor(input.contextWindowTokens) }
      : {}),
  };
  if (!config.apiKey) throw new Error("DeepSeek API key is missing.");
  const provider = new DeepSeekProvider(deepSeekOptionsFromConfig(config));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await provider.generate([
      { role: "system", content: "You are testing a local ForgeAgent model provider configuration. Reply briefly." },
      { role: "user", content: "Reply with OK." },
    ], undefined, { signal: controller.signal });
    const text = response.text.trim();
    return { ok: true, message: text ? `Provider test succeeded: ${text.slice(0, 120)}` : "Provider test succeeded." };
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(sanitizeSecret(raw, config.apiKey));
  } finally {
    clearTimeout(timer);
  }
}

function sanitizeSecret(message: string, secret: string): string {
  return secret ? message.split(secret).join("[REDACTED]") : message;
}

function optionalStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((item): item is string => typeof item === "string" && item.length > 0);
  return items.length > 0 ? items : undefined;
}

function optionalRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const result: Record<string, string> = {};
  for (const [key, val] of Object.entries(value)) {
    if (typeof val === "string") result[key] = val;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function optionalTransport(value: unknown): McpTransportKind | undefined {
  if (value === "stdio" || value === "streamable-http" || value === "sse") return value;
  return undefined;
}

function optionalLaunchMode(value: unknown): McpLaunchMode | undefined {
  if (value === "eager" || value === "background" || value === "lazy") return value;
  return undefined;
}

function optionalTrust(value: unknown): McpTrust | undefined {
  if (value === "trusted" || value === "untrusted" || value === "quarantined") return value;
  return undefined;
}

function optionalMcpSource(value: unknown): McpServerConfig["source"] | undefined {
  if (value === "local" || value === "project" || value === "imported" || value === "catalog") return value;
  return undefined;
}

function buildMcpServerInput(body: Record<string, unknown>): Omit<McpServerConfig, "id"> {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) throw new Error("Missing MCP server name.");
  const transport = optionalTransport(body.transport) ?? "stdio";
  const input: Omit<McpServerConfig, "id"> = {
    name,
    transport,
    enabled: typeof body.enabled === "boolean" ? body.enabled : false,
    launchMode: optionalLaunchMode(body.launchMode) ?? "lazy",
    trust: optionalTrust(body.trust) ?? "untrusted",
  };
  const args = optionalStringArray(body.args);
  const env = optionalRecord(body.env);
  const headers = optionalRecord(body.headers);
  const roots = optionalStringArray(body.roots);
  if (typeof body.command === "string") input.command = body.command;
  if (args) input.args = args;
  if (typeof body.cwd === "string") input.cwd = body.cwd;
  if (env) input.env = env;
  if (typeof body.url === "string") input.url = body.url;
  if (headers) input.headers = headers;
  if (typeof body.timeoutMs === "number") input.timeoutMs = Math.max(1, body.timeoutMs);
  if (typeof body.connectTimeoutMs === "number") input.connectTimeoutMs = Math.max(1, body.connectTimeoutMs);
  if (typeof body.supportsParallelToolCalls === "boolean") input.supportsParallelToolCalls = body.supportsParallelToolCalls;
  if (typeof body.allowSampling === "boolean") input.allowSampling = body.allowSampling;
  if (typeof body.allowElicitation === "boolean") input.allowElicitation = body.allowElicitation;
  if (roots) input.roots = roots;
  const source = optionalMcpSource(body.source);
  if (source) input.source = source;
  return input;
}

function buildMcpServerPatch(body: Record<string, unknown>): Partial<McpServerConfig> {
  const patch: Partial<McpServerConfig> = {};
  if (typeof body.name === "string") patch.name = body.name;
  const transport = optionalTransport(body.transport);
  const launchMode = optionalLaunchMode(body.launchMode);
  const trust = optionalTrust(body.trust);
  const args = optionalStringArray(body.args);
  const env = optionalRecord(body.env);
  const headers = optionalRecord(body.headers);
  const roots = optionalStringArray(body.roots);
  if (transport) patch.transport = transport;
  if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
  if (typeof body.command === "string") patch.command = body.command;
  if (args) patch.args = args;
  if (typeof body.cwd === "string") patch.cwd = body.cwd;
  if (env) patch.env = env;
  if (typeof body.url === "string") patch.url = body.url;
  if (headers) patch.headers = headers;
  if (launchMode) patch.launchMode = launchMode;
  if (trust) patch.trust = trust;
  if (typeof body.timeoutMs === "number") patch.timeoutMs = Math.max(1, body.timeoutMs);
  if (typeof body.connectTimeoutMs === "number") patch.connectTimeoutMs = Math.max(1, body.connectTimeoutMs);
  if (typeof body.supportsParallelToolCalls === "boolean") patch.supportsParallelToolCalls = body.supportsParallelToolCalls;
  if (typeof body.allowSampling === "boolean") patch.allowSampling = body.allowSampling;
  if (typeof body.allowElicitation === "boolean") patch.allowElicitation = body.allowElicitation;
  if (roots) patch.roots = roots;
  const source = optionalMcpSource(body.source);
  if (source) patch.source = source;
  return patch;
}

function buildMcpCatalogEntry(body: Record<string, unknown>): McpCatalogEntry {
  const id = typeof body.id === "string" ? body.id.trim() : "";
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!id) throw new Error("Missing MCP catalog id.");
  if (!name) throw new Error("Missing MCP catalog name.");
  const transport = optionalTransport(body.transport) ?? "stdio";
  const entry: McpCatalogEntry = {
    id,
    name,
    transport,
  };
  if (typeof body.description === "string") entry.description = body.description;
  if (typeof body.url === "string") entry.url = body.url;
  if (typeof body.command === "string") entry.command = body.command;
  const args = optionalStringArray(body.args);
  const env = optionalRecord(body.env);
  const headers = optionalRecord(body.headers);
  if (args) entry.args = args;
  if (env) entry.env = env;
  if (headers) entry.headers = headers;
  if (typeof body.sha256 === "string") entry.sha256 = body.sha256;
  const trust = optionalTrust(body.trust);
  if (trust) entry.trust = trust;
  if (typeof body.sourceUrl === "string") entry.sourceUrl = body.sourceUrl;
  if (typeof body.packageName === "string") entry.packageName = body.packageName;
  if (typeof body.packageVersion === "string") entry.packageVersion = body.packageVersion;
  if (Array.isArray(body.defaultEnabledTools)) entry.defaultEnabledTools = body.defaultEnabledTools.map(String);
  if (typeof body.postInstall === "string") entry.postInstall = body.postInstall;
  if (typeof body.setupRequired === "boolean") entry.setupRequired = body.setupRequired;
  if (Array.isArray(body.tags)) entry.tags = body.tags.map(String);
  return entry;
}

function buildExtensionInstallInput(body: Record<string, unknown>): ExtensionInstallInput {
  const raw = body.installInput && typeof body.installInput === "object" && !Array.isArray(body.installInput)
    ? body.installInput as Record<string, unknown>
    : body.install_input && typeof body.install_input === "object" && !Array.isArray(body.install_input)
      ? body.install_input as Record<string, unknown>
      : body;
  const kind = raw.kind;
  if (kind === "skill") {
    const name = typeof raw.name === "string" ? raw.name.trim() : "";
    if (!name) throw new Error("Missing skill name.");
    return {
      kind: "skill",
      name,
      ...(typeof raw.version === "string" ? { version: raw.version } : {}),
      ...(typeof raw.sourceId === "string" ? { sourceId: raw.sourceId } : {}),
      ...(typeof raw.registryUrl === "string" ? { registryUrl: raw.registryUrl } : {}),
      ...(typeof raw.trustUnsigned === "boolean" ? { trustUnsigned: raw.trustUnsigned } : {}),
      ...(typeof raw.force === "boolean" ? { force: raw.force } : {}),
    };
  }
  if (kind === "skill_github") {
    const url = typeof raw.url === "string" ? raw.url.trim() : "";
    if (!url) throw new Error("Missing skill GitHub URL.");
    return {
      kind: "skill_github",
      url,
      ...(typeof raw.name === "string" ? { name: raw.name } : {}),
      ...(typeof raw.version === "string" ? { version: raw.version } : {}),
      ...(typeof raw.force === "boolean" ? { force: raw.force } : {}),
    };
  }
  if (kind === "mcp_catalog") {
    const catalogId = typeof raw.catalogId === "string"
      ? raw.catalogId.trim()
      : typeof raw.catalog_id === "string"
        ? raw.catalog_id.trim()
        : "";
    if (!catalogId) throw new Error("Missing MCP catalog id.");
    return {
      kind: "mcp_catalog",
      catalogId,
      ...(typeof raw.enable === "boolean" ? { enable: raw.enable } : {}),
    };
  }
  if (kind === "mcp_server") {
    const serverRaw = raw.server && typeof raw.server === "object" && !Array.isArray(raw.server)
      ? raw.server as Record<string, unknown>
      : raw;
    return {
      kind: "mcp_server",
      server: buildMcpServerInput(serverRaw),
      ...(typeof raw.enable === "boolean"
        ? { enable: raw.enable }
        : typeof serverRaw.enable === "boolean"
          ? { enable: serverRaw.enable }
          : {}),
    };
  }
  if (kind === "bundle") {
    const name = typeof raw.name === "string" ? raw.name.trim() : "";
    if (!name) throw new Error("Missing bundle name.");
    const items = Array.isArray(raw.items)
      ? raw.items.map((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Invalid bundle item.");
        const parsed = buildExtensionInstallInput(item as Record<string, unknown>);
        if (parsed.kind === "bundle") throw new Error("Nested bundles are not supported.");
        return parsed;
      })
      : [];
    if (items.length === 0) throw new Error("Missing bundle items.");
    return {
      kind: "bundle",
      name,
      items,
      ...(typeof raw.enable === "boolean" ? { enable: raw.enable } : {}),
    };
  }
  throw new Error("Invalid extension install kind.");
}

function buildMcpElicitationResponse(body: Record<string, unknown>): { action: "accept" | "decline"; content?: Record<string, string | number | boolean | string[]> } {
  const response: { action: "accept" | "decline"; content?: Record<string, string | number | boolean | string[]> } = {
    action: body.accept === false ? "decline" : "accept",
  };
  if (body.content && typeof body.content === "object" && !Array.isArray(body.content)) {
    const content: Record<string, string | number | boolean | string[]> = {};
    for (const [key, value] of Object.entries(body.content)) {
      if (
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean" ||
        (Array.isArray(value) && value.every((item) => typeof item === "string"))
      ) {
        content[key] = value;
      }
    }
    if (Object.keys(content).length > 0) response.content = content;
  }
  return response;
}

function buildDiagnosticsPayload(
  api: CoreAPI,
  options: ResolvedHttpServerOptions,
): Record<string, unknown> {
  const sessions = api.listSessions();
  const sessionStatuses = sessions.reduce<Record<string, number>>((acc, session) => {
    acc[session.status] = (acc[session.status] ?? 0) + 1;
    return acc;
  }, {});
  const runtime = api.getWebridgeRuntime();
  const providerMetadata = api.getModelProviderMetadata();
  return {
    app: FORGE_AGENT_APP_NAME,
    version: FORGE_AGENT_VERSION,
    time: new Date().toISOString(),
    setup: options.providerConfigStore.getStatus(),
    provider: providerMetadata
      ? {
          provider: providerMetadata.provider,
          model: providerMetadata.model,
          contextWindowTokens: providerMetadata.contextWindowTokens,
          requiresUsage: providerMetadata.requiresUsage === true,
        }
      : null,
    sessions: {
      total: sessions.length,
      statuses: sessionStatuses,
    },
    permissions: {
      pending: api.getPermissionRequests({ status: "pending" }).length,
    },
    mcp: api.getMcpStatus(),
    webridge: runtime
      ? { enabled: true, ...runtime.getHealth() }
      : { enabled: false, state: "offline", message: "ForgeWebridge runtime is not enabled." },
    memory: api.getMemoryStatus(),
    skills: {
      status: api.getSkillStatus(),
      evolution: api.getSkillEvolutionStatus(),
    },
    systemEvents: api.getSystemEvents().length,
  };
}

function artifactPayload(
  info: { artifactId: string; sessionId: string; mimeType: string; sizeBytes: number; createdAt: string },
  bytes: Buffer,
  url: URL,
): Record<string, unknown> {
  const offset = Math.min(parseSeq(url.searchParams.get("offset")), bytes.length);
  const requestedLimit = parseSeq(url.searchParams.get("limit"));
  const limit = Math.min(requestedLimit || 50_000, 200_000);
  const end = Math.min(offset + limit, bytes.length);
  const slice = bytes.subarray(offset, end);
  const text = isTextMime(info.mimeType);
  return {
    info,
    offset,
    limit,
    nextOffset: end < bytes.length ? end : null,
    truncated: end < bytes.length,
    encoding: text ? "utf8" : "base64",
    content: slice.toString(text ? "utf-8" : "base64"),
  };
}

function isTextMime(mimeType: string): boolean {
  return mimeType.startsWith("text/")
    || mimeType.includes("json")
    || mimeType.includes("xml")
    || mimeType.includes("javascript")
    || mimeType.includes("markdown");
}

function isPublicHandler(handler: string): boolean {
  return handler === "authStatus"
    || handler === "pairDevice"
    || handler === "health"
    || handler === "identity"
    || handler === "discovery"
    || handler === "finishMcpOAuthCallback";
}

export function createHttpServer(
  api: CoreAPI,
  gateway: HttpGateway,
  options?: HttpServerOptions,
): Server {
  const resolved = resolveOptions(options);

  const server = createServer(async (req, res) => {
    const origin = allowedCorsOrigin(req, resolved);
    if (origin === false) {
      sendError(res, 403, "Origin is not allowed.", null);
      return;
    }

    if (req.method === "OPTIONS") {
      res.writeHead(204, corsHeaders(origin));
      res.end();
      return;
    }

    const route = matchRoute(req.method ?? "GET", req.url ?? "/");
    if (!route) {
      if (isApiLikeRequest(req)) {
        sendError(res, 404, "Unknown ForgeAgent API route.", origin);
        return;
      }
      if ((req.method === "GET" || req.method === "HEAD") && resolved.enableUi) {
        if (serveStaticUi(req, res, resolved, origin)) return;
      }
      sendError(res, 404, "Not found", origin);
      return;
    }

    try {
      await handleRoute(api, gateway, route, req, res, resolved, origin);
    } catch (err) {
      if (err instanceof JsonParseError) {
        sendError(res, 400, err.message, origin);
      } else if (err instanceof BodyTooLargeError) {
        sendError(res, 413, err.message, origin);
      } else if (err instanceof UnauthorizedError) {
        sendError(res, 401, err.message, origin);
      } else if (err instanceof ForbiddenError) {
        sendError(res, 403, err.message, origin);
      } else if (err instanceof AuthError) {
        sendError(res, 401, err.message, origin);
      } else {
        sendError(res, 500, err instanceof Error ? err.message : "Internal server error", origin);
      }
    }
  });

  return server;
}

async function handleRoute(
  api: CoreAPI,
  gateway: HttpGateway,
  route: RouteMatch,
  req: IncomingMessage,
  res: ServerResponse,
  options: ResolvedHttpServerOptions,
  origin: string | null,
): Promise<void> {
  const { handler, params } = route;
  const context =
    isPublicHandler(handler)
      ? null
      : handler === "handleSse"
        ? authenticateSse(req, options)
        : handler === "createPairingCode"
          ? authenticatePairingCodeRequest(req, options)
          : authenticateBearer(req, options);

  switch (handler) {
    case "health": {
      sendJson(res, 200, buildHealthPayload(api, req, options), origin);
      return;
    }

    case "identity": {
      sendJson(res, 200, buildIdentityPayload(options), origin);
      return;
    }

    case "discovery": {
      sendJson(res, 200, buildDiscoveryPayload(api, req, options), origin);
      return;
    }

    case "authStatus": {
      sendJson(res, 200, {
        authMode: options.authMode,
        ...options.authStore.status(),
      }, origin);
      return;
    }

    case "setupStatus": {
      sendJson(res, 200, options.providerConfigStore.getStatus(), origin);
      return;
    }

    case "saveProviderConfig": {
      const body = await parseJson(req, options.maxBodyBytes);
      const input = providerConfigInputFromBody(body);
      const status = options.providerConfigStore.save(input);
      options.applyProviderConfig?.(status);
      sendJson(res, 200, status, origin);
      return;
    }

    case "testProviderConfig": {
      const body = await parseJson(req, options.maxBodyBytes);
      const input = providerConfigInputFromBody(body);
      try {
        const result = options.testProviderConfig
          ? await options.testProviderConfig(input)
          : await defaultProviderConfigTest(options.providerConfigStore, input);
        sendJson(res, 200, result, origin);
      } catch (err) {
        sendError(res, 400, err instanceof Error ? err.message : String(err), origin);
      }
      return;
    }

    case "pairDevice": {
      const body = await parseJson(req, options.maxBodyBytes);
      const code = typeof body.code === "string" ? body.code : "";
      const name = typeof body.name === "string" ? body.name : "";
      if (!code) { sendError(res, 400, "Missing code", origin); return; }
      if (!name) { sendError(res, 400, "Missing name", origin); return; }
      const issued = options.authStore.pairDevice({
        code,
        name,
        kind: normalizeKind(body.kind),
      });
      sendJson(res, 201, {
        ...issued,
        ...buildConnectionMetadata(req, options),
      }, origin);
      return;
    }

    case "createPairingCode": {
      const body = await parseJson(req, options.maxBodyBytes);
      const ttlMs = typeof body.ttlMs === "number" && body.ttlMs > 0 ? body.ttlMs : undefined;
      const baseUrl = typeof body.baseUrl === "string" && body.baseUrl ? body.baseUrl : requestBaseUrl(req);
      const issued = options.authStore.issuePairingCode({
        ...(ttlMs !== undefined ? { ttlMs } : {}),
        ...(context ? { createdByDeviceId: context.device.id } : {}),
      });
      sendJson(res, 201, {
        ...issued,
        pairingUrl: pairingUrl(baseUrl, issued.code),
      }, origin);
      return;
    }

    case "listDevices": {
      sendJson(res, 200, options.authStore.listDevices(), origin);
      return;
    }

    case "revokeDevice": {
      const device = options.authStore.revokeDevice(params.deviceId!);
      if (!device) { sendError(res, 404, "Device not found", origin); return; }
      sendJson(res, 200, device, origin);
      return;
    }

    case "createStreamToken": {
      const issued = options.authStore.issueStreamToken(requireContext(context).device.id);
      sendJson(res, 201, issued, origin);
      return;
    }

    case "networkUrls": {
      sendJson(res, 200, buildNetworkUrlsPayload(req, options), origin);
      return;
    }

    case "webridgeStatus": {
      const runtime = api.getWebridgeRuntime();
      if (!runtime) { sendError(res, 404, "ForgeWebridge runtime is not enabled.", origin); return; }
      const health = runtime.getHealth();
      sendJson(res, 200, { ...health, health, clients: health.clients }, origin);
      return;
    }

    case "webridgeRegister": {
      const runtime = api.getWebridgeRuntime();
      if (!runtime) { sendError(res, 404, "ForgeWebridge runtime is not enabled.", origin); return; }
      const body = await parseJson(req, options.maxBodyBytes);
      const info = runtime.registerClient({
        ...(typeof body.clientId === "string" ? { clientId: body.clientId } : {}),
        ...(typeof body.name === "string" ? { name: body.name } : {}),
        ...(typeof body.version === "string" ? { version: body.version } : {}),
        ...(typeof req.headers["user-agent"] === "string" ? { userAgent: req.headers["user-agent"] } : {}),
      });
      sendJson(res, 201, info, origin);
      return;
    }

    case "webridgeHeartbeat": {
      const runtime = api.getWebridgeRuntime();
      if (!runtime) { sendError(res, 404, "ForgeWebridge runtime is not enabled.", origin); return; }
      const body = await parseJson(req, options.maxBodyBytes);
      const clientId = typeof body.clientId === "string" ? body.clientId : "";
      if (!clientId) { sendError(res, 400, "Missing clientId", origin); return; }
      try {
        const health = runtime.heartbeatClient({
          clientId,
          ...(typeof body.name === "string" ? { name: body.name } : {}),
          ...(typeof body.version === "string" ? { version: body.version } : {}),
          ...(typeof body.state === "string" ? { extensionState: body.state } : {}),
          ...(typeof req.headers["user-agent"] === "string" ? { userAgent: req.headers["user-agent"] } : {}),
        });
        sendJson(res, 200, { ok: true, health }, origin);
      } catch (err) {
        sendError(res, 404, err instanceof Error ? err.message : String(err), origin);
      }
      return;
    }

    case "webridgePollCommand": {
      const runtime = api.getWebridgeRuntime();
      if (!runtime) { sendError(res, 404, "ForgeWebridge runtime is not enabled.", origin); return; }
      const url = routeUrl(req);
      const clientId = url.searchParams.get("clientId") ?? "";
      if (!clientId) { sendError(res, 400, "Missing clientId", origin); return; }
      const timeoutMs = parseSeq(url.searchParams.get("timeoutMs")) || undefined;
      try {
        const command = await runtime.pollCommand(clientId, timeoutMs);
        sendJson(res, 200, { command }, origin);
      } catch (err) {
        sendError(res, 404, err instanceof Error ? err.message : String(err), origin);
      }
      return;
    }

    case "webridgeSubmitResult": {
      const runtime = api.getWebridgeRuntime();
      if (!runtime) { sendError(res, 404, "ForgeWebridge runtime is not enabled.", origin); return; }
      const body = await parseJson(req, options.maxBodyBytes);
      const clientId = typeof body.clientId === "string" ? body.clientId : "";
      const commandId = typeof body.commandId === "string" ? body.commandId : "";
      if (!clientId) { sendError(res, 400, "Missing clientId", origin); return; }
      if (!commandId) { sendError(res, 400, "Missing commandId", origin); return; }
      try {
        runtime.submitResult(clientId, {
          commandId,
          ok: body.ok === true,
          output: body.output,
          ...(typeof body.error === "string" ? { error: body.error } : {}),
        });
        sendJson(res, 200, { ok: true }, origin);
      } catch (err) {
        sendError(res, 404, err instanceof Error ? err.message : String(err), origin);
      }
      return;
    }

    case "getDeviceState": {
      const state = options.authStore.getDeviceState(requireContext(context).device.id);
      sendJson(res, 200, state, origin);
      return;
    }

    case "patchDeviceState": {
      const body = await parseJson(req, options.maxBodyBytes);
      const patch: Partial<DeviceState> = {};
      if (typeof body.selectedSessionId === "string") {
        patch.selectedSessionId = body.selectedSessionId;
      } else if (body.selectedSessionId === null) {
        patch.selectedSessionId = "";
      }
      if (typeof body.selectedProjectId === "string") {
        patch.selectedProjectId = body.selectedProjectId;
      } else if (body.selectedProjectId === null) {
        patch.selectedProjectId = "";
      }
      if (body.sessionReadSeq && typeof body.sessionReadSeq === "object") {
        patch.sessionReadSeq = body.sessionReadSeq as Record<string, number>;
      }
      if (body.selectedBranchBySession && typeof body.selectedBranchBySession === "object") {
        patch.selectedBranchBySession = body.selectedBranchBySession as Record<string, string>;
      }
      if (Array.isArray(body.mutedSessionIds)) {
        patch.mutedSessionIds = body.mutedSessionIds.filter((sid): sid is string => typeof sid === "string");
      }
      if (body.notificationSettings && typeof body.notificationSettings === "object") {
        const settings = body.notificationSettings as Record<string, unknown>;
        const notificationSettings: DeviceState["notificationSettings"] = {
          enabled: settings.enabled === true,
          lastNotifiedSeq: typeof settings.lastNotifiedSeq === "number" ? settings.lastNotifiedSeq : 0,
        };
        patch.notificationSettings = notificationSettings;
      }
      const state = options.authStore.patchDeviceState(requireContext(context).device.id, patch);
      sendJson(res, 200, state, origin);
      return;
    }

    case "listProjects": {
      sendJson(res, 200, api.listProjects(), origin);
      return;
    }

    case "createProject": {
      const body = await parseJson(req, options.maxBodyBytes);
      const input: Parameters<CoreAPI["createProject"]>[0] = {};
      if (typeof body.name === "string") input.name = body.name;
      if (typeof body.path === "string") input.path = body.path;
      if (typeof body.create === "boolean") input.create = body.create;
      if (body.trustState === "trusted" || body.trustState === "untrusted") {
        input.trustState = body.trustState;
      }
      try {
        sendJson(res, 201, api.createProject(input), origin);
      } catch (err) {
        sendError(res, 400, err instanceof Error ? err.message : String(err), origin);
      }
      return;
    }

    case "updateProject": {
      const body = await parseJson(req, options.maxBodyBytes);
      const patch: Parameters<CoreAPI["updateProject"]>[1] = {};
      if (typeof body.name === "string") patch.name = body.name;
      if (body.trustState === "trusted" || body.trustState === "untrusted") {
        patch.trustState = body.trustState;
      }
      try {
        sendJson(res, 200, api.updateProject(params.projectId!, patch), origin);
      } catch (err) {
        sendError(res, 404, err instanceof Error ? err.message : String(err), origin);
      }
      return;
    }

    case "archiveProject": {
      try {
        sendJson(res, 200, api.archiveProject(params.projectId!), origin);
      } catch (err) {
        sendError(res, 404, err instanceof Error ? err.message : String(err), origin);
      }
      return;
    }

    case "listProjectSessions": {
      if (!api.getProject(params.projectId!)) {
        sendError(res, 404, "Project not found", origin);
        return;
      }
      sendJson(res, 200, sessionViewsForDevice(api, context, options, params.projectId!), origin);
      return;
    }

    case "getSystemEvents": {
      const afterSeq = parseSeq(routeUrl(req).searchParams.get("afterSeq"));
      const events = api.getSystemEvents().filter((event) => event.seq > afterSeq);
      sendJson(res, 200, events, origin);
      return;
    }

    case "listPermissionRequests": {
      const status = routeUrl(req).searchParams.get("status");
      const filter = status === "pending" ? { status: "pending" as const } : undefined;
      sendJson(res, 200, api.getPermissionRequests(filter), origin);
      return;
    }

    case "respondPermissionRequest": {
      const body = await parseJson(req, options.maxBodyBytes);
      const decision = body.decision;
      if (decision !== "allow_once" && decision !== "allow_session" && decision !== "deny") {
        sendError(res, 400, "Invalid permission decision", origin);
        return;
      }
      const device = requireContext(context).device;
      try {
        const request = api.respondToPermissionRequest(params.requestId!, {
          decision,
          ...(typeof body.message === "string" ? { message: body.message } : {}),
          deviceId: device.id,
          deviceName: device.name,
        });
        sendJson(res, 200, request, origin);
      } catch (err) {
        sendError(res, 404, err instanceof Error ? err.message : String(err), origin);
      }
      return;
    }

    case "getExtensions": {
      sendJson(res, 200, api.getExtensions(), origin);
      return;
    }

    case "searchExtensions": {
      const url = routeUrl(req);
      const searchOptions: { query?: string; link?: string; includeInstalled?: boolean } = {
        includeInstalled: url.searchParams.get("includeInstalled") === "true",
      };
      const query = url.searchParams.get("query");
      const link = url.searchParams.get("link");
      if (query !== null) searchOptions.query = query;
      if (link !== null) searchOptions.link = link;
      sendJson(res, 200, {
        candidates: api.searchExtensions(searchOptions),
      }, origin);
      return;
    }

    case "listExtensionSources": {
      sendJson(res, 200, api.getExtensionSources(), origin);
      return;
    }

    case "addExtensionSource": {
      const body = await parseJson(req, options.maxBodyBytes);
      try {
        const kind = typeof body.kind === "string" ? body.kind : "";
        if (kind !== "file" && kind !== "http" && kind !== "github") {
          sendError(res, 400, "Extension source kind must be file, http, or github.", origin);
          return;
        }
        const name = typeof body.name === "string" ? body.name.trim() : "";
        if (!name) {
          sendError(res, 400, "Extension source name is required.", origin);
          return;
        }
        sendJson(res, 201, api.addExtensionSource({
          kind,
          name,
          ...(typeof body.url === "string" ? { url: body.url } : {}),
          ...(typeof body.path === "string" ? { path: body.path } : {}),
          ...(typeof body.trust === "string" ? { trust: body.trust as never } : {}),
          ...(typeof body.trustUnsigned === "boolean" ? { trustUnsigned: body.trustUnsigned } : {}),
          ...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}),
        }), origin);
      } catch (err) {
        sendError(res, 400, err instanceof Error ? err.message : String(err), origin);
      }
      return;
    }

    case "removeExtensionSource": {
      sendJson(res, 200, { removed: api.removeExtensionSource(params.sourceId!) }, origin);
      return;
    }

    case "refreshExtensionSource": {
      try {
        sendJson(res, 200, await api.refreshExtensionSource(params.sourceId!), origin);
      } catch (err) {
        sendError(res, 400, err instanceof Error ? err.message : String(err), origin);
      }
      return;
    }

    case "listExtensionEvents": {
      const url = routeUrl(req);
      const afterSeq = Number(url.searchParams.get("afterSeq") ?? 0);
      sendJson(res, 200, api.getExtensionEvents(Number.isFinite(afterSeq) ? afterSeq : 0), origin);
      return;
    }

    case "installExtension": {
      const body = await parseJson(req, options.maxBodyBytes);
      try {
        sendJson(res, 201, await api.installExtension(buildExtensionInstallInput(body)), origin);
      } catch (err) {
        sendError(res, 400, err instanceof Error ? err.message : String(err), origin);
      }
      return;
    }

    case "enableExtension": {
      const body = await parseJson(req, options.maxBodyBytes);
      const kind = body.kind;
      const idOrName = typeof body.idOrName === "string"
        ? body.idOrName
        : typeof body.id_or_name === "string"
          ? body.id_or_name
          : "";
      if (kind !== "skill" && kind !== "mcp_server" && kind !== "bundle") {
        sendError(res, 400, "Invalid extension kind.", origin);
        return;
      }
      if (!idOrName) {
        sendError(res, 400, "Missing idOrName.", origin);
        return;
      }
      try {
        sendJson(res, 200, await api.enableExtension(
          kind,
          idOrName,
          typeof body.version === "string" ? body.version : undefined,
          typeof body.trustWarnings === "boolean" ? { trustWarnings: body.trustWarnings } : undefined,
        ), origin);
      } catch (err) {
        sendError(res, 400, err instanceof Error ? err.message : String(err), origin);
      }
      return;
    }

    case "listMcpServers": {
      sendJson(res, 200, api.getMcpServers(), origin);
      return;
    }

    case "addMcpServer": {
      const body = await parseJson(req, options.maxBodyBytes);
      try {
        const server = api.addMcpServer(buildMcpServerInput(body));
        sendJson(res, 201, server, origin);
      } catch (err) {
        sendError(res, 400, err instanceof Error ? err.message : String(err), origin);
      }
      return;
    }

    case "updateMcpServer": {
      const body = await parseJson(req, options.maxBodyBytes);
      try {
        const server = await api.updateMcpServer(params.serverId!, buildMcpServerPatch(body));
        sendJson(res, 200, server, origin);
      } catch (err) {
        sendError(res, 400, err instanceof Error ? err.message : String(err), origin);
      }
      return;
    }

    case "removeMcpServer": {
      try {
        await api.removeMcpServer(params.serverId!);
        sendJson(res, 200, { deleted: true }, origin);
      } catch (err) {
        sendError(res, 404, err instanceof Error ? err.message : String(err), origin);
      }
      return;
    }

    case "enableMcpServer": {
      try {
        sendJson(res, 200, await api.enableMcpServer(params.serverId!), origin);
      } catch (err) {
        sendError(res, 400, err instanceof Error ? err.message : String(err), origin);
      }
      return;
    }

    case "disableMcpServer": {
      try {
        await api.disableMcpServer(params.serverId!);
        sendJson(res, 200, { disabled: true }, origin);
      } catch (err) {
        sendError(res, 400, err instanceof Error ? err.message : String(err), origin);
      }
      return;
    }

    case "retryMcpServer": {
      try {
        sendJson(res, 200, await api.retryMcpServer(params.serverId!), origin);
      } catch (err) {
        sendError(res, 400, err instanceof Error ? err.message : String(err), origin);
      }
      return;
    }

    case "listMcpTools": {
      sendJson(res, 200, api.getMcpTools(), origin);
      return;
    }

    case "getMcpEvents": {
      const afterSeq = parseSeq(routeUrl(req).searchParams.get("afterSeq"));
      sendJson(res, 200, api.getMcpEvents(afterSeq), origin);
      return;
    }

    case "listMcpCatalog": {
      sendJson(res, 200, api.getMcpCatalog(), origin);
      return;
    }

    case "addMcpCatalogEntry": {
      const body = await parseJson(req, options.maxBodyBytes);
      try {
        sendJson(res, 201, api.addMcpCatalogEntry(buildMcpCatalogEntry(body)), origin);
      } catch (err) {
        sendError(res, 400, err instanceof Error ? err.message : String(err), origin);
      }
      return;
    }

    case "installMcpCatalogEntry": {
      try {
        sendJson(res, 201, await api.installMcpCatalogEntry(params.id!), origin);
      } catch (err) {
        sendError(res, 400, err instanceof Error ? err.message : String(err), origin);
      }
      return;
    }

    case "startMcpOAuth": {
      try {
        const auth = await api.startMcpOAuth(params.serverId!);
        sendJson(res, 200, auth, origin);
      } catch (err) {
        sendError(res, 400, err instanceof Error ? err.message : String(err), origin);
      }
      return;
    }

    case "finishMcpOAuthCallback": {
      const url = routeUrl(req);
      const serverId = url.searchParams.get("serverId") ?? "";
      const code = url.searchParams.get("code") ?? "";
      if (!serverId || !code) {
        sendError(res, 400, "Missing MCP OAuth serverId or code", origin);
        return;
      }
      try {
        await api.finishMcpOAuth(serverId, code);
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          ...corsHeaders(origin),
        });
        res.end("<!doctype html><meta charset=\"utf-8\"><title>ForgeAgent MCP OAuth</title><body><h1>MCP authorization complete</h1><p>You can close this window.</p></body>");
      } catch (err) {
        sendError(res, 400, err instanceof Error ? err.message : String(err), origin);
      }
      return;
    }

    case "listMcpElicitations": {
      sendJson(res, 200, api.getMcpElicitationRequests(), origin);
      return;
    }

    case "respondMcpElicitation": {
      const body = await parseJson(req, options.maxBodyBytes);
      try {
        sendJson(res, 200, api.respondMcpElicitation(params.id!, buildMcpElicitationResponse(body)), origin);
      } catch (err) {
        sendError(res, 404, err instanceof Error ? err.message : String(err), origin);
      }
      return;
    }

    case "listSkills": {
      const url = routeUrl(req);
      const includeInactive = url.searchParams.get("includeInactive") === "true";
      const status = url.searchParams.get("status");
      const filter: Parameters<CoreAPI["getSkills"]>[0] = {};
      if (includeInactive) filter.includeInactive = true;
      if (
        status === "active" ||
        status === "disabled" ||
        status === "invalid" ||
        status === "quarantined" ||
        status === "archived"
      ) {
        filter.status = status;
      }
      sendJson(res, 200, {
        skills: api.getSkills(filter),
        status: api.getSkillStatus(),
        evolution: api.getSkillEvolutionStatus(),
      }, origin);
      return;
    }

    case "getSkill": {
      const skill = api.getSkill(params.name!);
      if (!skill) { sendError(res, 404, "Skill not found", origin); return; }
      sendJson(res, 200, skill, origin);
      return;
    }

    case "installSkill": {
      const body = await parseJson(req, options.maxBodyBytes);
      const name = typeof body.name === "string" ? body.name : "";
      if (!name) { sendError(res, 400, "Missing name", origin); return; }
      try {
        const result = await api.installSkill({
          name,
          ...(typeof body.version === "string" ? { version: body.version } : {}),
          ...(typeof body.sourceId === "string" ? { sourceId: body.sourceId } : {}),
          ...(typeof body.registryUrl === "string" ? { registryUrl: body.registryUrl } : {}),
          ...(typeof body.trustUnsigned === "boolean" ? { trustUnsigned: body.trustUnsigned } : {}),
          ...(typeof body.force === "boolean" ? { force: body.force } : {}),
        });
        sendJson(res, 201, result, origin);
      } catch (err) {
        sendError(res, 400, err instanceof Error ? err.message : String(err), origin);
      }
      return;
    }

    case "enableSkill": {
      const body = await parseJson(req, options.maxBodyBytes);
      try {
        sendJson(res, 200, api.enableSkill(
          params.name!,
          typeof body.version === "string" ? body.version : undefined,
        ), origin);
      } catch (err) {
        sendError(res, 400, err instanceof Error ? err.message : String(err), origin);
      }
      return;
    }

    case "disableSkill": {
      const body = await parseJson(req, options.maxBodyBytes);
      try {
        sendJson(res, 200, api.disableSkill(
          params.name!,
          typeof body.reason === "string" ? body.reason : undefined,
        ), origin);
      } catch (err) {
        sendError(res, 400, err instanceof Error ? err.message : String(err), origin);
      }
      return;
    }

    case "rollbackSkill": {
      try {
        sendJson(res, 200, api.rollbackSkill(params.name!), origin);
      } catch (err) {
        sendError(res, 400, err instanceof Error ? err.message : String(err), origin);
      }
      return;
    }

    case "listSkillSources": {
      sendJson(res, 200, api.getSkillSources(), origin);
      return;
    }

    case "addSkillSource": {
      const body = await parseJson(req, options.maxBodyBytes);
      const name = typeof body.name === "string" ? body.name : "";
      const url = typeof body.url === "string" ? body.url : "";
      if (!name) { sendError(res, 400, "Missing name", origin); return; }
      if (!url) { sendError(res, 400, "Missing url", origin); return; }
      sendJson(res, 201, api.addSkillSource({
        ...(typeof body.id === "string" ? { id: body.id } : {}),
        name,
        url,
        ...(typeof body.publicKey === "string" ? { publicKey: body.publicKey } : {}),
        ...(typeof body.trustUnsigned === "boolean" ? { trustUnsigned: body.trustUnsigned } : {}),
      }), origin);
      return;
    }

    case "removeSkillSource": {
      const ok = api.removeSkillSource(params.sourceId!);
      if (!ok) { sendError(res, 404, "Skill source not found", origin); return; }
      sendJson(res, 200, { deleted: true }, origin);
      return;
    }

    case "getSkillEvents": {
      const afterSeq = parseSeq(routeUrl(req).searchParams.get("afterSeq"));
      sendJson(res, 200, api.getSkillEvents(afterSeq), origin);
      return;
    }

    case "diagnostics": {
      sendJson(res, 200, buildDiagnosticsPayload(api, options), origin);
      return;
    }

    case "createSession": {
      const body = await parseJson(req, options.maxBodyBytes);
      const title = typeof body.title === "string" ? body.title : "";
      if (!title) { sendError(res, 400, "Missing title", origin); return; }
      const projectId = typeof body.projectId === "string" ? body.projectId : undefined;
      try {
        sendJson(res, 201, api.createSession(title, projectId ? { projectId } : undefined), origin);
      } catch (err) {
        sendError(res, 400, err instanceof Error ? err.message : String(err), origin);
      }
      return;
    }

    case "listSessions": {
      const projectId = routeUrl(req).searchParams.get("projectId") ?? undefined;
      sendJson(res, 200, sessionViewsForDevice(api, context, options, projectId), origin);
      return;
    }

    case "getSession": {
      const session = api.getSession(params.id!);
      if (!session) { sendError(res, 404, "Session not found", origin); return; }
      sendJson(res, 200, session, origin);
      return;
    }

    case "getThread": {
      const session = api.getSession(params.id!);
      if (!session) { sendError(res, 404, "Session not found", origin); return; }
      const afterSeq = parseSeq(routeUrl(req).searchParams.get("afterSeq"));
      const url = routeUrl(req);
      const state = context ? options.authStore.getDeviceState(context.device.id) : null;
      const branchId = url.searchParams.get("branchId") ||
        state?.selectedBranchBySession?.[params.id!] ||
        session.activeBranchId;
      sendJson(res, 200, api.getVisibleThread(params.id!, branchId).filter((event) => event.seq > afterSeq), origin);
      return;
    }

    case "getBranches": {
      const session = api.getSession(params.id!);
      if (!session) { sendError(res, 404, "Session not found", origin); return; }
      sendJson(res, 200, api.getBranchState(params.id!), origin);
      return;
    }

    case "getSessionUsage": {
      const session = api.getSession(params.id!);
      if (!session) { sendError(res, 404, "Session not found", origin); return; }
      sendJson(res, 200, api.getSessionUsage(params.id!), origin);
      return;
    }

    case "getUsageRecords": {
      const session = api.getSession(params.id!);
      if (!session) { sendError(res, 404, "Session not found", origin); return; }
      const afterSeq = parseSeq(routeUrl(req).searchParams.get("afterSeq"));
      sendJson(res, 200, api.getUsageRecords(params.id!, afterSeq), origin);
      return;
    }

    case "listSessionArtifacts": {
      const session = api.getSession(params.id!);
      if (!session) { sendError(res, 404, "Session not found", origin); return; }
      sendJson(res, 200, api.listArtifacts(params.id!), origin);
      return;
    }

    case "getArtifact": {
      const artifact = api.getArtifactInfo(params.artifactId!);
      if (!artifact) { sendError(res, 404, "Artifact not found", origin); return; }
      const bytes = api.retrieveArtifact(params.artifactId!);
      if (!bytes) { sendError(res, 404, "Artifact content not found", origin); return; }
      sendJson(res, 200, artifactPayload(artifact, bytes, routeUrl(req)), origin);
      return;
    }

    case "previewFile": {
      const paramsUrl = routeUrl(req);
      const filePath = paramsUrl.searchParams.get("path") ?? "";
      const sessionId = paramsUrl.searchParams.get("sessionId") ?? undefined;
      if (!filePath) { sendError(res, 400, "Missing path", origin); return; }
      try {
        sendJson(res, 200, api.previewHtmlFile(filePath, sessionId ? { sessionId } : undefined), origin);
      } catch (err) {
        sendError(res, 400, err instanceof Error ? err.message : String(err), origin);
      }
      return;
    }

    case "appendMessage": {
      const body = await parseJson(req, options.maxBodyBytes);
      const text = typeof body.text === "string" ? body.text : "";
      if (!text) { sendError(res, 400, "Missing text", origin); return; }
      const session = api.getSession(params.id!);
      if (!session) { sendError(res, 404, "Session not found", origin); return; }
      if (session.status !== "idle" && session.status !== "waiting_user" && session.status !== "sleeping") {
        sendError(res, 409, `Session is ${session.status}, cannot send message`, origin);
        return;
      }
      const requestContext = requireContext(context);
      const state = options.authStore.getDeviceState(requestContext.device.id);
      const branchId = typeof body.branchId === "string" && body.branchId
        ? body.branchId
        : state.selectedBranchBySession?.[params.id!] ?? session.activeBranchId;
      const appendOptions: Parameters<CoreAPI["appendUserMessage"]>[2] = {
        source: sourceFromContext(requestContext),
      };
      if (branchId !== undefined) appendOptions.branchId = branchId;
      sendJson(res, 202, api.appendUserMessage(params.id!, text, appendOptions), origin);
      if (branchId) {
        options.authStore.patchDeviceState(requestContext.device.id, {
          selectedBranchBySession: {
            ...(state.selectedBranchBySession ?? {}),
            [params.id!]: branchId,
          },
        });
      }
      return;
    }

    case "createMessageVariant": {
      const body = await parseJson(req, options.maxBodyBytes);
      const replacementText = typeof body.replacementText === "string" ? body.replacementText : "";
      if (!replacementText.trim()) { sendError(res, 400, "Missing replacementText", origin); return; }
      const session = api.getSession(params.id!);
      if (!session) { sendError(res, 404, "Session not found", origin); return; }
      const sourceSeq = Number(params.seq);
      if (!Number.isFinite(sourceSeq) || sourceSeq <= 0) {
        sendError(res, 400, "Invalid message sequence", origin);
        return;
      }
      const requestContext = requireContext(context);
      const branchState = api.createMessageVariant(params.id!, {
        sourceSeq: Math.floor(sourceSeq),
        replacementText,
        dispatch: body.dispatch !== false,
        source: sourceFromContext(requestContext),
      });
      const activeBranchId = branchState.activeBranchId;
      const state = options.authStore.getDeviceState(requestContext.device.id);
      options.authStore.patchDeviceState(requestContext.device.id, {
        selectedBranchBySession: {
          ...(state.selectedBranchBySession ?? {}),
          [params.id!]: activeBranchId,
        },
      });
      sendJson(res, 202, branchState, origin);
      return;
    }

    case "uploadSessionFiles": {
      const session = api.getSession(params.id!);
      if (!session) { sendError(res, 404, "Session not found", origin); return; }
      if (session.status === "archived") {
        sendError(res, 409, "Cannot upload files to an archived session", origin);
        return;
      }
      const files = await parseMultipartFiles(req, options.maxBodyBytes);
      if (files.length === 0) {
        sendError(res, 400, "No files were uploaded.", origin);
        return;
      }
      const uploaded = files.map((file) => api.saveUploadedFile(params.id!, {
        name: file.filename,
        bytes: file.data,
        mimeType: file.contentType,
      }));
      sendJson(res, 201, { files: uploaded }, origin);
      return;
    }

    case "runTurn": {
      const session = api.getSession(params.id!);
      if (!session) { sendError(res, 404, "Session not found", origin); return; }
      const dispatch = api.dispatchTurn(params.id!);
      if (dispatch === "missing") { sendError(res, 404, "Session not found", origin); return; }
      if (dispatch === "not_runnable") {
        sendError(res, 409, `Session is ${session.status}, cannot run turn`, origin);
        return;
      }
      sendJson(res, 202, { status: "accepted", dispatch, sessionId: params.id! }, origin);
      return;
    }

    case "interruptSession": {
      const session = api.getSession(params.id!);
      if (!session) { sendError(res, 404, "Session not found", origin); return; }
      try {
        sendJson(res, 200, api.interruptSession(params.id!), origin);
      } catch (err) {
        sendError(res, 409, err instanceof Error ? err.message : String(err), origin);
      }
      return;
    }

    case "retrySession": {
      const session = api.getSession(params.id!);
      if (!session) { sendError(res, 404, "Session not found", origin); return; }
      if (session.status !== "blocked") {
        sendError(res, 409, `Session is ${session.status}, can only retry blocked sessions`, origin);
        return;
      }
      try {
        api.retryBlockedSession(params.id!);
        sendJson(res, 202, { status: "retrying", sessionId: params.id! }, origin);
      } catch (err) {
        sendError(res, 500, err instanceof Error ? err.message : String(err), origin);
      }
      return;
    }

    case "deleteSession": {
      const session = api.getSession(params.id!);
      if (!session) { sendError(res, 404, "Session not found", origin); return; }
      if (session.status === "running") {
        sendError(res, 409, "Cannot delete a running session", origin);
        return;
      }
      api.deleteSession(params.id!);
      sendJson(res, 200, { deleted: true }, origin);
      return;
    }

    case "updateSession": {
      const session = api.getSession(params.id!);
      if (!session) { sendError(res, 404, "Session not found", origin); return; }
      const body = await parseJson(req, options.maxBodyBytes);
      if (typeof body.title === "string") {
        sendJson(res, 200, api.renameSession(params.id!, body.title), origin);
        return;
      }
      if (typeof body.muted === "boolean") {
        sendJson(res, 200, api.muteSession(params.id!, body.muted), origin);
        return;
      }
      if (typeof body.dangerouslyAllowAllTools === "boolean") {
        const device = requireContext(context).device;
        sendJson(res, 200, api.setSessionDangerousToolApproval(
          params.id!,
          body.dangerouslyAllowAllTools,
          { deviceId: device.id, deviceName: device.name },
        ), origin);
        return;
      }
      sendError(res, 400, "No updatable fields (title, muted, dangerouslyAllowAllTools)", origin);
      return;
    }

    case "createTrigger": {
      const session = api.getSession(params.id!);
      if (!session) { sendError(res, 404, "Session not found", origin); return; }
      const body = await parseJson(req, options.maxBodyBytes);
      const schedule = typeof body.schedule === "string" ? body.schedule : "";
      const prompt = typeof body.prompt === "string" ? body.prompt : "";
      const recurring = body.recurring !== false;
      if (!schedule) { sendError(res, 400, "Missing schedule", origin); return; }
      if (!prompt) { sendError(res, 400, "Missing prompt", origin); return; }
      const validationError = validateSchedule(schedule);
      if (validationError) { sendError(res, 400, validationError, origin); return; }
      const trigger: Trigger = {
        id: crypto.randomUUID(),
        sessionId: params.id!,
        kind: "time",
        schedule,
        payload: { prompt },
        enabled: true,
        recurring,
      };
      api.scheduleTrigger(trigger);
      sendJson(res, 201, trigger, origin);
      return;
    }

    case "listTriggers": {
      const session = api.getSession(params.id!);
      if (!session) { sendError(res, 404, "Session not found", origin); return; }
      sendJson(res, 200, api.listTriggers(params.id!), origin);
      return;
    }

    case "deleteTrigger": {
      const session = api.getSession(params.id!);
      if (!session) { sendError(res, 404, "Session not found", origin); return; }
      const result = api.deleteTrigger(params.triggerId!);
      if (!result) { sendError(res, 404, `Trigger not found: ${params.triggerId}`, origin); return; }
      sendJson(res, 200, { deleted: true }, origin);
      return;
    }

    case "handleSse": {
      const cursor = parseSeq(routeUrl(req).searchParams.get("cursor"));
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        ...corsHeaders(origin),
      });
      res.write(`event: connected\ndata: ${JSON.stringify({ deviceId: requireContext(context).device.id })}\n\n`);
      replayEvents(api, cursor, res);
      gateway.addSseClient(res);
      const keepAlive = setInterval(() => {
        try {
          res.write(": keepalive\n\n");
        } catch {
          clearInterval(keepAlive);
          gateway.removeSseClient(res);
        }
      }, 30_000);
      req.on("close", () => {
        clearInterval(keepAlive);
        gateway.removeSseClient(res);
      });
      return;
    }
  }
}

function buildHealthPayload(
  api: CoreAPI,
  req: IncomingMessage,
  options: ResolvedHttpServerOptions,
): Record<string, unknown> {
  const baseUrl = requestBaseUrl(req);
  const identity = getCoreIdentity(options);
  const runtime = api.getWebridgeRuntime();
  const webridge = runtime
    ? { enabled: true, ...runtime.getHealth() }
    : {
        enabled: false,
        state: "offline",
        message: "ForgeWebridge runtime is not enabled.",
        clients: [],
  };
  return {
    ...identity,
    app: FORGE_AGENT_APP_NAME,
    version: FORGE_AGENT_VERSION,
    status: "ready",
    time: new Date().toISOString(),
    gateway: {
      baseUrl,
      host: options.discovery.host,
      port: options.discovery.port,
    },
    auth: {
      mode: options.authMode,
    },
    setup: options.providerConfigStore.getStatus(),
    webridge,
  };
}

function buildIdentityPayload(options: ResolvedHttpServerOptions): Record<string, unknown> {
  return getCoreIdentity(options);
}

function buildDiscoveryPayload(
  api: CoreAPI,
  req: IncomingMessage,
  options: ResolvedHttpServerOptions,
): Record<string, unknown> {
  const baseUrl = requestBaseUrl(req);
  return {
    ...buildHealthPayload(api, req, options),
    discoveryVersion: 1,
    gateway: {
      baseUrl,
      host: options.discovery.host,
      port: options.discovery.port,
      dataDir: options.discovery.dataDir,
    },
    capabilities: {
      deviceAuth: options.authMode === "device",
      loopbackAutoPair: true,
      forgeWebridge: api.getWebridgeRuntime() !== null,
      sseStreamTokens: true,
    },
    endpoints: {
      health: `${baseUrl}/health`,
      authStatus: `${baseUrl}/auth/status`,
      pairingCodes: `${baseUrl}/auth/pairing-codes`,
      pair: `${baseUrl}/auth/pair`,
      webridgeStatus: `${baseUrl}/webridge/status`,
      webridgeRegister: `${baseUrl}/webridge/register`,
      webridgeHeartbeat: `${baseUrl}/webridge/heartbeat`,
      webridgeCommands: `${baseUrl}/webridge/commands`,
      webridgeResults: `${baseUrl}/webridge/results`,
    },
  };
}

function buildNetworkUrlsPayload(
  req: IncomingMessage,
  options: ResolvedHttpServerOptions,
): Record<string, unknown> {
  const networkUrls = computeNetworkUrls(req, options);
  const identity = getCoreIdentity(options);
  return {
    ...identity,
    ...networkUrls,
    networkUrls,
  };
}

function computeNetworkUrls(
  req: IncomingMessage,
  options: ResolvedHttpServerOptions,
): NetworkUrls {
  const protocol = typeof req.headers["x-forwarded-proto"] === "string"
    ? req.headers["x-forwarded-proto"].split(",")[0]!.trim()
    : "http";
  const port = options.discovery.port ?? parsePort(req.headers.host) ?? 3000;
  const localUrl = `${protocol}://127.0.0.1:${port}`;
  const lanUrls = lanAddresses().map((address) => `${protocol}://${hostForUrl(address)}:${port}`);
  return {
    localUrl,
    lanUrls,
    preferredUrl: lanUrls[0] ?? localUrl,
  };
}

function buildConnectionMetadata(
  req: IncomingMessage,
  options: ResolvedHttpServerOptions,
): Record<string, unknown> {
  const networkUrls = computeNetworkUrls(req, options);
  const identity = getCoreIdentity(options);
  return {
    ...identity,
    networkUrls,
  };
}

function parsePort(host: string | undefined): number | null {
  if (!host) return null;
  const match = /:(\d+)$/.exec(host);
  if (!match) return null;
  const parsed = parseInt(match[1]!, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function lanAddresses(): string[] {
  const addresses: string[] = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.internal) continue;
      if (entry.family !== "IPv4" && entry.family !== "IPv6") continue;
      if (entry.family === "IPv6" && entry.address.startsWith("fe80:")) continue;
      addresses.push(entry.address);
    }
  }
  return Array.from(new Set(addresses)).sort((a, b) => {
    const aPrivate = isPrivateIPv4(a) ? 0 : 1;
    const bPrivate = isPrivateIPv4(b) ? 0 : 1;
    return aPrivate - bPrivate || a.localeCompare(b);
  });
}

function isPrivateIPv4(address: string): boolean {
  return /^10\./.test(address)
    || /^192\.168\./.test(address)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(address);
}

function hostForUrl(address: string): string {
  return address.includes(":") ? `[${address}]` : address;
}

function authenticatePairingCodeRequest(
  req: IncomingMessage,
  options: ResolvedHttpServerOptions,
): AuthenticatedRequestContext | null {
  if (options.authMode === "disabled") return disabledContext();
  const token = bearerToken(req);
  if (token) {
    const device = options.authStore.authenticateBearer(token);
    if (!device) throw new UnauthorizedError();
    return { authMethod: "bearer", device };
  }
  if (isLoopback(req)) return null;
  throw new UnauthorizedError();
}

function requireContext(
  context: AuthenticatedRequestContext | null,
): AuthenticatedRequestContext {
  if (!context) throw new UnauthorizedError();
  return context;
}

function replayEvents(api: CoreAPI, cursor: number, res: ServerResponse): void {
  const items: Array<
    | { seq: number; eventType: "session_event"; data: { sessionId: string; event: SessionEvent } }
    | { seq: number; eventType: "system_event"; data: SystemEvent }
    | { seq: number; eventType: "skill_event"; data: ReturnType<CoreAPI["getSkillEvents"]>[number] }
  > = [];

  for (const session of api.listSessions()) {
    for (const event of api.getThread(session.id)) {
      if (event.seq > cursor) {
        items.push({
          seq: event.seq,
          eventType: "session_event",
          data: { sessionId: session.id, event },
        });
      }
    }
  }
  for (const event of api.getSystemEvents()) {
    if (event.seq > cursor) {
      items.push({ seq: event.seq, eventType: "system_event", data: event });
    }
  }
  for (const event of api.getSkillEvents(cursor)) {
    items.push({ seq: event.seq, eventType: "skill_event", data: event });
  }

  items.sort((a, b) => a.seq - b.seq);
  for (const item of items) {
    res.write(`event: ${item.eventType}\ndata: ${JSON.stringify(item.data)}\n\n`);
  }
  res.write("event: session_list_changed\ndata: {}\n\n");
}
