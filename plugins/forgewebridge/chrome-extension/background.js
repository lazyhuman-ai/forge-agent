const EXTENSION_NAME = "ForgeWebridge";
const EXTENSION_VERSION = "0.5.3";
const DEFAULT_BASE_URL = "http://127.0.0.1:3000";
const DISCOVERY_URLS = [
  "http://127.0.0.1:3000",
  "http://localhost:3000",
];
const POLL_TIMEOUT_MS = 25000;
const HEARTBEAT_INTERVAL_MS = 15000;
const IDLE_DELAY_MS = 500;
const ERROR_DELAY_MS = 3000;
const DISCOVERY_TIMEOUT_MS = 2000;
const DISCOVERY_REFRESH_MS = 30000;

let polling = false;
let lastHeartbeatAt = 0;
let lastDiscoveryAt = 0;
let lastDiscoveredBaseUrl = "";

chrome.runtime.onInstalled.addListener(() => {
  ensurePollAlarm();
  void ensureDefaults();
  void startPolling();
});

chrome.runtime.onStartup.addListener(() => {
  ensurePollAlarm();
  void startPolling();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "forgewebridge-poll") void startPolling();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.enabled || changes.baseUrl || changes.token)) {
    void startPolling();
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "forgewebridge.refresh") {
    void refreshConnection()
      .then((result) => sendResponse({ ok: true, result }))
      .catch((err) => sendResponse({ ok: false, error: errorMessage(err) }));
    return true;
  }
  if (message?.type === "forgewebridge.diagnostics") {
    void diagnostics()
      .then((result) => sendResponse({ ok: true, result }))
      .catch((err) => sendResponse({ ok: false, error: errorMessage(err) }));
    return true;
  }
  return false;
});

ensurePollAlarm();
void ensureDefaults().then(startPolling);

function ensurePollAlarm() {
  chrome.alarms.create("forgewebridge-poll", { periodInMinutes: 0.5 });
}

async function ensureDefaults() {
  const current = await chrome.storage.local.get(["baseUrl", "enabled", "autoDiscover"]);
  const patch = {};
  if (!current.baseUrl) patch.baseUrl = DEFAULT_BASE_URL;
  if (current.enabled === undefined) patch.enabled = true;
  if (current.autoDiscover === undefined) patch.autoDiscover = true;
  if (Object.keys(patch).length > 0) await chrome.storage.local.set(patch);
}

async function getConfig() {
  const cfg = await chrome.storage.local.get(["baseUrl", "token", "clientId", "enabled", "autoDiscover"]);
  return {
    baseUrl: String(cfg.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, ""),
    token: typeof cfg.token === "string" ? cfg.token : "",
    clientId: typeof cfg.clientId === "string" ? cfg.clientId : "",
    enabled: cfg.enabled !== false,
    autoDiscover: cfg.autoDiscover !== false,
  };
}

async function startPolling() {
  if (polling) return;
  polling = true;
  try {
    while (true) {
      const cfg = await getConfig();
      if (!cfg.enabled) {
        await setStatus("idle", "ForgeWebridge is disabled.");
        return;
      }

      if (!cfg.token) {
        await setStatus("pairing", "Looking for ForgeAgent on this Mac.");
        try {
          const discovered = await ensureDiscoveredBaseUrl(cfg, { force: true });
          await autoPair(discovered);
          await setStatus("paired", "Connected to ForgeAgent. Browser tools are ready.");
        } catch (err) {
          await setStatus("idle", `Waiting for ForgeAgent. ${errorMessage(err)}`);
          await sleep(ERROR_DELAY_MS);
        }
        continue;
      }

      {
        const latest = await getConfig();
        if (!latest.token) {
          await sleep(ERROR_DELAY_MS);
          continue;
        }
      }

      const authedCfg = await getConfig();
      if (!authedCfg.token) {
        return;
      }

      try {
        const discovered = await ensureDiscoveredBaseUrl(authedCfg);
        const clientId = await ensureRegistered(discovered);
        await heartbeat({ ...discovered, clientId }, "polling");
        await setStatus("connected", `Connected to ForgeAgent as ${clientId}.`);
        const command = await pollCommand({ ...discovered, clientId });
        if (command) {
          await executeAndSubmit({ ...discovered, clientId }, command);
          await heartbeat({ ...discovered, clientId }, "idle");
        } else {
          await sleep(IDLE_DELAY_MS);
        }
      } catch (err) {
        if (isAuthError(err)) {
          await chrome.storage.local.remove(["token", "clientId"]);
          await setStatus("pairing", "Stored ForgeAgent device token is no longer valid; auto-pairing will retry.");
          await sleep(IDLE_DELAY_MS);
          continue;
        }
        if (isUnknownClientError(err)) {
          await chrome.storage.local.set({ clientId: "" });
        }
        await setStatus("error", errorMessage(err));
        await sleep(ERROR_DELAY_MS);
      }
    }
  } finally {
    polling = false;
  }
}

