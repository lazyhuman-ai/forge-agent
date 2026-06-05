const DEFAULT_BASE_URL = "http://127.0.0.1:3000";

const els = {
  baseUrl: document.getElementById("baseUrl"),
  pairCode: document.getElementById("pairCode"),
  deviceName: document.getElementById("deviceName"),
  enabled: document.getElementById("enabled"),
  pair: document.getElementById("pair"),
  save: document.getElementById("save"),
  forget: document.getElementById("forget"),
  refresh: document.getElementById("refresh"),
  diagnostics: document.getElementById("diagnostics"),
  statusDot: document.getElementById("statusDot"),
  statusTitle: document.getElementById("statusTitle"),
  statusMessage: document.getElementById("statusMessage"),
  versionPill: document.getElementById("versionPill"),
  rawStatus: document.getElementById("rawStatus"),
};

void load();

els.refresh.addEventListener("click", () => {
  void refreshConnection();
});

els.save.addEventListener("click", () => {
  void saveSettings();
});

els.pair.addEventListener("click", () => {
  void pairWithCode(els.pairCode.value.trim());
});

els.forget.addEventListener("click", () => {
  void chrome.storage.local.remove(["token", "clientId"]).then(() => renderStatus("Disconnected from ForgeAgent."));
});

els.diagnostics.addEventListener("click", () => {
  void copyDiagnostics();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.status || changes.token || changes.clientId || changes.baseUrl || changes.enabled)) {
    void renderStatus();
  }
});

async function load() {
  const cfg = await chrome.storage.local.get([
    "baseUrl",
    "enabled",
    "token",
    "clientId",
    "deviceName",
  ]);
  els.baseUrl.value = cfg.baseUrl || DEFAULT_BASE_URL;
  els.enabled.checked = cfg.enabled !== false;
  els.deviceName.value = cfg.deviceName || "ForgeWebridge Chrome";
  await renderStatus();
}

async function refreshConnection() {
  await saveSettings({ silent: true });
  await renderStatus("Refreshing connection...");
  setBusy(true);
  try {
    const response = await chrome.runtime.sendMessage({ type: "forgewebridge.refresh" });
    if (!response?.ok) {
      throw new Error(response?.error || "ForgeWebridge background refresh failed.");
    }
    await renderStatus("Connection refreshed.");
  } catch (err) {
    await renderStatus(`Refresh failed: ${errorMessage(err)}`);
  } finally {
    setBusy(false);
  }
}

async function saveSettings(options = {}) {
  await chrome.storage.local.set({
    baseUrl: normalizedBaseUrl(),
    enabled: els.enabled.checked,
    deviceName: els.deviceName.value.trim() || "ForgeWebridge Chrome",
    autoDiscover: true,
  });
  if (!options.silent) await renderStatus("Settings saved.");
}

async function pairWithCode(code) {
  await saveSettings({ silent: true });
  if (!code) {
    await renderStatus("Enter a manual pairing code first.");
    return;
  }

  try {
    const response = await fetch(`${normalizedBaseUrl()}/auth/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code,
        name: els.deviceName.value.trim() || "ForgeWebridge Chrome",
        kind: "web",
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data?.error || `${response.status} ${response.statusText}`);
    }
    await chrome.storage.local.set({
      token: data.token,
      clientId: "",
      enabled: true,
    });
    els.pairCode.value = "";
    await renderStatus("Paired. ForgeWebridge will connect automatically.");
  } catch (err) {
    await renderStatus(`Pairing failed: ${errorMessage(err)}`);
  }
}

async function copyDiagnostics() {
  setBusy(true);
  try {
    const response = await chrome.runtime.sendMessage({ type: "forgewebridge.diagnostics" });
    if (!response?.ok) {
      throw new Error(response?.error || "ForgeWebridge diagnostics failed.");
    }
    const text = JSON.stringify(response.result, null, 2);
    await navigator.clipboard.writeText(text);
    await renderStatus("Diagnostics copied.");
  } catch (err) {
    await renderStatus(`Diagnostics failed: ${errorMessage(err)}`);
  } finally {
    setBusy(false);
  }
}

async function renderStatus(prefix = "") {
  const cfg = await chrome.storage.local.get([
    "status",
    "token",
    "clientId",
    "enabled",
    "baseUrl",
  ]);
  const status = cfg.status || {};
  const state = cfg.enabled === false
    ? "disabled"
    : cfg.token && status.state === "connected"
      ? "connected"
      : status.state || (cfg.token ? "pairing" : "waiting");

  els.statusDot.className = `dot ${stateClass(state)}`;
  els.statusTitle.textContent = titleForState(state, !!cfg.token);
  els.statusMessage.textContent = [
    prefix,
    messageForState(state, status.message, !!cfg.token),
  ].filter(Boolean).join(" ");
  els.versionPill.textContent = `ForgeWebridge ${chrome.runtime.getManifest().version}`;

  const lines = [];
  lines.push(`Enabled: ${cfg.enabled !== false ? "yes" : "no"}`);
  lines.push(`Paired: ${cfg.token ? "yes" : "no"}`);
  lines.push(`Gateway: ${cfg.baseUrl || DEFAULT_BASE_URL}`);
  if (cfg.clientId) lines.push(`Client: ${cfg.clientId}`);
  if (status.state) lines.push(`State: ${status.state}`);
  if (status.message) lines.push(`Message: ${status.message}`);
  if (status.updatedAt) lines.push(`Updated: ${status.updatedAt}`);
  els.rawStatus.textContent = lines.join("\n");
}

function stateClass(state) {
  if (state === "connected") return "connected";
  if (state === "error") return "error";
  return "waiting";
}

function titleForState(state, hasToken) {
  if (state === "connected") return "Chrome is connected";
  if (state === "disabled") return "Bridge is disabled";
  if (state === "error") return "Connection needs attention";
  if (hasToken) return "Connecting to ForgeAgent";
  return "Waiting for ForgeAgent";
}

function messageForState(state, message, hasToken) {
  if (message) return message;
  if (state === "connected") return "ForgeAgent can now use browser tools in this Chrome profile.";
  if (state === "disabled") return "Enable the bridge or refresh the connection when you want ForgeAgent to use Chrome.";
  if (hasToken) return "ForgeWebridge is pairing with the local gateway.";
  return "Start ForgeAgent, then click Refresh connection.";
}

function normalizedBaseUrl() {
  return (els.baseUrl.value.trim() || DEFAULT_BASE_URL).replace(/\/$/, "");
}

function errorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}

function setBusy(value) {
  for (const button of [els.refresh, els.pair, els.save, els.forget, els.diagnostics]) {
    button.disabled = value;
  }
}
