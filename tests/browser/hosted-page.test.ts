import { afterEach, describe, expect, it, vi } from "vitest";
import { localBrowser } from "@browserbasehq/stagehand";
import { BrowserSession, notteLaunchOptions } from "../../server/browser/browser-session";
import type { ConversationState } from "../../server/browser/types";

function fixture() {
  const state: ConversationState = {
    id: "shared-test",
    traces: [],
    browser: { provider: "not-started", status: "idle" },
  };
  const session = new BrowserSession(state);
  const page = {
    url: async () => "https://example.com/",
    title: async () => "Example",
  };
  vi.spyOn(session, "start").mockResolvedValue();
  Object.assign(session, {
    remoteSessionId: "private-session",
    browser: { context: { activePage: async () => page } },
    notte: {
      sessions: {
        retrieve: async () => ({ connectUrl: "wss://private-connection" }),
      },
    },
  });
  return { session, state, page };
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
describe("shared hosted-page integration boundary", () => {
  it("uses the existing page and exposes only the callback result", async () => {
    const { session, state, page } = fixture();
    const operation = vi.fn(async (active, connection, sessionId) => {
      expect(active).toBe(page);
      expect(connection).toBe("wss://private-connection");
      expect(sessionId).toBe("private-session");
      return { accepted: true };
    });
    expect(await session.withHostedPage(new AbortController().signal, operation)).toEqual({
      accepted: true,
    });
    expect(state.browser.url).toBe("https://example.com/");
    expect(JSON.stringify(state)).not.toContain("private-connection");
  });
  it("does not observe the page after a private operation", async () => {
    const { session, state, page } = fixture();
    const title = vi.spyOn(page, "title"), url = vi.spyOn(page, "url");
    await session.withHostedPage(new AbortController().signal, async () => ({ submitted: true }), true);
    expect(title).not.toHaveBeenCalled();
    expect(url).not.toHaveBeenCalled();
    expect(state.browser.url).toBeUndefined();
  });
  it("does no work for an already-cancelled call", async () => {
    const { session } = fixture();
    const operation = vi.fn();
    await expect(session.withHostedPage(AbortSignal.abort(), operation)).rejects.toThrow();
    expect(operation).not.toHaveBeenCalled();
  });
  it("releases the operation lock after a failed callback", async () => {
    const { session } = fixture();
    await expect(
      session.withHostedPage(new AbortController().signal, async () => {
        throw new Error("failed");
      }),
    ).rejects.toThrow("failed");
    await expect(
      session.withHostedPage(new AbortController().signal, async () => "next"),
    ).resolves.toBe("next");
  });
  it("does not claim that Notte supports recording opt-out", () => {
    expect(notteLaunchOptions("test-key")).not.toHaveProperty("browserSettings");
    expect(notteLaunchOptions("test-key")).not.toHaveProperty("userMetadata");
  });
  it.each([undefined, { country: "US" }])("uses managed Notte proxies with location %j", location => {
    const options = notteLaunchOptions("test-key", "test-context", location);
    expect(options.profile).toEqual({ id: "test-context", persist: true });
    expect(options.proxies).toEqual(location ? [{ type: "notte", country: "us" }] : true);
  });
  it("does not launch local Chrome when Notte creation fails", async () => {
    vi.stubEnv("STAGEHAND_BROWSER", "notte");
    vi.stubEnv("NOTTE_API_KEY", "test-key");
    const request = vi.fn().mockRejectedValue(new Error("Synthetic transport failure"));
    vi.stubGlobal("fetch", request);
    const localLaunch = vi.spyOn(localBrowser, "launch");
    const session = new BrowserSession({ id: "notte-failure", traces: [], browser: { provider: "not-started", status: "idle" } });
    try {
      await expect(session.start()).rejects.toThrow("Notte request failed");
      expect(request).toHaveBeenCalledOnce();
      expect(localLaunch).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });
});