async function refreshConnection() {
  await ensureDefaults();
  const cfg = await getConfig();
  if (!cfg.enabled) {
    await chrome.storage.local.set({ enabled: true });
  }
  const latest = await getConfig();
  const discovered = await ensureDiscoveredBaseUrl(latest, { force: true });
  if (!discovered.token) {
    await autoPair(discovered);
  }
  void startPolling();
  return diagnostics();
}

async function diagnostics() {
  const cfg = await getConfig();
  const stored = await chrome.storage.local.get(["status", "deviceName"]);
  const safeConfig = {
    baseUrl: cfg.baseUrl,
    enabled: cfg.enabled,
    autoDiscover: cfg.autoDiscover,
    paired: Boolean(cfg.token),
    clientId: cfg.clientId || "",
    deviceName: typeof stored.deviceName === "string" ? stored.deviceName : "",
  };
  const result = {
    extension: {
      name: EXTENSION_NAME,
      version: EXTENSION_VERSION,
    },
    config: safeConfig,
    status: stored.status || null,
    checkedAt: new Date().toISOString(),
  };

  try {
    result.discovery = await fetchJson(`${cfg.baseUrl}/discovery`, { timeoutMs: DISCOVERY_TIMEOUT_MS });
  } catch (err) {
    result.discoveryError = errorMessage(err);
  }

  if (cfg.token) {
    try {
      const response = await gatewayFetch(cfg, "/webridge/status", { method: "GET" });
      result.webridge = await response.json();
    } catch (err) {
      result.webridgeError = errorMessage(err);
    }
  }

  return result;
}

async function ensureDiscoveredBaseUrl(cfg, options = {}) {
  if (!cfg.autoDiscover) return cfg;
  if (!options.force && lastDiscoveredBaseUrl && Date.now() - lastDiscoveryAt < DISCOVERY_REFRESH_MS) {
    return { ...cfg, baseUrl: lastDiscoveredBaseUrl };
  }
  const discovered = await discoverForgeAgent(cfg.baseUrl);
  lastDiscoveryAt = Date.now();
  lastDiscoveredBaseUrl = discovered.baseUrl;
  if (discovered.baseUrl !== cfg.baseUrl) {
    await chrome.storage.local.set({ baseUrl: discovered.baseUrl });
  }
  if (!discovered.forgeWebridge) {
    throw new Error("ForgeAgent is running, but ForgeWebridge runtime is not enabled.");
  }
  return { ...cfg, baseUrl: discovered.baseUrl };
}

async function discoverForgeAgent(preferredBaseUrl) {
  const candidates = unique([
    preferredBaseUrl,
    DEFAULT_BASE_URL,
    ...DISCOVERY_URLS,
  ].filter(Boolean).map((url) => String(url).replace(/\/$/, "")));

  const errors = [];
  for (const baseUrl of candidates) {
    try {
      const data = await fetchJson(`${baseUrl}/discovery`, { timeoutMs: DISCOVERY_TIMEOUT_MS });
      if (data?.app === "ForgeAgent") {
        return {
          baseUrl,
          forgeWebridge: data?.capabilities?.forgeWebridge === true || data?.webridge?.enabled === true,
        };
      }
      errors.push(`${baseUrl}: not ForgeAgent`);
    } catch (err) {
      errors.push(`${baseUrl}: ${errorMessage(err)}`);
    }
  }
  throw new Error(`Could not find local ForgeAgent gateway. Tried ${candidates.join(", ")}.`);
}

