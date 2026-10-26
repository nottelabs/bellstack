import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import Notte from "../server/notte";
import { BrowserSession } from "../server/browser/browser-session";
import { issueBrowserHandoffToken, resolveBrowserHandoffLiveViewUrl } from "../server/browser/handoff";
import type { ConversationState } from "../server/browser/types";
import { createAgentContext } from "../server/browser/agent-contexts";
import run from "../agent/tools/run";
import snapshot from "../agent/tools/snapshot";
import screenshot from "../agent/tools/screenshot";
import lifecycle from "../agent/hooks/browser-lifecycle";
import { browserChannelEvents, closeBrowserRuntime } from "../agent/lib/browser-runtime";
import { taskState } from "../agent/lib/task-state";
import { ContextContainer, contextStorage } from "../node_modules/eve/dist/src/context/container.js";

let directory: string;
const client = new Notte();
const profiles = new Set<string>();
const sessions = new Set<BrowserSession>();
const state = (id: string): ConversationState => ({ id, traces: [], browser: { provider: "not-started", status: "idle" } });
beforeAll(async () => {
  if (process.env.STAGEHAND_BROWSER !== "notte") throw new Error("Run against an explicitly configured Notte environment.");
  directory = await mkdtemp(join(tmpdir(), "bell-notte-e2e-"));
  process.env.BELL_CONTEXT_METADATA_PATH = join(directory, "contexts.json");
});
afterAll(async () => {
  const cleanup = await Promise.allSettled([...sessions].map(session => session.close()));
  const deleted = await Promise.allSettled([...profiles].map(id => client.contexts.delete(id)));
  await rm(directory, { recursive: true, force: true });
  expect([...cleanup, ...deleted].every(result => result.status === "fulfilled")).toBe(true);
});

it("drives a Notte browser with Stagehand, reuses it, captures a screenshot, hands off, and releases it", async () => {
  const data = state("notte-live-browser");
  const browser = new BrowserSession(data);
  sessions.add(browser);
  await browser.run([{ action: "goto", url: "https://example.com/" }]);
  const id = data.browser.sessionId!;
  expect(id).toBeTruthy();
  const observed = await browser.snapshot();
  expect(observed.tree).toContain("Example Domain");
  expect((await browser.screenshot()).data).toBeTruthy();
  await browser.snapshot();
  expect(data.browser.sessionId).toBe(id);
  const secret = "synthetic-e2e-handoff-secret-at-least-32-bytes";
  const token = issueBrowserHandoffToken({ eveSessionId: data.id, browserSessionId: id }, { secret });
  const viewer = await resolveBrowserHandoffLiveViewUrl(token, { secret });
  expect(new URL(viewer).pathname).toBe("/static/viewer");
  const response = await fetch(viewer, { signal: AbortSignal.timeout(20_000) });
  expect(response.ok).toBe(true);
  await browser.close();
  // Stop acknowledges synchronously; the provider persists final status in background cleanup.
  await expect.poll(async () => (await client.sessions.retrieve(id)).status, { timeout: 5_000 }).toBe("closed");
  expect(data.browser.sessionId).toBeUndefined();
}, 90_000);

it("persists cookies in a Notte profile and restores them in another session", async () => {
  const profile = await createAgentContext(`Bell synthetic E2E ${Date.now()}`);
  profiles.add(profile.id);
  const writer = new BrowserSession(state("notte-profile-writer"), { contextId: profile.id });
  sessions.add(writer);
  const marker = `synthetic-${Date.now()}`;
  await writer.importCookies([{ name: "bell_e2e", value: marker, url: "https://example.com/" }], "https://example.com/");
  await writer.close();
  const reader = new BrowserSession(state("notte-profile-reader"), { contextId: profile.id });
  sessions.add(reader);
  await reader.run([{ action: "goto", url: "https://example.com/" }]);
  expect((await reader.exportCookies()).some(cookie => cookie.name === "bell_e2e" && cookie.value === marker)).toBe(true);
  await reader.close();
}, 90_000);

it("fills and submits a synthetic login with Notte's default recording and logging", async () => {
  const data = state("notte-default-recording-login");
  const browser = new BrowserSession(data);
  sessions.add(browser);
  await browser.run([{ action: "goto", url: "https://example.com/" }]);
  await browser.withHostedPage(new AbortController().signal, async page => {
    await page.evaluate(() => {
      document.body.innerHTML = '<input id="user"><input id="password" type="password"><button id="submit">Sign in</button><p id="result"></p>';
      document.querySelector("#submit")!.addEventListener("click", () => {
        const user = document.querySelector<HTMLInputElement>("#user")!;
        const password = document.querySelector<HTMLInputElement>("#password")!;
        if (user.value === "bell-synthetic-user" && password.value === "bell-synthetic-password") {
          password.value = "";
          document.querySelector("#result")!.innerHTML = '<span id="success">Synthetic login complete</span>';
        }
      });
    });
  });
  const result = await browser.secureLogin({
    allowedHosts: ["example.com"], username: "bell-synthetic-user", password: "bell-synthetic-password",
    usernameTarget: "#user", passwordTarget: "#password", submitTarget: "#submit", successTarget: "#success",
  });
  expect(result.status).toBe("complete");
  expect(JSON.stringify({ result, traces: data.traces })).not.toContain("bell-synthetic-password");
  await browser.close();
}, 90_000);

it("runs Bell's real Eve tools and terminal cleanup against the same Notte session", async () => {
  const id = "notte-eve-tool-e2e";
  await contextStorage.run(new ContextContainer(), async () => {
    const ctx = { session: { id }, abortSignal: new AbortController().signal } as never;
    try {
      const opened = await run.execute({ actions: [{ action: "goto", url: "https://example.com/" }] }, ctx);
      if (!("workbench" in opened)) throw new Error("Expected a completed browser tool output.");
      const browserId = opened.workbench.browser.sessionId!;
      if (opened.workbench.browser.contextId) profiles.add(opened.workbench.browser.contextId);
      expect(opened.workbench.browser.provider).toBe("notte");
      await lifecycle.events!["turn.completed"]!({} as never, ctx);
      expect(taskState.get().browser.sessionId).toBe(browserId);
      const observed = await snapshot.execute({}, ctx);
      if (!("result" in observed)) throw new Error("Expected a completed snapshot tool output.");
      expect(observed.result.tree).toContain("Example Domain");
      const captured = await screenshot.execute({}, ctx);
      if (!("workbench" in captured)) throw new Error("Expected a completed screenshot tool output.");
      expect(captured.workbench.browser.sessionId).toBe(browserId);
      expect(captured.workbench.screenshotDataUrl).toMatch(/^data:image\/png;base64,/);
      await browserChannelEvents["session.completed"]({}, undefined, { session: { id } });
      expect(taskState.get().browser.sessionId).toBeUndefined();
      await expect.poll(async () => (await client.sessions.retrieve(browserId)).status, { timeout: 5_000 }).toBe("closed");
    } finally {
      const profile = taskState.get().browser.contextId;
      if (profile) profiles.add(profile);
      await closeBrowserRuntime(id);
    }
  });
}, 90_000);
