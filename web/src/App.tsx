import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, MouseEvent } from "react";
import QRCode from "qrcode";
import { api, ensureDeviceToken, forgetDeviceToken } from "./api";
import { AssistantContent } from "./AssistantContent";
import { RichText } from "./RichText";
import { openHtmlPreviewDocument } from "./html-preview-window";
import { buildRenderEvents, type RenderEvent } from "./render-events";
import { sessionIndicator } from "./session-ui";
import { nativeNotificationForEvent } from "./notifications";
import type {
  DeviceState,
  Diagnostics,
  ExtensionCandidate,
  ExtensionStatus,
  PermissionRequest,
  Project,
  Session,
  SessionBranchState,
  SessionEvent,
  SessionUsageSummary,
  SetupStatus,
} from "./types";

type LoadState = "booting" | "ready" | "error";
type MainView = "chat" | "extensions";
type RailPanel = "provider" | "android" | "browser" | "mcp" | "context" | "permissions" | "notifications" | "memory" | "skills";

const LEFT_COLLAPSED_KEY = "forgeagent.web.leftCollapsed";

declare global {
  interface Window {
    webkit?: {
      messageHandlers?: {
        forgeNative?: {
          postMessage: (message: unknown) => void;
        };
      };
    };
  }
}

function maxSeq(events: SessionEvent[]): number {
  return events.reduce((max, event) => Math.max(max, event.seq), 0);
}

function isUnreadTriggerEvent(event: SessionEvent): boolean {
  return event.type === "assistant_message" ||
    event.type === "permission_request" ||
    event.type === "runtime_event";
}

function mergeEvent(events: SessionEvent[], event: SessionEvent): SessionEvent[] {
  if (events.some((existing) => existing.seq === event.seq)) return events;
  return [...events, event].sort((a, b) => a.seq - b.seq);
}

function eventBranchId(event: SessionEvent): string {
  return event.branchId ?? "main";
}

function branchIdForSession(state: DeviceState | null, session: Session | null): string {
  if (!session) return "main";
  return state?.selectedBranchBySession?.[session.id] ?? session.activeBranchId ?? "main";
}

function selectedBranchMap(state: DeviceState | null, sessionId: string, branchId: string): Record<string, string> {
  return {
    ...(state?.selectedBranchBySession ?? {}),
    [sessionId]: branchId,
  };
}

function withDeviceStateDefaults(state: DeviceState): DeviceState {
  return {
    ...state,
    sessionReadSeq: state.sessionReadSeq ?? {},
    mutedSessionIds: state.mutedSessionIds ?? [],
    notificationSettings: state.notificationSettings ?? {
      enabled: false,
      lastNotifiedSeq: 0,
    },
  };
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function compactNumber(value: number | undefined): string {
  if (value === undefined) return "—";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
  return String(value);
}

function formatBytes(value: number): string {
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  if (value >= 1024) return `${Math.round(value / 1024)} KB`;
  return `${value} B`;
}

function pickNativeWorkspace(kind: "open" | "create"): Promise<string | null> {
  const handler = window.webkit?.messageHandlers?.forgeNative;
  if (!handler) return Promise.resolve(null);
  const id = crypto.randomUUID();
  return new Promise((resolve) => {
    const timeout = window.setTimeout(() => {
      window.removeEventListener("forge-native-response", listener);
      resolve(null);
    }, 60_000);
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<{ id?: string; path?: string | null }>).detail;
      if (detail?.id !== id) return;
      window.clearTimeout(timeout);
      window.removeEventListener("forge-native-response", listener);
      resolve(detail.path || null);
    };
    window.addEventListener("forge-native-response", listener);
    handler.postMessage({ id, kind: kind === "create" ? "createWorkspaceFolder" : "pickWorkspaceFolder" });
  });
}