async function autoPair(cfg) {
  const deviceName = await getDeviceName();
  const codeResponse = await fetch(`${cfg.baseUrl}/auth/pairing-codes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      baseUrl: cfg.baseUrl,
      ttlMs: 300_000,
    }),
  });
  const codeData = await codeResponse.json().catch(() => ({}));
  if (!codeResponse.ok || !codeData.code) {
    throw new Error(`Auto-pair code request failed: ${codeData?.error || `${codeResponse.status} ${codeResponse.statusText}`}`);
  }

  const pairResponse = await fetch(`${cfg.baseUrl}/auth/pair`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      code: codeData.code,
      name: deviceName,
      kind: "web",
    }),
  });
  const pairData = await pairResponse.json().catch(() => ({}));
  if (!pairResponse.ok || !pairData.token) {
    throw new Error(`Auto-pair token request failed: ${pairData?.error || `${pairResponse.status} ${pairResponse.statusText}`}`);
  }
  await chrome.storage.local.set({
    token: pairData.token,
    clientId: "",
    enabled: true,
  });
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || DISCOVERY_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: options.method || "GET",
      headers: options.headers,
      body: options.body,
      signal: controller.signal,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}${data?.error ? `: ${data.error}` : ""}`);
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function ensureRegistered(cfg) {
  if (cfg.clientId) return cfg.clientId;
  const response = await gatewayFetch(cfg, "/webridge/register", {
    method: "POST",
    body: JSON.stringify({
      name: EXTENSION_NAME,
      version: EXTENSION_VERSION,
    }),
  });
  const data = await response.json();
  if (!data.clientId) throw new Error("ForgeAgent did not return a Webridge clientId.");
  await chrome.storage.local.set({ clientId: data.clientId });
  return data.clientId;
}

async function heartbeat(cfg, state) {
  const now = Date.now();
  if (now - lastHeartbeatAt < HEARTBEAT_INTERVAL_MS) return;
  lastHeartbeatAt = now;
  await gatewayFetch(cfg, "/webridge/heartbeat", {
    method: "POST",
    body: JSON.stringify({
      clientId: cfg.clientId,
      name: EXTENSION_NAME,
      version: EXTENSION_VERSION,
      state,
    }),
  });
}

async function pollCommand(cfg) {
  const response = await gatewayFetch(
    cfg,
    `/webridge/commands?clientId=${encodeURIComponent(cfg.clientId)}&timeoutMs=${POLL_TIMEOUT_MS}`,
    { method: "GET" },
  );
  const data = await response.json();
  return data.command || null;
}

async function executeAndSubmit(cfg, command) {
  try {
    const output = await executeCommand(command);
    await gatewayFetch(cfg, "/webridge/results", {
      method: "POST",
      body: JSON.stringify({
        clientId: cfg.clientId,
        commandId: command.id,
        ok: true,
        output,
      }),
    });
  } catch (err) {
    await gatewayFetch(cfg, "/webridge/results", {
      method: "POST",
      body: JSON.stringify({
        clientId: cfg.clientId,
        commandId: command.id,
        ok: false,
        error: errorMessage(err),
      }),
    });
  }
}

async function gatewayFetch(cfg, path, init) {
  const response = await fetch(`${cfg.baseUrl}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.token}`,
      ...(init?.headers || {}),
    },
  });
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const data = await response.json();
      if (data?.error) message = `${message}: ${data.error}`;
    } catch {
      // Keep status text
    }
    throw new Error(`ForgeAgent gateway request failed: ${message}`);
  }
  return response;
}

