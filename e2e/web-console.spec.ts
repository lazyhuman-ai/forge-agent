import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const tokenKey = "forgeagent.web.token";

async function ensureToken(page: Page): Promise<string> {
  await page.goto("/");
  await expect(page.locator(".app-shell")).toBeVisible();
  const token = await page.evaluate((key) => window.localStorage.getItem(key), tokenKey);
  if (!token) throw new Error("Web console did not auto-pair a device token");
  return token;
}

async function createSession(request: APIRequestContext, token: string, title: string): Promise<void> {
  const response = await request.post("/sessions", {
    headers: { Authorization: `Bearer ${token}` },
    data: { title },
  });
  expect(response.ok()).toBeTruthy();
}

async function createSessionReturningId(request: APIRequestContext, token: string, title: string): Promise<string> {
  const response = await request.post("/sessions", {
    headers: { Authorization: `Bearer ${token}` },
    data: { title },
  });
  expect(response.ok()).toBeTruthy();
  const data = await response.json() as { id: string };
  return data.id;
}

async function layoutMetrics(page: Page) {
  return page.evaluate(() => {
    function box(selector: string) {
      const element = document.querySelector(selector);
      if (!element) throw new Error(`Missing ${selector}`);
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        left: Math.round(rect.left),
        right: Math.round(rect.right),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        bottom: Math.round(rect.bottom),
        scrollHeight: element.scrollHeight,
        overflowY: style.overflowY,
      };
    }

    return {
      viewportHeight: window.innerHeight,
      bodyScrollHeight: document.body.scrollHeight,
      shell: box(".app-shell"),
      sidebar: box(".sidebar"),
      sessionList: box(".session-list"),
      reader: box(".reader"),
      sessionStrip: box(".session-strip"),
      thread: box(".thread-scroll"),
      composer: box(".composer"),
      textarea: box(".composer textarea"),
      rail: box(".status-rail"),
      drawer: document.querySelector(".status-drawer") ? box(".status-drawer") : null,
    };
  });
}

async function extensionLayoutMetrics(page: Page) {
  return page.evaluate(() => {
    function box(selector: string) {
      const element = document.querySelector(selector);
      if (!element) throw new Error(`Missing ${selector}`);
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        top: Math.round(rect.top),
        bottom: Math.round(rect.bottom),
        left: Math.round(rect.left),
        right: Math.round(rect.right),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight,
        overflowY: style.overflowY,
      };
    }

    const firstCard = document.querySelector(".extension-card");
    if (!firstCard) throw new Error("Missing first extension card");
    const firstCardRect = firstCard.getBoundingClientRect();
    const clippedControls = Array.from(
      document.querySelectorAll(".extensions-center button, .extensions-center .extension-pill, .extensions-center .extension-tags span"),
    )
      .filter((element) => element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1)
      .map((element) => ({
        className: String((element as HTMLElement).className),
        text: (element.textContent ?? "").trim(),
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
        scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight,
      }));

    return {
      viewportHeight: window.innerHeight,
      bodyScrollHeight: document.body.scrollHeight,
      center: box(".extensions-center"),
      tabs: box(".extension-tabs"),
      results: box(".extension-results"),
      firstCard: {
        top: Math.round(firstCardRect.top),
        bottom: Math.round(firstCardRect.bottom),
        height: Math.round(firstCardRect.height),
      },
      clippedControls,
    };
  });
}