export function App() {
  const [loadState, setLoadState] = useState<LoadState>("booting");
  const [error, setError] = useState<string>("");
  const [setup, setSetup] = useState<SetupStatus | null>(null);
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selectedId, setSelectedId] = useState<string>("");
  const [thread, setThread] = useState<SessionEvent[]>([]);
  const [branchState, setBranchState] = useState<SessionBranchState | null>(null);
  const [selectedBranchId, setSelectedBranchId] = useState("main");
  const [usage, setUsage] = useState<SessionUsageSummary | null>(null);
  const [deviceState, setDeviceState] = useState<DeviceState | null>(null);
  const [mainView, setMainView] = useState<MainView>("chat");
  const [extensionStatus, setExtensionStatus] = useState<ExtensionStatus | null>(null);
  const [extensionCandidates, setExtensionCandidates] = useState<ExtensionCandidate[]>([]);
  const [extensionsLoading, setExtensionsLoading] = useState(false);
  const [pendingPermissions, setPendingPermissions] = useState<PermissionRequest[]>([]);
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<File[]>([]);
  const [editingSeq, setEditingSeq] = useState<number | null>(null);
  const [editingDraft, setEditingDraft] = useState("");
  const [sessionQuery, setSessionQuery] = useState("");
  const [leftCollapsed, setLeftCollapsed] = useState(() => {
    const stored = localStorage.getItem(LEFT_COLLAPSED_KEY);
    if (stored) return stored === "1";
    return window.matchMedia?.("(max-width: 760px)").matches === true;
  });
  const [railPanel, setRailPanel] = useState<RailPanel | null>(null);
  const [busy, setBusy] = useState(false);
  const [dangerBusy, setDangerBusy] = useState(false);
  const [dangerNotice, setDangerNotice] = useState("");
  const [dangerConfirm, setDangerConfirm] = useState(false);
  const [projectBusy, setProjectBusy] = useState(false);
  const selectedIdRef = useRef("");
  const selectedProjectIdRef = useRef("");
  const selectedBranchIdRef = useRef("main");
  const deviceStateRef = useRef<DeviceState | null>(null);
  const sessionsRef = useRef<Session[]>([]);
  const threadRef = useRef<SessionEvent[]>([]);
  const readSeqRef = useRef<Record<string, number>>({});
  const lastNotifiedSeqRef = useRef(0);
  const markReadInFlightRef = useRef<Promise<void> | null>(null);
  const cursorRef = useRef(0);
  const threadScrollRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);
  const draftRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const selected = useMemo(
    () => sessions.find((session) => session.id === selectedId) ?? null,
    [sessions, selectedId],
  );
  const selectedProject = useMemo(
    () => projects.find((project) => project.id === selectedProjectId) ?? projects.find((project) => project.status !== "archived") ?? null,
    [projects, selectedProjectId],
  );
  const renderThread = useMemo(
    () => buildRenderEvents(thread),
    [thread],
  );
  const deletableSessions = useMemo(
    () => sessions.filter((session) => (
      (!selectedProjectId || session.projectId === selectedProjectId) &&
      (session.status === "idle" || session.status === "blocked")
    )),
    [selectedProjectId, sessions],
  );
  const visibleSessions = useMemo(() => {
    const query = sessionQuery.trim().toLowerCase();
    const scoped = selectedProjectId
      ? sessions.filter((session) => session.projectId === selectedProjectId)
      : sessions;
    if (!query) return scoped;
    return scoped.filter((session) => session.title.toLowerCase().includes(query));
  }, [selectedProjectId, sessionQuery, sessions]);

  useEffect(() => {
    localStorage.setItem(LEFT_COLLAPSED_KEY, leftCollapsed ? "1" : "0");
  }, [leftCollapsed]);

  useEffect(() => {
    const media = window.matchMedia?.("(max-width: 760px)");
    if (!media) return undefined;

    const collapseForMobile = () => {
      if (media.matches) setLeftCollapsed(true);
    };

    collapseForMobile();
    media.addEventListener?.("change", collapseForMobile);
    return () => media.removeEventListener?.("change", collapseForMobile);
  }, []);

  useEffect(() => {
    threadRef.current = thread;
  }, [thread]);

  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  useEffect(() => {
    selectedProjectIdRef.current = selectedProjectId;
  }, [selectedProjectId]);

  useEffect(() => {
    selectedBranchIdRef.current = selectedBranchId;
  }, [selectedBranchId]);

  const loadDeviceState = useCallback(async () => {
    const next = withDeviceStateDefaults(await api.deviceState());
    readSeqRef.current = next.sessionReadSeq;
    lastNotifiedSeqRef.current = next.notificationSettings.lastNotifiedSeq;
    deviceStateRef.current = next;
    setDeviceState(next);
    return next;
  }, []);

  const patchDeviceState = useCallback(async (patch: Partial<Pick<DeviceState, "selectedProjectId" | "selectedSessionId" | "selectedBranchBySession" | "sessionReadSeq" | "mutedSessionIds" | "notificationSettings">>) => {
    const next = withDeviceStateDefaults(await api.patchDeviceState(patch));
    readSeqRef.current = next.sessionReadSeq;
    lastNotifiedSeqRef.current = next.notificationSettings.lastNotifiedSeq;
    deviceStateRef.current = next;
    setDeviceState(next);
    return next;
  }, []);

  const markSessionRead = useCallback((sessionId: string, seq: number) => {
    if (!sessionId || seq <= 0) return;
    const current = readSeqRef.current[sessionId] ?? 0;
    if (seq <= current) return;
    const sessionReadSeq = { ...readSeqRef.current, [sessionId]: seq };
    readSeqRef.current = sessionReadSeq;
    setSessions((items) => items.map((session) => (
      session.id === sessionId && (session.latestAgentResultSeq ?? 0) <= seq
        ? { ...session, unread: false }
        : session
    )));

    const run = async () => {
      await patchDeviceState({
        selectedSessionId: sessionId,
        sessionReadSeq,
      });
    };
    markReadInFlightRef.current = (markReadInFlightRef.current ?? Promise.resolve())
      .then(run)
      .catch((err) => {
        setError(err instanceof Error ? err.message : String(err));
      });
  }, [patchDeviceState]);

  const markNativeNotificationSeen = useCallback(async (seq: number) => {
    if (seq <= lastNotifiedSeqRef.current) return;
    const notificationSettings = {
      ...(deviceStateRef.current?.notificationSettings ?? { enabled: false, lastNotifiedSeq: 0 }),
      lastNotifiedSeq: seq,
    };
    lastNotifiedSeqRef.current = seq;
    await patchDeviceState({ notificationSettings });
  }, [patchDeviceState]);

  const maybeNotifyNative = useCallback((sessionId: string, event: SessionEvent) => {
    const state = deviceStateRef.current;
    if (!state?.notificationSettings.enabled) return;
    if (event.seq <= lastNotifiedSeqRef.current) return;
    if (state.mutedSessionIds.includes(sessionId)) {
      void markNativeNotificationSeen(event.seq).catch(() => undefined);
      return;
    }
    const payload = nativeNotificationForEvent(sessionId, event);
    if (!payload) return;
    const isCurrentVisible = document.visibilityState === "visible" &&
      selectedIdRef.current === sessionId &&
      stickToBottomRef.current;
    if (isCurrentVisible) {
      void markNativeNotificationSeen(event.seq).catch(() => undefined);
      return;
    }
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    const notification = new Notification(payload.title, {
      body: payload.body,
      tag: payload.tag,
    });
    notification.onclick = () => {
      window.focus();
      setSelectedId(sessionId);
      void patchDeviceState({ selectedSessionId: sessionId }).catch(() => undefined);
      notification.close();
    };
    void markNativeNotificationSeen(event.seq).catch(() => undefined);
  }, [markNativeNotificationSeen, patchDeviceState]);

  const setWebNotificationsEnabled = useCallback(async (enabled: boolean) => {
    if (enabled) {
      if (!("Notification" in window)) {
        setError("This browser does not support desktop notifications.");
        return;
      }
      const permission = Notification.permission === "default"
        ? await Notification.requestPermission()
        : Notification.permission;
      if (permission !== "granted") {
        setError("Desktop notifications were not granted.");
        await patchDeviceState({
          notificationSettings: {
            ...(deviceStateRef.current?.notificationSettings ?? { enabled: false, lastNotifiedSeq: 0 }),
            enabled: false,
          },
        });
        return;
      }
    }
    setError("");
    await patchDeviceState({
      notificationSettings: {
        ...(deviceStateRef.current?.notificationSettings ?? { enabled: false, lastNotifiedSeq: 0 }),
        enabled,
      },
    });
  }, [patchDeviceState]);

  const reloadProjects = useCallback(async (preferredProjectId?: string) => {
    const next = await api.projects();
    const active = next
      .filter((project) => project.status !== "archived")
      .sort((a, b) => new Date(b.lastOpenedAt ?? b.updatedAt).getTime() - new Date(a.lastOpenedAt ?? a.updatedAt).getTime());
    setProjects(active);
    setSelectedProjectId((current) => {
      if (preferredProjectId && active.some((project) => project.id === preferredProjectId)) return preferredProjectId;
      const deviceProjectId = deviceStateRef.current?.selectedProjectId;
      if (deviceProjectId && active.some((project) => project.id === deviceProjectId)) return deviceProjectId;
      if (current && active.some((project) => project.id === current)) return current;
      return active[0]?.id ?? "";
    });
    return active;
  }, []);

  const reloadSessions = useCallback(async (preferredId?: string, projectId?: string) => {
    const scopedProjectId = projectId ?? (selectedProjectIdRef.current || undefined);
    const next = await api.sessions(scopedProjectId);
    const ordered = next
      .filter((session) => session.status !== "archived")
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    sessionsRef.current = ordered;
    setSessions(ordered);
    setSelectedId((current) => {
      if (preferredId && ordered.some((session) => session.id === preferredId)) return preferredId;
      if (selectedIdRef.current && ordered.some((session) => session.id === selectedIdRef.current)) {
        return selectedIdRef.current;
      }
      if (current && ordered.some((session) => session.id === current)) return current;
      return ordered[0]?.id ?? "";
    });
    return ordered;
  }, []);

  const reloadStatus = useCallback(async () => {
    const [setupNext, diagnosticsNext, permissionsNext] = await Promise.all([
      api.setupStatus(),
      api.diagnostics(),
      api.pendingPermissions(),
    ]);
    setSetup(setupNext);
    setDiagnostics(diagnosticsNext);
    setPendingPermissions(permissionsNext);
  }, []);

  const reloadExtensions = useCallback(async () => {
    const status = await api.extensions();
    setExtensionStatus(status);
    return status;
  }, []);

  const loadThread = useCallback(async (sessionId: string, requestedBranchId?: string) => {
    if (!sessionId) {
      setThread([]);
      setBranchState(null);
      setSelectedBranchId("main");
      setUsage(null);
      stickToBottomRef.current = true;
      return;
    }
    const branches = await api.branches(sessionId);
    const session = sessionsRef.current.find((item) => item.id === sessionId) ?? null;
    const branchId = requestedBranchId ||
      deviceStateRef.current?.selectedBranchBySession?.[sessionId] ||
      branches.activeBranchId ||
      session?.activeBranchId ||
      "main";
    const [events, usageNext] = await Promise.all([
      api.thread(sessionId, 0, branchId),
      api.usage(sessionId).catch(() => null),
    ]);
    setBranchState(branches);
    setSelectedBranchId(branchId);
    setThread(events);
    setUsage(usageNext);
    stickToBottomRef.current = true;
    cursorRef.current = Math.max(cursorRef.current, maxSeq(events));
    markSessionRead(sessionId, maxSeq(events));
  }, [markSessionRead]);

  const boot = useCallback(async () => {
    setLoadState("booting");
    setError("");
    try {
      await ensureDeviceToken();
      await Promise.all([reloadStatus(), loadDeviceState()]);
      const projectsNext = await reloadProjects();
      const projectId = deviceStateRef.current?.selectedProjectId && projectsNext.some((project) => project.id === deviceStateRef.current?.selectedProjectId)
        ? deviceStateRef.current.selectedProjectId
        : projectsNext[0]?.id ?? "";
      if (projectId) {
        selectedProjectIdRef.current = projectId;
        setSelectedProjectId(projectId);
        await patchDeviceState({ selectedProjectId: projectId });
      }
      const requestedSessionId = new URLSearchParams(window.location.search).get("selectSessionId") ?? "";
      const ordered = await reloadSessions(requestedSessionId || undefined, projectId);
      const first = requestedSessionId && ordered.some((session) => session.id === requestedSessionId)
        ? requestedSessionId
        : ordered[0]?.id ?? "";
      if (first) await loadThread(first);
      if (requestedSessionId) {
        window.history.replaceState({}, "", window.location.pathname);
      }
      setLoadState("ready");
    } catch (err) {
      setLoadState("error");
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [loadDeviceState, loadThread, patchDeviceState, reloadProjects, reloadSessions, reloadStatus]);

  useEffect(() => {
    void boot();
  }, [boot]);

  useEffect(() => {
    selectedIdRef.current = selectedId;
    setAttachments([]);
    setDangerConfirm(false);
    setDangerNotice("");
    if (selectedId) {
      void patchDeviceState({ selectedSessionId: selectedId }).catch(() => undefined);
    }
    void loadThread(selectedId).catch((err) => {
      setError(err instanceof Error ? err.message : String(err));
    });
  }, [loadThread, patchDeviceState, selectedId]);

  useEffect(() => {
    if (loadState !== "ready") return undefined;
    let closed = false;
    let source: EventSource | null = null;
    let reconnectTimer: number | undefined;

    const connect = async () => {
      try {
        const issued = await api.streamToken();
        if (closed) return;
        source = new EventSource(`/events?cursor=${cursorRef.current}&stream_token=${encodeURIComponent(issued.code)}`);
        source.addEventListener("session_event", (message) => {
          const data = JSON.parse((message as MessageEvent).data) as { sessionId: string; event: SessionEvent };
          cursorRef.current = Math.max(cursorRef.current, data.event.seq);
          maybeNotifyNative(data.sessionId, data.event);
          if (data.sessionId === selectedIdRef.current) {
            const currentBranchId = selectedBranchIdRef.current || "main";
            if (eventBranchId(data.event) === currentBranchId) {
              setThread((current) => mergeEvent(current, data.event));
              if (stickToBottomRef.current) {
                markSessionRead(data.sessionId, data.event.seq);
              }
            }
            if (data.event.type === "usage_event" || data.event.type === "context_usage_event") {
              void api.usage(data.sessionId).then(setUsage).catch(() => undefined);
            }
          }
          if (data.event.type === "permission_request" || data.event.type === "permission_response") {
            void api.pendingPermissions().then(setPendingPermissions).catch(() => undefined);
          }
          if (isUnreadTriggerEvent(data.event) || data.event.type === "user_message") {
            void reloadSessions(selectedIdRef.current || undefined).catch(() => undefined);
          }
        });
        source.addEventListener("system_event", (message) => {
          const event = JSON.parse((message as MessageEvent).data) as { seq?: number };
          if (typeof event.seq === "number") cursorRef.current = Math.max(cursorRef.current, event.seq);
          void reloadStatus().catch(() => undefined);
        });
        source.addEventListener("session_list_changed", () => {
          void reloadSessions().catch(() => undefined);
        });
        source.addEventListener("skill_event", () => {
          void reloadStatus().catch(() => undefined);
        });
        source.onerror = () => {
          source?.close();
          if (!closed) reconnectTimer = window.setTimeout(connect, 2000);
        };
      } catch {
        if (!closed) reconnectTimer = window.setTimeout(connect, 2000);
      }
    };

    void connect();
    return () => {
      closed = true;
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      source?.close();
    };
  }, [loadState, markSessionRead, maybeNotifyNative, reloadSessions, reloadStatus]);

  useEffect(() => {
    if (!stickToBottomRef.current) return;
    const scroll = threadScrollRef.current;
    if (!scroll) return;
    window.requestAnimationFrame(() => {
      scroll.scrollTop = scroll.scrollHeight;
    });
  }, [renderThread]);

  useEffect(() => {
    if (mainView !== "extensions") return;
    let cancelled = false;
    setExtensionsLoading(true);
    setError("");
    void Promise.allSettled([
      reloadExtensions(),
      api.searchExtensions({ includeInstalled: true }),
    ]).then((results) => {
      if (cancelled) return;
      const [statusResult, searchResult] = results;
      if (searchResult.status === "fulfilled") {
        setExtensionCandidates(searchResult.value.candidates);
      }
      const firstError = [statusResult, searchResult].find((result) => result.status === "rejected");
      if (firstError?.status === "rejected") {
        setError(firstError.reason instanceof Error ? firstError.reason.message : String(firstError.reason));
      }
    }).finally(() => {
      if (!cancelled) setExtensionsLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [mainView, reloadExtensions]);

  useLayoutEffect(() => {
    const textarea = draftRef.current;
    if (!textarea) return;
    const maxHeight = Math.max(120, Math.floor(window.innerHeight * 0.6) - 48);
    textarea.style.height = "auto";
    const nextHeight = Math.min(textarea.scrollHeight, maxHeight);
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY = textarea.scrollHeight > maxHeight ? "auto" : "hidden";
  }, [draft]);

  async function submitMessage() {
    const text = draft.trim();
    if ((!text && attachments.length === 0) || busy) return;
    if (!setup?.provider.configured) {
      setError("Configure DeepSeek before sending a message.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      let sessionId = selectedId;
      if (!sessionId) {
        const created = await api.createSession("New session", selectedProjectIdRef.current || undefined);
        sessionId = created.id;
        await reloadSessions(sessionId);
      }
      let finalText = text;
      if (attachments.length > 0) {
        const uploaded = await api.uploadFiles(sessionId, attachments);
        const lines = uploaded.files.map((file) => (
          `- ${file.name} (${formatBytes(file.sizeBytes)}, ${file.mimeType}): ${file.path}`
        ));
        finalText = [
          text || "Please use the uploaded file(s).",
          "",
          "Uploaded files available to ForgeAgent:",
          ...lines,
          "",
          "Use the file paths above when reading or processing these uploads.",
        ].join("\n");
      }
      setDraft("");
      setAttachments([]);
      const branchId = selectedBranchIdRef.current || "main";
      await api.sendMessage(sessionId, finalText, branchId);
      await reloadSessions(sessionId);
      await loadThread(sessionId, branchId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function createSession() {
    setBusy(true);
    setError("");
    try {
      const created = await api.createSession("New session", selectedProjectIdRef.current || undefined);
      await reloadSessions(created.id);
      setThread([]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function selectProject(projectId: string) {
    if (!projectId || projectId === selectedProjectId) return;
    setProjectBusy(true);
    setError("");
    try {
      selectedProjectIdRef.current = projectId;
      setSelectedProjectId(projectId);
      await patchDeviceState({ selectedProjectId: projectId, selectedSessionId: "" });
      const ordered = await reloadSessions(undefined, projectId);
      const next = ordered[0]?.id ?? "";
      setSelectedId(next);
      selectedIdRef.current = next;
      if (next) await loadThread(next);
      else {
        setThread([]);
        setBranchState(null);
        setUsage(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setProjectBusy(false);
    }
  }

  async function createWorkspaceProject(kind: "open" | "create") {
    setProjectBusy(true);
    setError("");
    try {
      const nativePath = await pickNativeWorkspace(kind);
      const path = nativePath ?? window.prompt(
        kind === "create"
          ? "Enter the full path for the new workspace folder."
          : "Enter the full path of an existing workspace folder.",
        kind === "create" ? `${navigator.platform.includes("Mac") ? "/Users/" : ""}` : "",
      );
      if (!path) return;
      const project = await api.createProject({
        path,
        create: kind === "create",
        trustState: "trusted",
      });
      await reloadProjects(project.id);
      await selectProject(project.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setProjectBusy(false);
    }
  }

  async function selectSession(sessionId: string) {
    setMainView("chat");
    selectedIdRef.current = sessionId;
    setSelectedId(sessionId);
    try {
      await patchDeviceState({ selectedSessionId: sessionId });
      await loadThread(sessionId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function selectBranch(branchId: string) {
    if (!selected || branchId === selectedBranchId) return;
    try {
      const selectedBranchBySession = selectedBranchMap(deviceStateRef.current, selected.id, branchId);
      await patchDeviceState({ selectedSessionId: selected.id, selectedBranchBySession });
      setSelectedBranchId(branchId);
      selectedBranchIdRef.current = branchId;
      setEditingSeq(null);
      setEditingDraft("");
      await loadThread(selected.id, branchId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function beginEditUserMessage(event: Extract<SessionEvent, { type: "user_message" }>) {
    if (selected?.status === "running") {
      setError("Interrupt the running session before editing a previous message.");
      return;
    }
    setEditingSeq(event.seq);
    setEditingDraft(event.text);
  }

  async function submitEditedUserMessage() {
    if (!selected || editingSeq === null) return;
    const replacementText = editingDraft.trim();
    if (!replacementText) return;
    setBusy(true);
    setError("");
    try {
      const nextBranchState = await api.createMessageVariant(selected.id, editingSeq, replacementText);
      const branchId = nextBranchState.activeBranchId;
      const selectedBranchBySession = selectedBranchMap(deviceStateRef.current, selected.id, branchId);
      await patchDeviceState({ selectedSessionId: selected.id, selectedBranchBySession });
      setBranchState(nextBranchState);
      setSelectedBranchId(branchId);
      selectedBranchIdRef.current = branchId;
      setEditingSeq(null);
      setEditingDraft("");
      await reloadSessions(selected.id);
      await loadThread(selected.id, branchId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function deleteSession(session: Session, event?: MouseEvent) {
    event?.stopPropagation();
    if (session.status === "running") {
      setError("Running sessions must be interrupted before deletion.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await api.deleteSession(session.id);
      const ordered = await reloadSessions(session.id === selectedId ? undefined : selectedId);
      if (session.id === selectedId) {
        const next = ordered.find((item) => item.id !== session.id)?.id ?? "";
        setSelectedId(next);
        if (next) await loadThread(next);
        else {
          setThread([]);
          setUsage(null);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function deleteIdleAndBlockedSessions() {
    if (deletableSessions.length === 0) return;
    setBusy(true);
    setError("");
    try {
      for (const session of deletableSessions) {
        await api.deleteSession(session.id);
      }
      const ordered = await reloadSessions();
      const selectedStillExists = ordered.some((session) => session.id === selectedId);
      if (!selectedStillExists) {
        const next = ordered[0]?.id ?? "";
        setSelectedId(next);
        if (next) await loadThread(next);
        else {
          setThread([]);
          setUsage(null);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function updateThreadStickiness() {
    const scroll = threadScrollRef.current;
    if (!scroll) return;
    const distanceFromBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight;
    const atBottom = distanceFromBottom < 80;
    stickToBottomRef.current = atBottom;
    if (atBottom && selectedIdRef.current) {
      markSessionRead(selectedIdRef.current, maxSeq(threadRef.current));
    }
  }

  async function respondPermission(id: string, decision: "allow_once" | "allow_session" | "deny") {
    try {
      await api.respondPermission(id, decision);
      setPendingPermissions(await api.pendingPermissions());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function respondMcpElicitation(id: string, accept: boolean) {
    try {
      let content: Record<string, unknown> | undefined;
      if (accept) {
        const raw = window.prompt("Enter MCP response JSON, or leave blank for an empty response.", "{}");
        if (raw === null) return;
        if (raw.trim()) {
          const parsed = JSON.parse(raw) as unknown;
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw new Error("MCP elicitation response must be a JSON object.");
          }
          content = parsed as Record<string, unknown>;
        }
      }
      await api.respondMcpElicitation(id, { accept, ...(content ? { content } : {}) });
      if (selectedIdRef.current) await loadThread(selectedIdRef.current);
      await reloadStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function toggleDangerousMode() {
    if (!selected) {
      setError("Select a session before changing dangerous free mode.");
      return;
    }
    const enabling = selected.dangerouslyAllowAllTools !== true;
    if (enabling) {
      setDangerConfirm(true);
      setDangerNotice("");
      return;
    }
    await setDangerousMode(false);
  }

  async function setDangerousMode(enabling: boolean) {
    if (!selected) return;
    setDangerBusy(true);
    setDangerConfirm(false);
    setDangerNotice("");
    setError("");
    try {
      await api.updateSession(selected.id, { dangerouslyAllowAllTools: enabling });
      await reloadSessions(selected.id);
      await loadThread(selected.id);
      setDangerNotice(enabling ? "Danger free is on for this session." : "Danger free is off.");
      if (enabling) {
        setPendingPermissions(await api.pendingPermissions());
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDangerBusy(false);
    }
  }

  async function runInterrupt() {
    if (!selected) return;
    try {
      await api.interrupt(selected.id);
      await reloadSessions(selected.id);
      await loadThread(selected.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function runRetry() {
    if (!selected) return;
    try {
      await api.retry(selected.id);
      await reloadSessions(selected.id);
      await loadThread(selected.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  if (loadState === "booting") {
    return <div className="boot">Opening ForgeAgent…</div>;
  }

  if (loadState === "error") {
    return (
      <div className="boot boot-error">
        <h1>ForgeAgent</h1>
        <p>{error}</p>
        <button onClick={() => { forgetDeviceToken(); void boot(); }}>Reconnect local console</button>
      </div>
    );
  }

  const answeredPermissionIds = new Set(
    thread
      .filter((event): event is Extract<SessionEvent, { type: "permission_response" }> => event.type === "permission_response")
      .map((event) => event.permissionRequestId),
  );

  return (
    <main className={`app-shell ${leftCollapsed ? "sidebar-collapsed" : ""} ${railPanel ? "rail-open" : ""}`}>
      <aside className={`sidebar ${leftCollapsed ? "collapsed" : ""}`}>
        <div className="brand-row">
          {!leftCollapsed ? <div className="brand">ForgeAgent</div> : <div className="brand-mark">F</div>}
          <button
            className="icon-button"
            onClick={() => setLeftCollapsed((value) => !value)}
            aria-label={leftCollapsed ? "Expand session sidebar" : "Collapse session sidebar"}
            title={leftCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {leftCollapsed ? "›" : "‹"}
          </button>
        </div>
        <button
          className="new-session"
          onClick={() => void createSession()}
          disabled={busy || projectBusy || !selectedProject}
          title="New session"
        >
          {leftCollapsed ? "+" : "+ New Session"}
        </button>
        <button
          className={`sidebar-nav-button ${mainView === "extensions" ? "active" : ""}`}
          onClick={() => setMainView((view) => view === "extensions" ? "chat" : "extensions")}
          title="Extensions"
        >
          {leftCollapsed ? "◇" : "Extensions"}
        </button>
        {!leftCollapsed ? (
          <>
            <div className="project-switcher">
              <label>
                Project
                <select
                  value={selectedProjectId}
                  disabled={projectBusy}
                  onChange={(event) => void selectProject(event.target.value)}
                >
                  {projects.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))}
                </select>
              </label>
              <div className="project-path" title={selectedProject?.path ?? ""}>
                {selectedProject?.path ?? "No workspace"}
              </div>
              <div className="project-actions">
                <button type="button" onClick={() => void createWorkspaceProject("open")} disabled={projectBusy}>
                  Open folder
                </button>
                <button type="button" onClick={() => void createWorkspaceProject("create")} disabled={projectBusy}>
                  New folder
                </button>
              </div>
            </div>
            <button
              className="clear-sessions"
              onClick={() => void deleteIdleAndBlockedSessions()}
              disabled={busy || deletableSessions.length === 0}
            >
              Clear idle/blocked
              <span>{deletableSessions.length}</span>
            </button>
            <input
              className="sidebar-search"
              value={sessionQuery}
              onChange={(event) => setSessionQuery(event.target.value)}
              placeholder="Filter sessions…"
            />
          </>
        ) : null}
        <div className="session-list">
          {visibleSessions.map((session) => (
            <div
              key={session.id}
              className={`session-row ${session.id === selectedId ? "selected" : ""}`}
            >
              <button
                className="session-select"
                onClick={() => void selectSession(session.id)}
                title={session.title}
              >
                <SessionStateIndicator session={session} />
                {!leftCollapsed ? (
                  <>
                    <span className="session-title">{session.title}</span>
                    <span className="session-time">{formatTime(session.updatedAt)}</span>
                  </>
                ) : null}
              </button>
              {!leftCollapsed ? (
                <button
                  className="session-delete"
                  aria-label={`Delete ${session.title}`}
                  title={session.status === "running" ? "Interrupt before deleting" : "Delete session"}
                  disabled={busy || session.status === "running"}
                  onClick={(event) => void deleteSession(session, event)}
                >
                  ×
                </button>
              ) : null}
            </div>
          ))}
        </div>
        {!leftCollapsed ? <div className="sidebar-footer">
          <span className="avatar">L</span>
          <span>{selectedProject?.name ?? "No project"}</span>
        </div> : null}
      </aside>
      {!leftCollapsed ? (
        <button
          type="button"
          className="mobile-sidebar-backdrop"
          aria-label="Close session sidebar"
          onClick={() => setLeftCollapsed(true)}
        />
      ) : null}

      <section className="reader">
        {mainView === "extensions" ? (
          <ExtensionsCenter
            status={extensionStatus}
            candidates={extensionCandidates}
            loading={extensionsLoading}
            onCandidates={setExtensionCandidates}
            onReload={reloadExtensions}
            onError={setError}
            onOpenChat={() => setMainView("chat")}
          />
        ) : (
        <>
        <header className="session-strip">
          <div className="session-strip-main">
            <SessionStateIndicator session={selected} />
            <div>
              <strong>{selected?.title ?? "New conversation"}</strong>
              <span>
                {selected ? `${selected.status} · ${formatTime(selected.updatedAt)}` : "No session selected"}
                {selectedProject ? ` · ${selectedProject.name}` : ""}
                {usage?.contextUsedPercent !== undefined ? ` · ctx ${usage.contextUsedPercent.toFixed(0)}%` : ""}
              </span>
            </div>
          </div>
          <div className="header-actions">
            {selected?.status === "running" ? <button onClick={() => void runInterrupt()}>Interrupt</button> : null}
            {selected?.status === "blocked" ? <button onClick={() => void runRetry()}>Retry</button> : null}
          </div>
        </header>

        <div
          className="thread-scroll"
          ref={threadScrollRef}
          onScroll={updateThreadStickiness}
        >
          {error ? <div className="inline-error">{error}</div> : null}
          {setup && !setup.provider.configured ? (
            <ProviderSetup setup={setup} onSaved={setSetup} onError={setError} />
          ) : null}

          <div className="thread">
            {renderThread.length === 0 ? (
              <EmptyThread configured={setup?.provider.configured === true} />
            ) : renderThread.map((event) => (
              <EventBlock
                key={`${event.type}-${event.seq}`}
                event={event}
                branchState={branchState}
                selectedBranchId={selectedBranchId}
                selectedSessionStatus={selected?.status ?? "idle"}
                editingSeq={editingSeq}
                editingDraft={editingDraft}
                answeredPermissionIds={answeredPermissionIds}
                onPermission={respondPermission}
                onMcpElicitation={respondMcpElicitation}
                onSelectBranch={(branchId) => void selectBranch(branchId)}
                onEditUserMessage={beginEditUserMessage}
                onEditingDraftChange={setEditingDraft}
                onCancelEdit={() => {
                  setEditingSeq(null);
                  setEditingDraft("");
                }}
                onSubmitEdit={() => void submitEditedUserMessage()}
              />
            ))}
          </div>
        </div>

        <footer className="composer">
          <div className="composer-toolbar">
            <button
              type="button"
              className={`composer-tool-button ${busy || selected?.status === "running" ? "disabled" : ""}`}
              title="Upload files for this session"
              aria-disabled={busy || selected?.status === "running"}
              disabled={busy || selected?.status === "running"}
              onClick={() => fileInputRef.current?.click()}
            >
              Attach
            </button>
            <input
              ref={fileInputRef}
              className="file-input"
              type="file"
              multiple
              disabled={busy || selected?.status === "running"}
              onChange={(event) => {
                const next = Array.from(event.currentTarget.files ?? []);
                setAttachments((current) => [...current, ...next]);
                event.currentTarget.value = "";
              }}
            />
            <button
              type="button"
              className={`danger-mode-button ${selected?.dangerouslyAllowAllTools ? "active" : ""}`}
              onClick={() => void toggleDangerousMode()}
              disabled={!selected || dangerBusy}
              title="Bypass approval prompts for this session"
            >
              {dangerBusy ? "Updating…" : selected?.dangerouslyAllowAllTools ? "Danger free: on" : "Danger free"}
            </button>
            {dangerConfirm ? (
              <span className="danger-confirm">
                <span>Bypass approvals?</span>
                <button type="button" onClick={() => void setDangerousMode(true)} disabled={dangerBusy}>Enable</button>
                <button type="button" onClick={() => setDangerConfirm(false)} disabled={dangerBusy}>Cancel</button>
              </span>
            ) : null}
            {dangerNotice ? <span className="danger-mode-notice">{dangerNotice}</span> : null}
            <span className="composer-hint">Enter sends · Shift+Enter newline</span>
          </div>
          {attachments.length > 0 ? (
            <div className="attachment-list">
              {attachments.map((file, index) => (
                <span className="attachment-chip" key={`${file.name}-${file.size}-${file.lastModified}-${index}`}>
                  <span>{file.name}</span>
                  <small>{formatBytes(file.size)}</small>
                  <button
                    type="button"
                    aria-label={`Remove ${file.name}`}
                    onClick={() => setAttachments((current) => current.filter((_, itemIndex) => itemIndex !== index))}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          ) : null}
          <textarea
            ref={draftRef}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={selected?.status === "running" ? "ForgeAgent is running…" : "Ask ForgeAgent anything…"}
            rows={1}
            disabled={selected?.status === "running"}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void submitMessage();
              }
            }}
          />
          <div className="composer-actions">
            <button
              className="send-button"
              onClick={() => void submitMessage()}
              disabled={busy || selected?.status === "running" || (!draft.trim() && attachments.length === 0)}
            >
            Send
            </button>
          </div>
        </footer>
        </>
        )}
      </section>

      <StatusRail
        activePanel={railPanel}
        setup={setup}
        diagnostics={diagnostics}
        usage={usage}
        pendingPermissions={pendingPermissions}
        deviceState={deviceState}
        onSelect={(panel) => setRailPanel((current) => current === panel ? null : panel)}
      />
      {railPanel ? (
        <StatusDrawer
          panel={railPanel}
          setup={setup}
          diagnostics={diagnostics}
          usage={usage}
          pendingPermissions={pendingPermissions}
          deviceState={deviceState}
          onSetNotificationsEnabled={setWebNotificationsEnabled}
          onRefresh={reloadStatus}
          onClose={() => setRailPanel(null)}
        />
      ) : null}
    </main>
  );
}

function ProviderSetup(props: {
  setup: SetupStatus;
  onSaved: (status: SetupStatus) => void;
  onError: (error: string) => void;
}) {
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState(props.setup.provider.baseUrl);
  const [model, setModel] = useState(props.setup.provider.model);
  const [contextWindowTokens, setContextWindowTokens] = useState(String(props.setup.provider.contextWindowTokens));
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);

  async function save(testOnly: boolean) {
    setSaving(true);
    setMessage("");
    props.onError("");
    const input = {
      ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      baseUrl: baseUrl.trim(),
      model: model.trim(),
      contextWindowTokens: Number(contextWindowTokens),
    };
    try {
      if (testOnly) {
        const result = await api.testProvider(input);
        setMessage(result.message);
      } else {
        const saved = await api.saveProvider(input);
        props.onSaved(saved);
        setApiKey("");
        setMessage("Provider saved. ForgeAgent is ready.");
      }
    } catch (err) {
      props.onError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="setup-panel">
      <h2>Connect DeepSeek</h2>
      <p>Save your API key locally on this machine. ForgeAgent never returns it through diagnostics or status APIs.</p>
      <div className="setup-grid">
        <label>
          API key
          <input type="password" value={apiKey} placeholder={props.setup.provider.apiKeyMasked ?? "sk-…"} onChange={(event) => setApiKey(event.target.value)} />
        </label>
        <label>
          Model
          <input value={model} onChange={(event) => setModel(event.target.value)} />
        </label>
        <label>
          Base URL
          <input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} />
        </label>
        <label>
          Context window
          <input inputMode="numeric" value={contextWindowTokens} onChange={(event) => setContextWindowTokens(event.target.value)} />
        </label>
      </div>
      <div className="setup-actions">
        <button onClick={() => void save(true)} disabled={saving}>Test</button>
        <button className="primary" onClick={() => void save(false)} disabled={saving}>Save provider</button>
        {message ? <span>{message}</span> : null}
      </div>
    </section>
  );
}

type ExtensionReviewInfo = {
  title: string;
  reason: string;
  location: string;
  scan: string;
  nextStep: string;
  findings: Array<{
    ruleId: string;
    severity: string;
    file: string;
    line: number;
    message: string;
    evidence: string;
  }>;
};

function metadataString(candidate: ExtensionCandidate, key: string): string {
  const value = candidate.metadata?.[key];
  return typeof value === "string" && value.trim() ? value : "";
}

function metadataScan(candidate: ExtensionCandidate): {
  verdict: string;
  scannedFiles?: number;
  findings: ExtensionReviewInfo["findings"];
} | null {
  const raw = candidate.metadata?.scanSummary;
  if (!raw || typeof raw !== "object") return null;
  const scan = raw as {
    verdict?: unknown;
    scannedFiles?: unknown;
    findings?: unknown;
  };
  const findings = Array.isArray(scan.findings)
    ? scan.findings.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const finding = item as Record<string, unknown>;
      return [{
        ruleId: typeof finding.ruleId === "string" ? finding.ruleId : "unknown-rule",
        severity: typeof finding.severity === "string" ? finding.severity : "info",
        file: typeof finding.file === "string" ? finding.file : ".",
        line: typeof finding.line === "number" ? finding.line : 1,
        message: typeof finding.message === "string" ? finding.message : "Review finding.",
        evidence: typeof finding.evidence === "string" ? finding.evidence : "",
      }];
    })
    : [];
  const result: {
    verdict: string;
    scannedFiles?: number;
    findings: ExtensionReviewInfo["findings"];
  } = {
    verdict: typeof scan.verdict === "string" ? scan.verdict : metadataString(candidate, "scanVerdict") || "unknown",
    findings,
  };
  if (typeof scan.scannedFiles === "number") result.scannedFiles = scan.scannedFiles;
  return result;
}

function reviewInfoForExtension(candidate: ExtensionCandidate): ExtensionReviewInfo | null {
  const scan = metadataScan(candidate);
  const invalidReason = metadataString(candidate, "invalidReason");
  const reviewState = candidate.setupRequired ? "setup_required" : candidate.reviewState;
  const reviewAction = candidate.setupRequired ? "setup_required" : candidate.reviewAction;
  const location = metadataString(candidate, "manifestPath")
    || metadataString(candidate, "location")
    || metadataString(candidate, "directory")
    || candidate.source
    || candidate.sourceLabel;
  const scanText = scan
    ? `${scan.verdict}${scan.scannedFiles !== undefined ? ` · ${scan.scannedFiles} files scanned` : ""}`
    : metadataString(candidate, "scanVerdict") || "Not available";

  if (reviewState === "blocked" || candidate.status === "invalid") {
    return {
      title: "Blocked until fixed",
      reason: invalidReason || candidate.riskSummary || "This extension failed validation.",
      location,
      scan: scanText,
      nextStep: "This extension cannot be enabled from the UI. Edit or remove the package, then rescan/reinstall it. Runtime permissions are not a substitute for fixing blocked scanner findings.",
      findings: scan?.findings ?? [],
    };
  }

  if (reviewState === "warning" || candidate.status === "quarantined") {
    return {
      title: "Warnings found",
      reason: invalidReason || candidate.riskSummary || "This extension has scanner warnings but no blocking findings.",
      location,
      scan: scanText,
      nextStep: reviewAction === "trust_enable"
        ? "If this is the extension you intended to use, trust and enable it here. Any scripts or tools it suggests still go through normal ForgeAgent permissions and sandbox."
        : "This extension is already enabled; runtime permissions and sandbox still apply when it uses tools.",
      findings: scan?.findings ?? [],
    };
  }

  if (candidate.setupRequired) {
    return {
      title: "Setup required before enabling",
      reason: candidate.postInstall || candidate.riskSummary || "This extension needs local configuration before it can be enabled.",
      location,
      scan: scanText === "Not available" ? "Not applicable" : scanText,
      nextStep: "Configure the required environment variables, tokens, or connection strings, then return here to enable it.",
      findings: scan?.findings ?? [],
    };
  }

  return null;
}

function reviewText(candidate: ExtensionCandidate, review: ExtensionReviewInfo): string {
  const findings = review.findings.length > 0
    ? review.findings.map((finding) => (
      `- [${finding.severity}] ${finding.ruleId} ${finding.file}:${finding.line} ${finding.message}${finding.evidence ? ` Evidence: ${finding.evidence}` : ""}`
    )).join("\n")
    : "- No scanner findings were returned.";
  return [
    `${candidate.title} (${candidate.kind})`,
    `Status: ${candidate.status}`,
    `Reason: ${review.reason}`,
    `Location: ${review.location}`,
    `Scan: ${review.scan}`,
    `Next step: ${review.nextStep}`,
    "Findings:",
    findings,
  ].join("\n");
}

function isAttentionCandidate(candidate: ExtensionCandidate): boolean {
  return candidate.setupRequired === true ||
    candidate.reviewState === "warning" ||
    candidate.reviewState === "blocked" ||
    candidate.reviewState === "setup_required" ||
    candidate.status === "quarantined" ||
    candidate.status === "invalid";
}

function ExtensionReviewPanel(props: {
  candidate: ExtensionCandidate;
  review: ExtensionReviewInfo;
  busy: boolean;
  onTrustEnable: () => void;
  onRescan: () => void;
  onOpenEvents: () => void;
  onOpenSources: () => void;
}) {
  return (
    <section className="extension-review-panel" aria-label={`Review details for ${props.candidate.title}`}>
      <div className="extension-review-head">
        <strong>{props.review.title}</strong>
        <span>{props.candidate.status}</span>
      </div>
      <dl>
        <div>
          <dt>Reason</dt>
          <dd>{props.review.reason}</dd>
        </div>
        <div>
          <dt>Review location</dt>
          <dd>
            <span>This card, plus source package:</span>
            <code>{props.review.location}</code>
          </dd>
        </div>
        <div>
          <dt>Scan</dt>
          <dd>{props.review.scan}</dd>
        </div>
        <div>
          <dt>Next step</dt>
          <dd>{props.review.nextStep}</dd>
        </div>
      </dl>
      {props.review.findings.length > 0 ? (
        <div className="extension-findings">
          <strong>Scanner findings</strong>
          <ul>
            {props.review.findings.slice(0, 5).map((finding, index) => (
              <li key={`${finding.ruleId}-${finding.file}-${finding.line}-${index}`}>
                <span>{finding.severity}</span>
                <code>{finding.ruleId}</code>
                <em>{finding.file}:{finding.line}</em>
                <p>{finding.message}{finding.evidence ? ` Evidence: ${finding.evidence}` : ""}</p>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="extension-review-actions">
        {props.candidate.reviewAction === "trust_enable" && !props.candidate.enabled ? (
          <button type="button" className="primary" onClick={props.onTrustEnable} disabled={props.busy}>
            {props.busy ? "Enabling…" : "Trust and enable"}
          </button>
        ) : null}
        <button type="button" onClick={props.onRescan} disabled={props.busy}>Rescan</button>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard?.writeText(reviewText(props.candidate, props.review));
          }}
        >
          Copy review info
        </button>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard?.writeText(props.review.location);
          }}
        >
          Copy source path
        </button>
        <button type="button" onClick={props.onOpenEvents}>Audit trail</button>
        <button type="button" onClick={props.onOpenSources}>Sources</button>
      </div>
    </section>
  );
}

function ExtensionsCenter(props: {
  status: ExtensionStatus | null;
  candidates: ExtensionCandidate[];
  loading: boolean;
  onCandidates: (items: ExtensionCandidate[]) => void;
  onReload: () => Promise<ExtensionStatus>;
  onError: (error: string) => void;
  onOpenChat: () => void;
}) {
  const [query, setQuery] = useState("");
  const [link, setLink] = useState("");
  const [includeInstalled, setIncludeInstalled] = useState(true);
  const [busyId, setBusyId] = useState("");
  const [message, setMessage] = useState("");
  const [tab, setTab] = useState<"recommended" | "all" | "installed" | "review" | "sources" | "events">("recommended");
  const [sourceName, setSourceName] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [sourceKind, setSourceKind] = useState<"http" | "github" | "file">("http");

  useEffect(() => {
    if (props.candidates.length > 0) return;
    if (busyId === "search") return;
    void api.searchExtensions({ includeInstalled: true }).then((result) => {
      props.onCandidates(result.candidates);
    }).catch((err) => {
      props.onError(err instanceof Error ? err.message : String(err));
    });
  }, [busyId, props.candidates.length, props.onCandidates, props.onError]);

  function searchOptions(): { query?: string; link?: string; includeInstalled?: boolean } {
    const options: { includeInstalled?: boolean; query?: string; link?: string } = { includeInstalled };
    const trimmedQuery = query.trim();
    const trimmedLink = link.trim();
    if (trimmedQuery) options.query = trimmedQuery;
    if (trimmedLink) options.link = trimmedLink;
    return options;
  }

  async function search() {
    setBusyId("search");
    setMessage("");
    props.onError("");
    props.onCandidates([]);
    setTab("all");
    try {
      const result = await api.searchExtensions(searchOptions());
      props.onCandidates(result.candidates);
      setMessage(result.candidates.length === 0 ? "No matching extensions found." : `Found ${result.candidates.length} extension candidate(s).`);
    } catch (err) {
      props.onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId("");
    }
  }

  async function install(candidate: ExtensionCandidate) {
    setBusyId(candidate.id);
    setMessage("");
    props.onError("");
    try {
      const result = await api.installExtension(candidate.installInput);
      setMessage(result.message);
      await props.onReload();
      const refreshed = await api.searchExtensions(searchOptions());
      props.onCandidates(refreshed.candidates);
    } catch (err) {
      props.onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId("");
    }
  }

  async function enable(candidate: ExtensionCandidate, options?: { trustWarnings?: boolean }) {
    setBusyId(candidate.id);
    setMessage("");
    props.onError("");
    try {
      const idOrName = candidate.kind === "skill"
        ? candidate.name
        : candidate.kind === "bundle"
          ? candidate.name
          : candidate.source;
      const version = metadataString(candidate, "version") || undefined;
      const result = await api.enableExtension(candidate.kind, idOrName, version, options);
      setMessage(result.message);
      await props.onReload();
      const refreshed = await api.searchExtensions(searchOptions());
      props.onCandidates(refreshed.candidates);
    } catch (err) {
      props.onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId("");
    }
  }

  async function addSource() {
    setBusyId("add-source");
    setMessage("");
    props.onError("");
    try {
      const input: { kind: "http" | "github" | "file"; name: string; url?: string; path?: string } = {
        kind: sourceKind,
        name: sourceName.trim(),
      };
      if (sourceKind === "file") input.path = sourceUrl.trim();
      else input.url = sourceUrl.trim();
      await api.addExtensionSource(input);
      const refreshed = await props.onReload();
      props.onCandidates((await api.searchExtensions(searchOptions())).candidates);
      setSourceName("");
      setSourceUrl("");
      setMessage(`Source added. ${refreshed.registry.sources.length} source(s) configured.`);
    } catch (err) {
      props.onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId("");
    }
  }

  async function refreshSource(sourceId: string) {
    setBusyId(`source:${sourceId}`);
    setMessage("");
    props.onError("");
    try {
      const source = await api.refreshExtensionSource(sourceId);
      await props.onReload();
      setMessage(source.lastError ? `Refresh failed: ${source.lastError}` : `Source refreshed: ${source.name}`);
    } catch (err) {
      props.onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId("");
    }
  }

  async function removeSource(sourceId: string) {
    setBusyId(`source:${sourceId}`);
    setMessage("");
    props.onError("");
    try {
      await api.removeExtensionSource(sourceId);
      await props.onReload();
      setMessage("Source removed.");
    } catch (err) {
      props.onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId("");
    }
  }

  const visibleCandidates = props.candidates.filter((candidate) => {
    if (tab === "recommended") return candidate.recommended === true || candidate.trust === "official" || candidate.trust === "curated";
    if (tab === "installed") return candidate.installed;
    if (tab === "review") return isAttentionCandidate(candidate);
    return tab === "all";
  });
  const attentionCount = props.candidates.filter(isAttentionCandidate).length ||
    ((props.status?.counts.quarantined ?? 0) + (props.status?.counts.invalid ?? 0));

  return (
    <div className="extensions-center">
      <header className="extensions-header">
        <div>
          <p className="eyebrow">ForgeAgent Extensions</p>
          <h1>Skills, MCP tools, and connectors</h1>
          <p>
            Install capabilities manually here, or ask ForgeAgent in chat to install a named extension or a link.
          </p>
        </div>
        <button type="button" onClick={props.onOpenChat}>Back to chat</button>
      </header>

      <section className="extension-summary-grid">
        <div><span>Installed</span><strong>{props.status?.counts.installed ?? "—"}</strong></div>
        <div><span>Enabled</span><strong>{props.status?.counts.enabled ?? "—"}</strong></div>
        <div><span>MCP tools</span><strong>{props.status?.mcp.tools.length ?? "—"}</strong></div>
        <div><span>Attention</span><strong>{attentionCount}</strong></div>
      </section>

      <section className="extension-search-panel">
        <div className="extension-search-row">
          <label>
            Search
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="filesystem mcp, github, design skill…"
              onKeyDown={(event) => {
                if (event.key === "Enter") void search();
              }}
            />
          </label>
          <label>
            Link
            <input
              value={link}
              onChange={(event) => setLink(event.target.value)}
              placeholder="https://github.com/owner/repo"
              onKeyDown={(event) => {
                if (event.key === "Enter") void search();
              }}
            />
          </label>
          <button type="button" className="primary" disabled={busyId === "search"} onClick={() => void search()}>
            {busyId === "search" ? "Searching…" : "Search"}
          </button>
        </div>
        <label className="inline-checkbox">
          <input type="checkbox" checked={includeInstalled} onChange={(event) => setIncludeInstalled(event.target.checked)} />
          Include installed
        </label>
        {message ? <p className="extension-message">{message}</p> : null}
      </section>

      <nav className="extension-tabs" aria-label="Extension views">
        {[
          ["recommended", "Recommended"],
          ["all", "All"],
          ["installed", "Installed"],
          ["review", "Attention"],
          ["sources", "Sources"],
          ["events", "Events"],
        ].map(([id, label]) => (
          <button
            type="button"
            key={id}
            className={tab === id ? "active" : ""}
            onClick={() => setTab(id as typeof tab)}
          >
            {label}
          </button>
        ))}
      </nav>

      {tab === "sources" ? (
        <section className="extension-results">
          <article className="extension-card source-editor">
            <div className="extension-card-main">
              <div className="extension-title-row">
                <strong>Add registry source</strong>
                <span className="extension-pill">local-first</span>
              </div>
              <p>Add a file, GitHub raw URL, or static HTTP registry. Remote entries are cached locally before use.</p>
              <div className="extension-source-form">
                <select value={sourceKind} onChange={(event) => setSourceKind(event.target.value as "http" | "github" | "file")}>
                  <option value="http">HTTP JSON</option>
                  <option value="github">GitHub JSON</option>
                  <option value="file">Local file</option>
                </select>
                <input value={sourceName} onChange={(event) => setSourceName(event.target.value)} placeholder="Source name" />
                <input value={sourceUrl} onChange={(event) => setSourceUrl(event.target.value)} placeholder={sourceKind === "file" ? "/path/to/registry.json" : "https://example.com/registry.json"} />
              </div>
            </div>
            <div className="extension-actions">
              <button type="button" onClick={() => void addSource()} disabled={Boolean(busyId) || !sourceName.trim() || !sourceUrl.trim()}>
                {busyId === "add-source" ? "Adding…" : "Add source"}
              </button>
            </div>
          </article>
          {(props.status?.registry.sources ?? []).map((source) => (
            <article className={`extension-card ${source.lastError ? "invalid" : "installed"}`} key={source.id}>
              <div className="extension-card-main">
                <div className="extension-title-row">
                  <strong>{source.name}</strong>
                  <span className={`extension-pill ${source.trust}`}>{source.trust}</span>
                  <span className="extension-pill">{source.kind}</span>
                </div>
                <p>{source.url ?? source.path ?? source.id}</p>
                {source.lastError ? <p className="extension-risk">{source.lastError}</p> : null}
                <div className="extension-tags">
                  <span>{source.enabled ? "enabled" : "disabled"}</span>
                  {source.lastRefreshAt ? <span>refreshed {new Date(source.lastRefreshAt).toLocaleString()}</span> : null}
                </div>
              </div>
              <div className="extension-actions">
                {source.kind !== "builtin" ? (
                  <>
                    <button type="button" onClick={() => void refreshSource(source.id)} disabled={Boolean(busyId)}>
                      {busyId === `source:${source.id}` ? "Working…" : "Refresh"}
                    </button>
                    <button type="button" onClick={() => void removeSource(source.id)} disabled={Boolean(busyId)}>
                      Remove
                    </button>
                  </>
                ) : <span className="extension-enabled">Built in</span>}
              </div>
            </article>
          ))}
        </section>
      ) : tab === "events" ? (
        <section className="extension-results">
          {(props.status?.registry.events ?? []).length === 0 ? (
            <div className="extension-empty">
              <h2>No extension events yet.</h2>
              <p>Installs, source refreshes, failures, and enables will appear here.</p>
            </div>
          ) : (props.status?.registry.events ?? []).map((event) => (
            <article className="extension-card installed" key={event.seq}>
              <div className="extension-card-main">
                <div className="extension-title-row">
                  <strong>{event.detail}</strong>
                  <span className="extension-pill">seq {event.seq}</span>
                </div>
                <p>{event.message}</p>
                <div className="extension-tags">
                  <span>{new Date(event.timestamp).toLocaleString()}</span>
                  {event.kind ? <span>{event.kind}</span> : null}
                  {event.sourceId ? <span>{event.sourceId}</span> : null}
                </div>
              </div>
            </article>
          ))}
        </section>
      ) : (
        <section className="extension-results">
        {tab === "review" ? (
          <div className="extension-attention-note">
            <strong>Attention is not an approval queue.</strong>
            <span>Warnings can be trusted and enabled here. Blocked extensions must be edited or removed because runtime permissions cannot make blocked package content safe.</span>
          </div>
        ) : null}
        {visibleCandidates.length === 0 ? (
          <div className="extension-empty">
            <h2>
              {tab === "recommended"
                ? props.loading ? "Loading ForgeAgent Library…" : "ForgeAgent Library did not load."
                : "Start with a search or paste a link."}
            </h2>
            <p>
              {props.loading
                ? "Fetching the built-in official and curated extension list from the local Core."
                : tab === "recommended"
                  ? "No built-in recommendations were returned. Check the error above or refresh the local Core."
                  : "ForgeAgent will show install inputs, trust state, and risk before anything is enabled."}
            </p>
            {tab === "recommended" ? (
              <button type="button" onClick={() => void search()} disabled={Boolean(busyId)}>
                {busyId === "search" ? "Loading…" : "Reload library"}
              </button>
            ) : null}
          </div>
        ) : visibleCandidates.map((candidate) => {
          const review = reviewInfoForExtension(candidate);
          return (
            <article className={`extension-card ${candidate.status} ${review ? "needs-review" : ""}`} key={candidate.id}>
              <div className="extension-card-main">
                <div className="extension-title-row">
                  <strong>{candidate.title}</strong>
                  <span className={`extension-pill ${candidate.trust}`}>{candidate.trust}</span>
                  <span className="extension-pill">{candidate.kind}</span>
                  {candidate.recommended ? <span className="extension-pill recommended">recommended</span> : null}
                </div>
                <p>{candidate.description}</p>
                {candidate.setupRequired ? <p className="extension-setup">Setup required: {candidate.postInstall ?? "configure required values before enabling."}</p> : null}
                <p className="extension-risk">{candidate.riskSummary}</p>
                {review ? (
                  <ExtensionReviewPanel
                    candidate={candidate}
                    review={review}
                    busy={busyId === candidate.id}
                    onTrustEnable={() => void enable(candidate, { trustWarnings: true })}
                    onRescan={() => void search()}
                    onOpenEvents={() => setTab("events")}
                    onOpenSources={() => setTab("sources")}
                  />
                ) : null}
                <div className="extension-tags">
                  <span>{candidate.sourceLabel}</span>
                  <span>{candidate.status}</span>
                  {candidate.capabilities.slice(0, 6).map((capability) => <span key={capability}>{capability}</span>)}
                </div>
              </div>
              <div className="extension-actions">
                {!candidate.installed ? (
                  <button type="button" onClick={() => void install(candidate)} disabled={Boolean(busyId)}>
                    {busyId === candidate.id ? "Installing…" : "Install"}
                  </button>
                ) : candidate.enabled ? (
                  <span className="extension-enabled">Enabled</span>
                ) : review && candidate.reviewAction === "trust_enable" ? (
                  <button type="button" onClick={() => void enable(candidate, { trustWarnings: true })} disabled={Boolean(busyId)}>
                    {busyId === candidate.id ? "Enabling…" : "Trust and enable"}
                  </button>
                ) : review ? (
                  <>
                    <span className="extension-review">
                      {candidate.reviewAction === "setup_required" ? "Setup required" : "Blocked"}
                    </span>
                    {tab !== "review" ? <button type="button" onClick={() => setTab("review")}>Attention</button> : null}
                  </>
                ) : (
                  <button type="button" onClick={() => void enable(candidate)} disabled={Boolean(busyId)}>
                    {busyId === candidate.id ? "Enabling…" : "Enable"}
                  </button>
                )}
              </div>
            </article>
          );
        })}
        </section>
      )}
    </div>
  );
}

function EmptyThread({ configured }: { configured: boolean }) {
  return (
    <div className="empty-thread">
      <h2>{configured ? "Start with a task, not setup." : "Configure the model first."}</h2>
      <p>
        {configured
          ? "ForgeAgent will keep the durable thread here: tool calls, permission approvals, browser events, artifacts, usage, and final answers."
          : "Once DeepSeek is configured, the composer becomes the only place you need to focus."}
      </p>
    </div>
  );
}

function variantGroupForEvent(
  event: Extract<SessionEvent, { type: "user_message" }>,
  branchState: SessionBranchState | null,
) {
  const sourceSeq = event.variantOfSeq ?? event.seq;
  const group = branchState?.variantGroups.find((item) => item.sourceSeq === sourceSeq);
  if (!group || group.variants.length <= 1) return null;
  const index = group.variants.findIndex((variant) => variant.userMessageSeq === event.seq);
  return {
    group,
    index: index >= 0 ? index : 0,
  };
}

function EventBlock(props: {
  event: RenderEvent;
  branchState: SessionBranchState | null;
  selectedBranchId: string;
  selectedSessionStatus: Session["status"];
  editingSeq: number | null;
  editingDraft: string;
  answeredPermissionIds: Set<string>;
  onPermission: (id: string, decision: "allow_once" | "allow_session" | "deny") => Promise<void>;
  onMcpElicitation: (id: string, accept: boolean) => Promise<void>;
  onSelectBranch: (branchId: string) => void;
  onEditUserMessage: (event: Extract<SessionEvent, { type: "user_message" }>) => void;
  onEditingDraftChange: (value: string) => void;
  onCancelEdit: () => void;
  onSubmitEdit: () => void;
}) {
  const { event } = props;
  async function openArtifact(artifactId: string) {
    try {
      const payload = await api.artifact(artifactId);
      const content = payload.encoding === "base64"
        ? atob(payload.content)
        : payload.content;
      const blob = new Blob([content], { type: payload.info.mimeType || "text/plain" });
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank", "noopener,noreferrer");
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch {
      window.alert("Could not open artifact.");
    }
  }
  if (event.type === "user_message") {
    const variant = variantGroupForEvent(event, props.branchState);
    const isEditing = props.editingSeq === event.seq;
    const canEdit = props.selectedSessionStatus !== "running";
    return (
      <article className="message user">
        <div className="message-meta-row">
          <Meta label="You" time={event.timestamp} />
          <div className="message-actions">
            {variant ? (
              <div className="variant-switcher" aria-label="Message variants">
                <button
                  type="button"
                  disabled={variant.index <= 0}
                  onClick={() => {
                    const next = variant.group.variants[variant.index - 1];
                    if (next) props.onSelectBranch(next.branchId);
                  }}
                  title="Previous variant"
                >
                  ‹
                </button>
                <span>{variant.index + 1}/{variant.group.variants.length}</span>
                <button
                  type="button"
                  disabled={variant.index >= variant.group.variants.length - 1}
                  onClick={() => {
                    const next = variant.group.variants[variant.index + 1];
                    if (next) props.onSelectBranch(next.branchId);
                  }}
                  title="Next variant"
                >
                  ›
                </button>
              </div>
            ) : null}
            <button
              type="button"
              className="text-action"
              disabled={!canEdit}
              onClick={() => props.onEditUserMessage(event)}
            >
              Edit
            </button>
          </div>
        </div>
        {isEditing ? (
          <div className="inline-editor">
            <textarea
              value={props.editingDraft}
              onChange={(change) => props.onEditingDraftChange(change.target.value)}
              onKeyDown={(keyEvent) => {
                if (keyEvent.key === "Enter" && !keyEvent.shiftKey) {
                  keyEvent.preventDefault();
                  props.onSubmitEdit();
                }
              }}
              rows={Math.min(10, Math.max(3, props.editingDraft.split("\n").length))}
              autoFocus
            />
            <div className="inline-editor-actions">
              <button type="button" onClick={props.onCancelEdit}>Cancel</button>
              <button
                type="button"
                className="primary"
                disabled={!props.editingDraft.trim()}
                onClick={props.onSubmitEdit}
              >
                Send edited branch
              </button>
            </div>
          </div>
        ) : (
          <RichText text={event.text} className="user-rich-text" />
        )}
      </article>
    );
  }
  if (event.type === "assistant_message") {
    return <article className="message assistant"><Meta label="ForgeAgent" time={event.timestamp} /><AssistantContent text={event.text} /></article>;
  }
  if (event.type === "assistant_stream") {
    return (
      <article className="message assistant streaming">
        <Meta label="ForgeAgent" time={event.timestamp} />
        <AssistantContent text={event.text} streaming />
      </article>
    );
  }
  if (event.type === "tool_call") {
    return (
      <article className="tool-row">
        <span className="tool-name">{event.toolName}</span>
        <span>{JSON.stringify(event.args)}</span>
        <time>{formatTime(event.timestamp)}</time>
      </article>
    );
  }
  if (event.type === "tool_result") {
    const htmlPath = event.toolName === "write_file" && !event.isError
      ? htmlFilePathFromToolResult(event.result)
      : null;
    return (
      <article className={`tool-result ${event.isError ? "error" : ""}`}>
        <Meta label={`Tool result · ${event.toolName}`} time={event.timestamp} />
        <Text text={stringifyResult(event.result)} />
        {htmlPath ? <HtmlPreviewCard path={htmlPath} sessionId={event.sessionId} /> : null}
      </article>
    );
  }
  if (event.type === "permission_request") {
    const answered = props.answeredPermissionIds.has(event.permissionRequestId);
    return (
      <article className="permission-card">
        <Meta label="Permission request" time={event.timestamp} />
        <p>{event.message}</p>
        <dl>
          <dt>Tool</dt><dd>{event.toolName}</dd>
          <dt>Action</dt><dd>{event.action}</dd>
          <dt>Reason</dt><dd>{event.reason}</dd>
        </dl>
        {!answered ? (
          <div className="permission-actions">
            <button onClick={() => void props.onPermission(event.permissionRequestId, "allow_once")}>Allow once</button>
            <button onClick={() => void props.onPermission(event.permissionRequestId, "allow_session")}>Allow for this session</button>
            <button onClick={() => void props.onPermission(event.permissionRequestId, "deny")}>Deny</button>
          </div>
        ) : <span className="muted">Answered</span>}
      </article>
    );
  }
  if (event.type === "permission_response") {
    return <article className="note-line">{event.message}</article>;
  }
  if (event.type === "mcp_elicitation_request") {
    return (
      <article className="permission-card">
        <Meta label={`MCP request · ${event.serverName}`} time={event.timestamp} />
        <p>{event.message}</p>
        {event.requestedSchema ? <pre>{JSON.stringify(event.requestedSchema, null, 2)}</pre> : null}
        <div className="permission-actions">
          <button onClick={() => void props.onMcpElicitation(event.elicitationId, true)}>Respond</button>
          <button onClick={() => void props.onMcpElicitation(event.elicitationId, false)}>Decline</button>
        </div>
      </article>
    );
  }
  if (event.type === "mcp_elicitation_response") {
    return <article className="note-line">{event.message}</article>;
  }
  if (event.type === "runtime_event") {
    return <article className="note-line">{event.runtimeKind}: {event.message}</article>;
  }
  if (event.type === "branch_event") {
    return <article className="note-line">Branch: {event.message}</article>;
  }
  if (event.type === "artifact_pointer") {
    return (
      <article className="artifact-card">
        <span className="artifact-icon">□</span>
        <div>
          <strong>{event.artifactId}</strong>
          <p>{event.mimeType} · {compactNumber(event.sizeBytes)} bytes</p>
        </div>
        <button onClick={() => void openArtifact(event.artifactId)}>Open</button>
      </article>
    );
  }
  if (event.type === "usage_event") {
    return <article className="note-line">{event.message}</article>;
  }
  if (event.type === "context_usage_event") {
    return <article className="note-line">{event.message}</article>;
  }
  if (event.type === "skill_used") {
    return <article className="note-line">Skill used: {event.skillName}</article>;
  }
  if (event.type === "compaction_block") {
    return <article className="note-line">History compacted: events {event.coversEvents[0]}–{event.coversEvents[1]}</article>;
  }
  return <article className="note-line">{event.type}</article>;
}

function Meta({ label, time }: { label: string; time: string }) {
  return (
    <div className="meta">
      <strong>{label}</strong>
      <time>{formatTime(time)}</time>
    </div>
  );
}

function Text({ text }: { text: string }) {
  return <p className="text-block">{text}</p>;
}

function stringifyResult(result: unknown): string {
  if (typeof result === "string") return result;
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}

function htmlFilePathFromToolResult(result: unknown): string | null {
  if (typeof result !== "string") return null;
  const match = /^File (?:created|updated): (.+\.html?)$/im.exec(result.trim());
  return match?.[1] ?? null;
}

function HtmlPreviewCard({ path, sessionId }: { path: string; sessionId?: string | undefined }) {
  const [preview, setPreview] = useState<{ content: string; sizeBytes: number; truncated: boolean } | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    setPreview(null);
    api.htmlPreview(path, sessionId)
      .then((payload) => {
        if (cancelled) return;
        setPreview({
          content: payload.content,
          sizeBytes: payload.sizeBytes,
          truncated: payload.truncated,
        });
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [path, sessionId]);

  async function loadPreview() {
    setLoading(true);
    setError("");
    try {
      const payload = await api.htmlPreview(path, sessionId);
      setPreview({
        content: payload.content,
        sizeBytes: payload.sizeBytes,
        truncated: payload.truncated,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  async function openPreview() {
    try {
      const payload = preview ?? await api.htmlPreview(path, sessionId);
      openHtmlPreviewDocument(payload.content, `Preview ${path.split("/").pop() ?? "HTML"}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <section className="html-preview-card">
      <div className="html-preview-head">
        <div>
          <strong>HTML preview</strong>
          <p>{path}</p>
        </div>
        <div className="html-preview-actions">
          <button onClick={() => void loadPreview()} disabled={loading}>
            {preview ? "Refresh" : loading ? "Loading…" : "Preview"}
          </button>
          <button onClick={() => void openPreview()}>Open tab</button>
          <button onClick={() => void navigator.clipboard?.writeText(path)}>Copy path</button>
        </div>
      </div>
      {error ? <p className="html-preview-error">{error}</p> : null}
      {preview ? (
        <>
          <iframe
            className="html-preview-frame"
            title={`Preview ${path}`}
            sandbox="allow-scripts"
            srcDoc={preview.content}
          />
          <p className="html-preview-meta">
            {compactNumber(preview.sizeBytes)} bytes{preview.truncated ? " · preview truncated" : ""}
          </p>
        </>
      ) : null}
    </section>
  );
}

function SessionStateIndicator({ session }: { session: Pick<Session, "status" | "unread"> | null }) {
  const indicator = sessionIndicator(session);
  if (indicator === "spinner") return <span className="session-spinner" aria-label="running" />;
  return <span className={`session-indicator ${indicator}`} aria-hidden="true" />;
}

function StatusRail(props: {
  activePanel: RailPanel | null;
  setup: SetupStatus | null;
  diagnostics: Diagnostics | null;
  usage: SessionUsageSummary | null;
  pendingPermissions: PermissionRequest[];
  deviceState: DeviceState | null;
  onSelect: (panel: RailPanel) => void;
}) {
  const contextPercent = props.usage?.contextUsedPercent;
  const notificationsEnabled = props.deviceState?.notificationSettings.enabled === true;
  return (
    <aside className="status-rail" aria-label="Status rail">
      <RailButton
        panel="provider"
        label="DeepSeek"
        active={props.activePanel === "provider"}
        tone={props.setup?.provider.configured ? "ok" : "warn"}
        onSelect={props.onSelect}
      />
      <RailButton
        panel="android"
        label="Pair Android"
        active={props.activePanel === "android"}
        tone="neutral"
        onSelect={props.onSelect}
      />
      <RailButton
        panel="browser"
        label="Chrome"
        active={props.activePanel === "browser"}
        tone={props.diagnostics?.webridge.state === "online" ? "ok" : "warn"}
        ring
        onSelect={props.onSelect}
      />
      <RailButton
        panel="mcp"
        label={`MCP · ${props.diagnostics?.mcp.tools ?? 0} tools`}
        active={props.activePanel === "mcp"}
        tone={
          props.diagnostics?.mcp.state === "connected" || props.diagnostics?.mcp.state === "idle"
            ? "ok"
            : "warn"
        }
        badge={(props.diagnostics?.mcp.degraded ?? 0) + (props.diagnostics?.mcp.needsAuth ?? 0)}
        onSelect={props.onSelect}
      />
      <RailButton
        panel="context"
        label={contextPercent !== undefined ? `Context ${contextPercent.toFixed(0)}%` : "Context"}
        active={props.activePanel === "context"}
        percent={contextPercent}
        onSelect={props.onSelect}
      />
      <RailButton
        panel="permissions"
        label={`${props.pendingPermissions.length} permission requests`}
        active={props.activePanel === "permissions"}
        badge={props.pendingPermissions.length}
        tone={props.pendingPermissions.length > 0 ? "warn" : "neutral"}
        onSelect={props.onSelect}
      />
      <RailButton
        panel="notifications"
        label={notificationsEnabled ? "Notifications on" : "Notifications off"}
        active={props.activePanel === "notifications"}
        tone={notificationsEnabled ? "ok" : "neutral"}
        onSelect={props.onSelect}
      />
      <RailButton
        panel="memory"
        label="Memory"
        active={props.activePanel === "memory"}
        tone={props.diagnostics?.memory.state === "degraded" ? "warn" : "ok"}
        onSelect={props.onSelect}
      />
      <RailButton
        panel="skills"
        label="Skills"
        active={props.activePanel === "skills"}
        tone="ok"
        onSelect={props.onSelect}
      />
    </aside>
  );
}

function RailButton(props: {
  panel: RailPanel;
  label: string;
  active: boolean;
  tone?: "ok" | "warn" | "neutral";
  badge?: number;
  ring?: boolean;
  percent?: number | undefined;
  onSelect: (panel: RailPanel) => void;
}) {
  const percent = Math.max(0, Math.min(100, props.percent ?? 0));
  const style = props.percent !== undefined
    ? { "--rail-percent": `${percent * 3.6}deg` } as CSSProperties
    : undefined;
  return (
    <button
      type="button"
      className={`rail-button ${props.active ? "active" : ""} ${props.ring ? "ring" : ""} tone-${props.tone ?? "neutral"} ${props.percent !== undefined ? "progress" : ""}`}
      aria-label={props.label}
      title={props.label}
      onClick={() => props.onSelect(props.panel)}
      style={style}
    >
      <span className="rail-glyph" />
      {props.badge && props.badge > 0 ? <span className="rail-badge">{props.badge}</span> : null}
    </button>
  );
}

function StatusDrawer(props: {
  panel: RailPanel;
  setup: SetupStatus | null;
  diagnostics: Diagnostics | null;
  usage: SessionUsageSummary | null;
  pendingPermissions: PermissionRequest[];
  deviceState: DeviceState | null;
  onSetNotificationsEnabled: (enabled: boolean) => Promise<void>;
  onRefresh: () => Promise<void>;
  onClose: () => void;
}) {
  const contextPercent = props.usage?.contextUsedPercent;
  const cache = props.usage?.cacheHitRateNow ?? props.usage?.cacheHitRateAverage;
  async function runMcpAction(action: () => Promise<unknown>) {
    try {
      const result = await action();
      if (result && typeof result === "object") {
        const url = "authorizationUrl" in result && typeof (result as { authorizationUrl?: unknown }).authorizationUrl === "string"
          ? (result as { authorizationUrl: string }).authorizationUrl
          : "url" in result && typeof (result as { url?: unknown }).url === "string"
            ? (result as { url: string }).url
            : "";
        if (url) window.open(url, "_blank", "noopener,noreferrer");
      }
      await props.onRefresh();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : String(err));
    }
  }
  return (
    <aside className="status-drawer">
      <div className="drawer-header">
        <strong>{drawerTitle(props.panel)}</strong>
        <button className="icon-button" onClick={props.onClose} aria-label="Close status details">×</button>
      </div>
      {props.panel === "provider" ? (
        <DrawerRows rows={[
          ["Provider", "DeepSeek"],
          ["State", props.setup?.provider.configured ? "configured" : "not configured"],
          ["Model", props.setup?.provider.model ?? "—"],
          ["Context", props.setup ? compactNumber(props.setup.provider.contextWindowTokens) : "—"],
        ]} />
      ) : null}
      {props.panel === "browser" ? (
        <DrawerRows rows={[
          ["Webridge", props.diagnostics?.webridge.state ?? "unknown"],
          ["Enabled", props.diagnostics?.webridge.enabled === false ? "no" : "yes"],
          ["Message", props.diagnostics?.webridge.message ?? "—"],
        ]} />
      ) : null}
      {props.panel === "android" ? <PairAndroidPanel /> : null}
      {props.panel === "mcp" ? (
        <div className="drawer-list">
          <DrawerRows rows={[
            ["State", props.diagnostics?.mcp.state ?? "unknown"],
            ["Enabled", String(props.diagnostics?.mcp.enabled ?? 0)],
            ["Connected", String(props.diagnostics?.mcp.connected ?? 0)],
            ["Tools", String(props.diagnostics?.mcp.tools ?? 0)],
          ]} />
          {(props.diagnostics?.mcp.servers ?? []).length > 0 ? (
            props.diagnostics!.mcp.servers.map((server) => (
              <div className="drawer-card" key={server.id}>
                <strong>{server.name}</strong>
                <span>{server.transport} · {server.state} · {server.tools} tools</span>
                {server.lastError ? <p>{server.lastError}</p> : null}
                <div className="permission-actions">
                  {server.enabled ? (
                    <button onClick={() => void runMcpAction(() => api.disableMcpServer(server.id))}>Disable</button>
                  ) : (
                    <button onClick={() => void runMcpAction(() => api.enableMcpServer(server.id))}>Enable</button>
                  )}
                  <button onClick={() => void runMcpAction(() => api.retryMcpServer(server.id))}>Retry</button>
                  {server.state === "needs_auth" || server.authUrl ? (
                    <button onClick={() => void runMcpAction(() => api.startMcpAuth(server.id))}>Auth</button>
                  ) : null}
                </div>
              </div>
            ))
          ) : <p className="drawer-empty">No MCP servers configured.</p>}
        </div>
      ) : null}
      {props.panel === "context" ? (
        <DrawerRows rows={[
          ["Context used", contextPercent !== undefined ? `${contextPercent.toFixed(1)}%` : "—"],
          ["Source", props.usage ? (props.usage.currentContextSource === "local_estimate" ? "local estimate" : "provider usage") : "—"],
          ["Input", compactNumber(props.usage?.inputTokens)],
          ["Output", compactNumber(props.usage?.outputTokens)],
          ["Cache", cache !== undefined ? `${cache.toFixed(1)}%` : "—"],
          ["Cost", props.usage?.cost !== undefined ? `${props.usage.cost.toFixed(6)} ${props.usage.currency ?? ""}`.trim() : "—"],
        ]} />
      ) : null}
      {props.panel === "permissions" ? (
        props.pendingPermissions.length > 0 ? (
          <div className="drawer-list">
            {props.pendingPermissions.map((item) => (
              <div className="drawer-card" key={item.id}>
                <strong>{item.toolName}</strong>
                <span>{item.action}</span>
                <p>{item.reason}</p>
              </div>
            ))}
          </div>
        ) : <p className="drawer-empty">No pending permission requests.</p>
      ) : null}
      {props.panel === "notifications" ? (
        <div className="drawer-list">
          <DrawerRows rows={[
            ["Browser support", "Notification" in window ? "available" : "unavailable"],
            ["Permission", "Notification" in window ? Notification.permission : "unsupported"],
            ["State", props.deviceState?.notificationSettings.enabled ? "enabled" : "disabled"],
            ["Last notified", String(props.deviceState?.notificationSettings.lastNotifiedSeq ?? 0)],
          ]} />
          <div className="permission-actions">
            {props.deviceState?.notificationSettings.enabled ? (
              <button onClick={() => void props.onSetNotificationsEnabled(false)}>Disable notifications</button>
            ) : (
              <button onClick={() => void props.onSetNotificationsEnabled(true)}>Enable desktop notifications</button>
            )}
          </div>
          <p className="drawer-empty">
            Notifications are per device. Current visible replies at the bottom of the thread stay quiet.
          </p>
        </div>
      ) : null}
      {props.panel === "memory" ? (
        <DrawerRows rows={[
          ["State", props.diagnostics?.memory.state ?? "unknown"],
          ["Queued", String(props.diagnostics?.memory.queuedExtractions ?? 0)],
          ["Proposals", String(props.diagnostics?.memory.pendingProposals ?? 0)],
          ["Device", props.deviceState?.deviceId.slice(0, 8) ?? "—"],
        ]} />
      ) : null}
      {props.panel === "skills" ? (
        <DrawerRows rows={[
          ["Active", String(props.diagnostics?.skills.status.active ?? 0)],
          ["Generated", String(props.diagnostics?.skills.status.generated ?? 0)],
          ["Invalid", String(props.diagnostics?.skills.status.invalid ?? 0)],
          ["Quarantined", String(props.diagnostics?.skills.status.quarantined ?? 0)],
        ]} />
      ) : null}
    </aside>
  );
}

function DrawerRows({ rows }: { rows: Array<[string, string]> }) {
  return (
    <dl className="drawer-rows">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function PairAndroidPanel() {
  const [baseUrl, setBaseUrl] = useState("");
  const [pairingUrl, setPairingUrl] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [qrDataUrl, setQrDataUrl] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const createPairingLink = useCallback(async (preferredBaseUrl?: string) => {
    setLoading(true);
    setError("");
    try {
      const urls = await api.networkUrls();
      const selectedBaseUrl = preferredBaseUrl || urls.preferredUrl || urls.localUrl;
      setBaseUrl(selectedBaseUrl);
      const issued = await api.createPairingCode(selectedBaseUrl);
      setPairingUrl(issued.pairingUrl);
      setExpiresAt(issued.expiresAt);
      setQrDataUrl(await QRCode.toDataURL(issued.pairingUrl, {
        errorCorrectionLevel: "M",
        margin: 1,
        width: 208,
        color: {
          dark: "#37352f",
          light: "#ffffff",
        },
      }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void createPairingLink();
  }, [createPairingLink]);

  return (
    <div className="pair-android-panel">
      <p className="drawer-empty">
        Scan from the Android app, or open this link on your phone. The pairing code expires in 5 minutes.
      </p>
      {qrDataUrl ? <img className="pair-qr" src={qrDataUrl} alt="Android pairing QR code" /> : null}
      {pairingUrl ? (
        <>
          <label className="pair-field">
            Gateway URL
            <input
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              onBlur={() => void createPairingLink(baseUrl.trim())}
            />
          </label>
          <label className="pair-field">
            Pairing link
            <textarea readOnly value={pairingUrl} rows={4} />
          </label>
          <div className="permission-actions">
            <button onClick={() => void navigator.clipboard?.writeText(pairingUrl)}>Copy link</button>
            <button onClick={() => void createPairingLink(baseUrl.trim())}>Refresh</button>
          </div>
          <p className="pair-expiry">Expires {expiresAt ? new Date(expiresAt).toLocaleTimeString() : "soon"}</p>
        </>
      ) : null}
      {loading ? <p className="drawer-empty">Creating pairing code…</p> : null}
      {error ? <p className="html-preview-error">{error}</p> : null}
    </div>
  );
}

function drawerTitle(panel: RailPanel): string {
  switch (panel) {
    case "provider": return "Provider";
    case "android": return "Pair Android";
    case "browser": return "Chrome";
    case "mcp": return "MCP";
    case "context": return "Context";
    case "permissions": return "Permissions";
    case "notifications": return "Notifications";
    case "memory": return "Memory";
    case "skills": return "Skills";
    default: return "Status";
  }
}
