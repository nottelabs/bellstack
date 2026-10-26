import { localBrowser, Stagehand } from "@browserbasehq/stagehand";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserSession } from "../../server/browser/browser-session";
import type { ConversationState } from "../../server/browser/types";

beforeEach(() => {
  vi.stubEnv("STAGEHAND_BROWSER", "notte"); vi.stubEnv("NOTTE_API_KEY", "synthetic-private-key");
  vi.stubEnv("NOTTE_PROFILE_ID", ""); vi.stubEnv("BELL_ONEPASSWORD_EXTENSION_ID", "");
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
describe("Notte session recovery", () => {
  const response = (id: string, status = "active") => Response.json({ session_id: id, status, cdp_url: "wss://router.notte.cc/synthetic" });
  function fixture(id?: string) {
    const state: ConversationState = { id: "recovery-test", traces: [], browser: { provider: "notte", status: "idle", sessionId: id } };
    const remote = { closed: false, close: vi.fn(async () => {}), context: { pages: async () => [] } };
    const connect = vi.spyOn(localBrowser, "connect").mockResolvedValue(remote as never);
    vi.spyOn(Stagehand, "create").mockResolvedValue({ close: async () => {} } as never);
    return { state, remote, connect, browser: new BrowserSession(state) };
  }
  it("reconnects the existing active session without creating another browser", async () => {
    const request = vi.fn().mockResolvedValueOnce(response("existing-session")).mockResolvedValueOnce(response("existing-session", "closed"));
    vi.stubGlobal("fetch", request);
    const { state, browser } = fixture("existing-session");
    await browser.start();
    expect(state.browser.sessionId).toBe("existing-session");
    expect(request).toHaveBeenCalledOnce();
    await browser.close();
  });
  it.each(["closed", "timed_out", "missing"])("replaces a confirmed %s session without stopping it again", async status => {
    const request = vi.fn().mockResolvedValueOnce(status === "missing" ? new Response(null, { status: 404 }) : response("old-session", status))
      .mockResolvedValueOnce(response("new-session")).mockResolvedValueOnce(response("new-session", "closed"));
    vi.stubGlobal("fetch", request);
    const { state, browser } = fixture("old-session");
    await browser.start();
    expect(state.browser.sessionId).toBe("new-session");
    expect(request.mock.calls.map(([url]) => new URL(url).pathname)).toEqual(["/sessions/old-session", "/sessions/start"]);
    await browser.close();
  });
  it("preserves ownership and refuses replacement on an uncertain retrieval failure", async () => {
    const request = vi.fn().mockResolvedValue(new Response(null, { status: 503 })); vi.stubGlobal("fetch", request);
    const { state, browser, connect } = fixture("existing-session");
    await expect(browser.start()).rejects.toThrow("HTTP 503");
    expect(state.browser.sessionId).toBe("existing-session");
    expect(connect).not.toHaveBeenCalled(); expect(request).toHaveBeenCalledOnce();
  });
  it("releases an owned new session when Stagehand attachment fails", async () => {
    const request = vi.fn().mockResolvedValueOnce(response("new-session")).mockResolvedValueOnce(response("new-session", "closed")); vi.stubGlobal("fetch", request);
    const { state, browser, connect } = fixture(); connect.mockRejectedValue(new Error("protocol mismatch"));
    await expect(browser.start()).rejects.toThrow("Verify the deployed Stagehand extension version");
    expect(request.mock.calls.map(([url]) => new URL(url).pathname)).toEqual(["/sessions/start", "/sessions/new-session/stop"]);
    expect(state.browser.sessionId).toBeUndefined();
  });
  it("retains the live client and session ID until failed release can finish", async () => {
    const request = vi.fn().mockResolvedValueOnce(response("new-session"))
      .mockResolvedValueOnce(new Response(null, { status: 503 })).mockResolvedValueOnce(response("new-session", "closed")); vi.stubGlobal("fetch", request);
    const { state, browser, remote } = fixture(); await browser.start();
    await expect(browser.close()).rejects.toThrow("could not be released");
    expect(state.browser.sessionId).toBe("new-session"); expect(remote.close).not.toHaveBeenCalled();
    await browser.close(); expect(state.browser.sessionId).toBeUndefined(); expect(remote.close).toHaveBeenCalledOnce();
  });
  it("persists through Notte before closing a browser whose Stagehand initialization failed", async () => {
    const order: string[] = [];
    const request = vi.fn().mockResolvedValueOnce(response("new-session"))
      .mockImplementationOnce(async () => { order.push("stop"); return response("new-session", "closed"); });
    vi.stubGlobal("fetch", request);
    const { browser, remote } = fixture();
    vi.mocked(Stagehand.create).mockRejectedValue(new Error("extension mismatch"));
    remote.close.mockImplementation(async () => { order.push("close"); });
    await expect(browser.start()).rejects.toThrow("Verify the deployed Stagehand extension version");
    expect(order).toEqual(["stop", "close"]);
  });
});