async function executeCommand(command) {
  switch (command.kind) {
    case "create_tab": {
      const tab = await chrome.tabs.create({ url: "about:blank", active: true });
      if (tab.id === undefined) throw new Error("Chrome did not return a tab id.");
      return { tabId: String(tab.id) };
    }
    case "close_tab": {
      await chrome.tabs.remove(requireTabId(command));
      return { closed: true };
    }
    case "navigate": {
      const url = requireString(command.payload?.url, "url");
      assertHttpUrl(url);
      const tabId = requireTabId(command);
      await chrome.tabs.update(tabId, { url, active: true });
      await waitForTabComplete(tabId, 30000);
      return { url };
    }
    case "current_page":
      return await runInTab(requireTabId(command), pageInfoScript);
    case "wait_for_selector":
      return await waitForSelector(
        requireTabId(command),
        requireString(command.payload?.selector, "selector"),
        numberOr(command.payload?.timeoutMs, 10000),
      );
    case "type_text":
      return await runInTab(
        requireTabId(command),
        typeTextScript,
        [
          requireString(command.payload?.selector, "selector"),
          requireString(command.payload?.text, "text"),
        ],
      );
    case "press_key":
      return await runInTab(requireTabId(command), pressKeyScript, [
        requireString(command.payload?.key, "key"),
      ]);
    case "click":
      return await runInTab(requireTabId(command), clickScript, [
        requireString(command.payload?.selector, "selector"),
      ]);
    case "scroll":
      return await runInTab(requireTabId(command), scrollScript, [
        numberOr(command.payload?.deltaY, 800),
        command.payload?.toBottom === true,
      ]);
    case "extract":
      return await runInTab(requireTabId(command), extractScript, [
        typeof command.payload?.selector === "string" ? command.payload.selector : null,
      ]);
    case "extract_links":
      return await runInTab(requireTabId(command), extractLinksScript, [
        typeof command.payload?.selector === "string" ? command.payload.selector : "a[href]",
      ]);
    case "screenshot": {
      const tabId = requireTabId(command);
      await chrome.tabs.update(tabId, { active: true });
      await sleep(250);
      const tab = await chrome.tabs.get(tabId);
      if (tab.windowId === undefined) throw new Error("Chrome did not return a window id for screenshot capture.");
      let dataUrl = "";
      try {
        dataUrl = await captureVisibleTabPng(tab.windowId, 5000);
      } catch (err) {
        return await runInTab(tabId, fallbackScreenshotScript, [errorMessage(err)]);
      }
      return dataUrl.replace(/^data:image\/png;base64,/, "");
    }
    default:
      throw new Error(`Unsupported ForgeWebridge command: ${command.kind}`);
  }
}

function captureVisibleTabPng(windowId, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("Chrome did not complete captureVisibleTab before the ForgeWebridge screenshot timeout."));
    }, timeoutMs);
    chrome.tabs.captureVisibleTab(windowId, { format: "png" }, (dataUrl) => {
      clearTimeout(timer);
      const lastError = chrome.runtime.lastError;
      if (lastError) {
        reject(new Error(`Chrome captureVisibleTab failed: ${lastError.message}`));
        return;
      }
      if (typeof dataUrl !== "string" || dataUrl.length === 0) {
        reject(new Error("Chrome captureVisibleTab returned an empty screenshot."));
        return;
      }
      resolve(dataUrl);
    });
  });
}