test.describe("ForgeAgent Web Console", () => {
  test("keeps the shell fixed and scrolls session/thread regions internally", async ({ page, request }, testInfo) => {
    const token = await ensureToken(page);
    const prefix = `E2E ${testInfo.project.name} scroll ${Date.now()}`;
    for (let i = 0; i < 30; i += 1) {
      await createSession(request, token, `${prefix} ${i + 1}`);
    }

    await page.reload();
    await expect(page.locator(".session-title", { hasText: `${prefix} 30` })).toBeVisible();
    await expect(page.locator(".status-rail")).toBeVisible();
    await expect(page.locator(".status-drawer")).toHaveCount(0);
    await page.getByRole("button", { name: /Context/ }).click();
    await expect(page.locator(".status-drawer")).toBeVisible();
    await page.getByRole("button", { name: /Close status details/ }).click();
    await expect(page.locator(".status-drawer")).toHaveCount(0);

    await page.getByRole("button", { name: /Collapse session sidebar/ }).click();
    await expect(page.locator(".app-shell")).toHaveClass(/sidebar-collapsed/);
    await page.getByRole("button", { name: /Expand session sidebar/ }).click();
    await expect(page.locator(".app-shell")).not.toHaveClass(/sidebar-collapsed/);

    const metrics = await layoutMetrics(page);
    expect(metrics.bodyScrollHeight).toBeLessThanOrEqual(metrics.viewportHeight + 1);
    expect(metrics.shell.height).toBe(metrics.viewportHeight);
    expect(metrics.sidebar.overflowY).toBe("hidden");
    expect(metrics.sessionList.overflowY).toBe("auto");
    expect(metrics.sessionList.scrollHeight).toBeGreaterThan(metrics.sessionList.height);
    expect(metrics.reader.overflowY).toBe("hidden");
    expect(metrics.sessionStrip.height).toBeLessThanOrEqual(60);
    expect(metrics.thread.overflowY).toBe("auto");
    expect(metrics.composer.bottom).toBeLessThanOrEqual(metrics.viewportHeight);
    expect(metrics.rail.height).toBe(metrics.viewportHeight);
  });

  test("deletes one session and all idle/blocked sessions from the UI", async ({ page, request }) => {
    const token = await ensureToken(page);
    const single = `E2E delete single ${Date.now()}`;
    const batchPrefix = `E2E delete batch ${Date.now()}`;
    await createSession(request, token, single);
    for (let i = 0; i < 3; i += 1) {
      await createSession(request, token, `${batchPrefix} ${i + 1}`);
    }

    await page.reload();
    await expect(page.getByText(single)).toBeVisible();

    await page.getByLabel(`Delete ${single}`).click();
    await expect(page.getByText(single)).toHaveCount(0);

    await page.getByRole("button", { name: /Clear idle\/blocked/ }).click();
    await expect(page.getByText(batchPrefix)).toHaveCount(0);
  });

  test("creating a session does not show stale HTML fallback API errors", async ({ page }) => {
    await ensureToken(page);
    await page.getByRole("button", { name: "+ New Session" }).click();
    await expect(page.getByText("ForgeAgent API returned non-JSON content")).toHaveCount(0);
    await expect(page.getByText("<!doctype html")).toHaveCount(0);
    await expect(page.locator(".inline-error")).toHaveCount(0);
  });

  test("grows composer up to 60 percent of the viewport then scrolls internally", async ({ page }) => {
    await ensureToken(page);
    const textarea = page.locator(".composer textarea");
    const longInput = Array.from(
      { length: 90 },
      (_, i) => `Line ${i + 1}: composer growth should stop at sixty percent of the viewport.`,
    ).join("\n");

    await textarea.fill(longInput);

    const metrics = await layoutMetrics(page);
    expect(metrics.bodyScrollHeight).toBeLessThanOrEqual(metrics.viewportHeight + 1);
    expect(metrics.textarea.height).toBeLessThanOrEqual(Math.ceil(metrics.viewportHeight * 0.6) + 2);
    expect(metrics.textarea.scrollHeight).toBeGreaterThan(metrics.textarea.height);
    expect(metrics.textarea.overflowY).toBe("auto");
    expect(metrics.thread.overflowY).toBe("auto");
    expect(metrics.composer.bottom).toBeLessThanOrEqual(metrics.viewportHeight);
  });

  test("supports attachments, danger mode, and enter-to-send composer behavior", async ({ page, request }) => {
    const token = await ensureToken(page);
    const title = `E2E composer ${Date.now()}`;
    const sessionId = await createSessionReturningId(request, token, title);
    await page.reload();
    await page.locator(".session-row", { hasText: title }).locator(".session-select").click();

    await page.getByRole("button", { name: "Danger free" }).click();
    await expect(page.locator(".danger-confirm", { hasText: "Bypass approvals?" })).toBeVisible();
    await page.locator(".danger-confirm").getByRole("button", { name: "Enable" }).click();
    await expect(page.getByRole("button", { name: "Danger free: on" })).toBeVisible();

    const fileChooserPromise = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Attach" }).click();
    const chooser = await fileChooserPromise;
    await chooser.setFiles({
      name: "upload-note.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("hello from playwright"),
    });
    await expect(page.locator(".attachment-chip", { hasText: "upload-note.txt" })).toBeVisible();

    const textarea = page.locator(".composer textarea");
    await textarea.fill("first line");
    await textarea.press("Shift+Enter");
    await textarea.type("second line");
    await expect(textarea).toHaveValue("first line\nsecond line");

    let sentText = "";
    await page.route(`**/sessions/${sessionId}/messages`, async (route) => {
      const body = route.request().postDataJSON() as { text: string };
      sentText = body.text;
      await route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({
          id: sessionId,
          title,
          status: "running",
          muted: false,
          dangerouslyAllowAllTools: true,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
      });
    });

    await textarea.press("Enter");
    await expect.poll(() => sentText).toContain("first line\nsecond line");
    expect(sentText).toContain("Uploaded files available to ForgeAgent:");
    expect(sentText).toContain("upload-note.txt");
  });

  test("renders assistant HTML in a sandboxed inline preview", async ({ page, request }) => {
    const token = await ensureToken(page);
    const title = `E2E html preview ${Date.now()}`;
    const sessionId = await createSessionReturningId(request, token, title);
    const timestamp = new Date().toISOString();
    const html = [
      "<!doctype html>",
      "<html><body><main><h1>Inline HTML Works</h1></main></body></html>",
    ].join("\n");

    await page.route(`**/sessions/${sessionId}/branches`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ activeBranchId: "main", branches: [], variantGroups: [] }),
      });
    });
    await page.route(`**/sessions/${sessionId}/thread?**`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          { type: "user_message", seq: 1, timestamp, sessionId, text: "render html" },
          { type: "assistant_message", seq: 2, timestamp, sessionId, text: `Here is the preview:\n${html}` },
        ]),
      });
    });

    await page.reload();
    await page.locator(".session-row", { hasText: title }).locator(".session-select").click();
    await expect(page.locator(".inline-html-preview")).toBeVisible();
    const frame = page.frameLocator(".inline-html-preview-frame");
    await expect(frame.locator("h1")).toHaveText("Inline HTML Works");

    const popupPromise = page.waitForEvent("popup");
    await page.locator(".inline-html-preview").getByRole("button", { name: "Open tab" }).click();
    const popup = await popupPromise;
    await expect(popup).toHaveURL(/\/html-preview\?id=/);
    expect(popup.url()).not.toContain("blob:");
    await expect(popup.frameLocator(".standalone-html-preview-frame").locator("h1")).toHaveText("Inline HTML Works");
    await popup.close();
  });

  test("auto-renders write_file HTML previews using the source session workspace", async ({ page, request }) => {
    const token = await ensureToken(page);
    const title = `E2E saved html preview ${Date.now()}`;
    const sessionId = await createSessionReturningId(request, token, title);
    const timestamp = new Date().toISOString();
    const htmlPath = "/tmp/forgeagent-e2e-chat-preview.html";
    let previewSessionId = "";

    await page.route(`**/sessions/${sessionId}/branches`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ activeBranchId: "main", branches: [], variantGroups: [] }),
      });
    });
    await page.route(`**/sessions/${sessionId}/thread?**`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          { type: "user_message", seq: 1, timestamp, sessionId, text: "save html" },
          {
            type: "tool_result",
            seq: 2,
            timestamp,
            sessionId,
            toolName: "write_file",
            result: `File created: ${htmlPath}`,
            isError: false,
            toolUseId: "call_html",
          },
        ]),
      });
    });
    await page.route("**/files/preview**", async (route) => {
      const url = new URL(route.request().url());
      previewSessionId = url.searchParams.get("sessionId") ?? "";
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          path: htmlPath,
          content: "<!doctype html><html><body><h1>Saved HTML Works</h1></body></html>",
          sizeBytes: 68,
          truncated: false,
        }),
      });
    });

    await page.reload();
    await page.locator(".session-row", { hasText: title }).locator(".session-select").click();
    await expect(page.locator(".html-preview-card")).toBeVisible();
    await expect.poll(() => previewSessionId).toBe(sessionId);
    const frame = page.frameLocator(".html-preview-frame");
    await expect(frame.locator("h1")).toHaveText("Saved HTML Works");

    const popupPromise = page.waitForEvent("popup");
    await page.locator(".html-preview-card").getByRole("button", { name: "Open tab" }).click();
    const popup = await popupPromise;
    await expect(popup).toHaveURL(/\/html-preview\?id=/);
    expect(popup.url()).not.toContain("blob:");
    await expect(popup.frameLocator(".standalone-html-preview-frame").locator("h1")).toHaveText("Saved HTML Works");
    await popup.close();
  });

  test("mobile layout hides the session sidebar without reserving page width", async ({ page, request }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await page.evaluate(() => window.localStorage.setItem("forgeagent.web.leftCollapsed", "0"));
    const token = await ensureToken(page);
    const sessionId = await createSessionReturningId(request, token, `E2E mobile ${Date.now()}`);
    const stateResponse = await request.patch("/device-state", {
      headers: { Authorization: `Bearer ${token}` },
      data: { selectedSessionId: sessionId },
    });
    expect(stateResponse.ok()).toBeTruthy();
    await page.reload();

    await expect(page.locator(".app-shell")).toHaveClass(/sidebar-collapsed/);
    let metrics = await layoutMetrics(page);
    expect(metrics.sidebar.width).toBeLessThanOrEqual(56);
    expect(metrics.reader.left).toBe(0);
    expect(metrics.bodyScrollHeight).toBeLessThanOrEqual(metrics.viewportHeight + 1);

    await page.getByRole("button", { name: /Expand session sidebar/ }).click();
    await expect(page.locator(".app-shell")).not.toHaveClass(/sidebar-collapsed/);
    await expect(page.locator(".mobile-sidebar-backdrop")).toBeVisible();
    metrics = await layoutMetrics(page);
    expect(metrics.sidebar.width).toBeGreaterThanOrEqual(280);
    expect(metrics.reader.left).toBe(0);
    expect(metrics.bodyScrollHeight).toBeLessThanOrEqual(metrics.viewportHeight + 1);

    await page.getByRole("button", { name: "Close session sidebar" }).click();
    await expect(page.locator(".app-shell")).toHaveClass(/sidebar-collapsed/);
    await expect(page.locator(".mobile-sidebar-backdrop")).toHaveCount(0);
    await page.getByRole("button", { name: "Danger free" }).click();
    await expect(page.locator(".danger-confirm", { hasText: "Bypass approvals?" })).toBeVisible();
  });

  test("generates an Android pairing QR and deep link from the status rail", async ({ page }) => {
    await ensureToken(page);
    await page.getByRole("button", { name: "Pair Android" }).click();
    await expect(page.locator(".status-drawer")).toBeVisible();
    await expect(page.locator(".pair-qr")).toBeVisible();
    const pairingLink = page.locator(".pair-field textarea");
    await expect(pairingLink).toHaveValue(/forgeagent:\/\/pair\?baseUrl=/);
  });

  test("opens the extension manager and discovers built-in MCP catalog entries", async ({ page }) => {
    await ensureToken(page);
    await page.getByRole("button", { name: "Extensions" }).click();
    await expect(page.locator(".extensions-center")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Skills, MCP tools, and connectors" })).toBeVisible();
    await expect(page.locator(".extension-card", { hasText: "Filesystem MCP" }).first()).toBeVisible();

    const metrics = await extensionLayoutMetrics(page);
    expect(metrics.bodyScrollHeight).toBeLessThanOrEqual(metrics.viewportHeight + 1);
    expect(metrics.tabs.height).toBeGreaterThanOrEqual(40);
    expect(metrics.results.top).toBeGreaterThanOrEqual(metrics.tabs.bottom);
    expect(metrics.firstCard.top).toBeGreaterThanOrEqual(metrics.results.top);
    expect(metrics.results.overflowY).toBe("auto");
    expect(metrics.results.scrollHeight).toBeGreaterThan(metrics.results.clientHeight);
    expect(metrics.clippedControls).toEqual([]);

    await page.locator(".extension-search-panel input").first().fill("filesystem");
    await page.locator(".extension-search-panel button.primary").click();

    const card = page.locator(".extension-card", { hasText: "Filesystem" }).first();
    await expect(card).toBeVisible();
    await expect(card).toContainText("MCP");
    await expect(card.locator("button, .extension-enabled, .extension-review").first()).toBeVisible();
  });

  test("shows attention details and lets warning skills be trusted and enabled", async ({ page }) => {
    await ensureToken(page);
    let enableCalled = false;
    await page.route("**/extensions**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/extensions/enable" && route.request().method() === "POST") {
        const body = route.request().postDataJSON() as Record<string, unknown>;
        expect(body).toMatchObject({ kind: "skill", idOrName: "graphify", trustWarnings: true });
        enableCalled = true;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            kind: "skill",
            id: "skill:graphify",
            name: "graphify",
            status: "active",
            message: "Skill trusted and enabled with scanner warnings: graphify 1.0.0",
          }),
        });
        return;
      }
      if (url.pathname === "/extensions/search") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            candidates: [
              {
                id: "skill:graphify",
                kind: "skill",
                name: "graphify",
                title: "graphify",
                description: "any input (code, docs, papers, images) -> knowledge graph -> clustered communities -> HTML + JSON + audit report",
                source: "local",
                sourceLabel: "User .agents skills",
                trust: "local",
                installed: true,
                enabled: false,
                status: "disabled",
                capabilities: ["fs.read", "fs.write"],
                riskSummary: "Static scan found warnings. You can trust and enable this skill; runtime tool permissions and sandbox still apply.",
                reviewState: "warning",
                reviewAction: "trust_enable",
                installInput: { kind: "skill", name: "graphify", sourceId: "local" },
                metadata: {
                  manifestPath: "/Users/example/.agents/skills/graphify/SKILL.md",
                  scanVerdict: "caution",
                  scanSummary: {
                    verdict: "caution",
                    reviewState: "warning",
                    reviewAction: "trust_enable",
                    scannedFiles: 3,
                    totalBytes: 2048,
                    findings: [{
                      ruleId: "credential-path",
                      severity: "warn",
                      file: "SKILL.md",
                      line: 12,
                      message: "Mentions sensitive credential paths. Runtime tools still require permission before reading sensitive files.",
                      evidence: ".env",
                    }],
                  },
                },
              },
              {
                id: "skill:blocked",
                kind: "skill",
                name: "blocked",
                title: "blocked",
                description: "blocked helper",
                source: "local",
                sourceLabel: "User .agents skills",
                trust: "local",
                installed: true,
                enabled: false,
                status: "invalid",
                capabilities: ["fs.read"],
                riskSummary: "Attempts to override higher-priority instructions.",
                reviewState: "blocked",
                reviewAction: "fix_required",
                installInput: { kind: "skill", name: "blocked", sourceId: "local" },
                metadata: {
                  invalidReason: "Dangerous skill findings cannot be enabled.",
                  manifestPath: "/Users/example/.agents/skills/blocked/SKILL.md",
                  scanVerdict: "dangerous",
                  scanSummary: {
                    verdict: "dangerous",
                    reviewState: "blocked",
                    reviewAction: "fix_required",
                    scannedFiles: 1,
                    totalBytes: 256,
                    findings: [{
                      ruleId: "prompt-injection-ignore",
                      severity: "critical",
                      file: "SKILL.md",
                      line: 2,
                      message: "Attempts to override higher-priority instructions.",
                      evidence: "Ignore previous instructions.",
                    }],
                  },
                },
              },
            ],
          }),
        });
        return;
      }
      if (url.pathname === "/extensions") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            skills: { status: { active: 0, invalid: 1, quarantined: 0 }, sources: [], entries: [] },
            mcp: { servers: [], tools: [], catalog: [] },
            counts: { installed: 1, enabled: 0, quarantined: 0, invalid: 1 },
            registry: { sources: [], entries: [], locks: [], events: [], diagnostics: [] },
          }),
        });
        return;
      }
      await route.fallback();
    });

    await page.getByRole("button", { name: "Extensions" }).click();
    await page.getByRole("button", { name: "Attention" }).click();

    const card = page.locator(".extension-card", { hasText: "graphify" });
    await expect(card).toBeVisible();
    await expect(card).toContainText("Warnings found");
    await expect(card).toContainText("runtime tool permissions and sandbox still apply");
    await expect(card).toContainText("/Users/example/.agents/skills/graphify/SKILL.md");
    await expect(card).toContainText("Scanner findings");
    await expect(card).toContainText("credential-path");
    await expect(card).toContainText("Mentions sensitive credential paths.");
    await expect(card.getByRole("button", { name: "Trust and enable" }).first()).toBeVisible();
    await expect(card.getByRole("button", { name: "Copy review info" })).toBeVisible();
    await expect(card.getByRole("button", { name: "Copy source path" })).toBeVisible();
    await expect(card.getByRole("button", { name: "Audit trail" })).toBeVisible();
    await expect(card.getByRole("button", { name: "Sources" })).toBeVisible();
    await card.getByRole("button", { name: "Trust and enable" }).first().click();
    await expect.poll(() => enableCalled).toBe(true);

    const blocked = page.locator(".extension-card", { hasText: "blocked helper" });
    await expect(blocked).toContainText("Blocked until fixed");
    await expect(blocked).toContainText("Attempts to override higher-priority instructions.");
    await expect(blocked.getByRole("button", { name: "Trust and enable" })).toHaveCount(0);
  });
});
