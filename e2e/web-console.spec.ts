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

    page.once("dialog", (dialog) => dialog.accept());
    await page.getByLabel(`Delete ${single}`).click();
    await expect(page.getByText(single)).toHaveCount(0);

    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: /Clear idle\/blocked/ }).click();
    await expect(page.getByText(batchPrefix)).toHaveCount(0);
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
    await page.locator(".composer-tool-button", { hasText: "Attach" }).click();
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
});