function fallbackScreenshotScript(reason) {
  const escape = (value) => String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  const text = (document.body?.innerText || document.body?.textContent || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1400);
  const lines = [
    `ForgeWebridge DOM screenshot fallback`,
    `Reason: ${reason}`,
    `Title: ${document.title || ""}`,
    `URL: ${location.href}`,
    "",
    text,
  ].join("\n").match(/.{1,96}/g) || [];
  const height = Math.max(240, 92 + lines.length * 24);
  const body = lines.map((line, index) => (
    `<text x="28" y="${56 + index * 24}" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="15" fill="#37352f">${escape(line)}</text>`
  )).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="${height}" viewBox="0 0 1200 ${height}">
    <rect width="1200" height="${height}" fill="#fbfbfa"/>
    <rect x="18" y="18" width="1164" height="${height - 36}" fill="#fff" stroke="#d8d4cd"/>
    ${body}
  </svg>`;
  return btoa(unescape(encodeURIComponent(svg)));
}

async function runInTab(tabId, func, args = []) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func,
    args,
  });
  return result?.result;
}

async function waitForSelector(tabId, selector, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await runInTab(tabId, selectorExistsScript, [selector]);
    if (found) return true;
    await sleep(200);
  }
  return false;
}

function pageInfoScript() {
  return {
    title: document.title || "",
    url: location.href,
    textPreview: (document.body?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 2000),
  };
}

function selectorExistsScript(selector) {
  return document.querySelector(selector) !== null;
}

function typeTextScript(selector, text) {
  const el = document.querySelector(selector);
  if (!el) throw new Error(`Element not found: ${selector}`);
  el.focus();
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    const proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(el, text);
    else el.value = text;
  } else if (el.isContentEditable) {
    el.textContent = text;
  } else {
    throw new Error(`Element is not editable: ${selector}`);
  }
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return { typed: true };
}

function pressKeyScript(key) {
  const el = document.activeElement;
  if (!el) throw new Error("No focused element for key press.");
  for (const type of ["keydown", "keyup"]) {
    el.dispatchEvent(new KeyboardEvent(type, {
      bubbles: true,
      cancelable: true,
      key,
      code: key,
    }));
  }
  return { pressed: key };
}

function clickScript(selector) {
  const el = document.querySelector(selector);
  if (!el) throw new Error(`Element not found: ${selector}`);
  el.click();
  return { clicked: true };
}

function scrollScript(deltaY, toBottom) {
  if (toBottom) window.scrollTo(0, document.body.scrollHeight);
  else window.scrollBy(0, deltaY);
  return { scrollY: window.scrollY };
}

function extractScript(selector) {
  const target = selector ? document.querySelector(selector) : document.body;
  if (!target) return "";
  return target.innerText || target.textContent || "";
}

function extractLinksScript(selector) {
  return Array.from(document.querySelectorAll(selector)).map((a) => ({
    href: a.href || "",
    text: (a.textContent || "").trim(),
  }));
}

function requireTabId(command) {
  const parsed = Number(command.tabId);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("ForgeWebridge command is missing a valid tabId. Recovery: call browser_create_tab first.");
  }
  return parsed;
}

function requireString(value, name) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Missing required string payload field: ${name}`);
  }
  return value;
}

function numberOr(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function assertHttpUrl(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Only http(s) navigation is allowed by ForgeWebridge. Received: ${url}`);
  }
}

function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error("Navigation timed out before the tab reached complete state."));
    }, timeoutMs);
    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId !== tabId || changeInfo.status !== "complete") return;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}

function isUnknownClientError(err) {
  return errorMessage(err).includes("Unknown ForgeWebridge client");
}

function isAuthError(err) {
  const message = errorMessage(err);
  return message.includes("ForgeAgent gateway request failed: 401")
    || message.includes("ForgeAgent gateway request failed: 403");
}

function unique(items) {
  return Array.from(new Set(items));
}

async function getDeviceName() {
  const cfg = await chrome.storage.local.get(["deviceName"]);
  return typeof cfg.deviceName === "string" && cfg.deviceName.trim()
    ? cfg.deviceName.trim()
    : "ForgeWebridge Chrome";
}

async function setStatus(state, message) {
  await chrome.storage.local.set({
    status: {
      state,
      message,
      updatedAt: new Date().toISOString(),
    },
  });
  await updateBadge(state);
}

async function updateBadge(state) {
  if (!chrome.action?.setBadgeText) return;
  if (state === "connected" || state === "paired") {
    await chrome.action.setBadgeText({ text: "" });
    return;
  }
  const text = state === "error" ? "!" : "...";
  const color = state === "error" ? "#cf3e3e" : "#d99a25";
  await chrome.action.setBadgeBackgroundColor({ color });
  await chrome.action.setBadgeText({ text });
}
