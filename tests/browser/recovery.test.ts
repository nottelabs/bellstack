import { afterEach, describe, expect, it, vi } from "vitest";

import {
  assessSnapshot,
  notteLaunchOptions,
  browserProvider,
  BrowserSession,
} from "../../server/browser/browser-session.js";

describe("browser recovery", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    delete process.env.STAGEHAND_BROWSER;
    delete process.env.NOTTE_API_KEY;
    delete process.env.NOTTE_PROFILE_ID;
  });

  it("detects a common access block", () => {
    expect(assessSnapshot("You have been blocked.", "https://www.yelp.com").blocked).toBe(true);
  });

  it("detects an empty hosted page", () => {
    const tree =
      "PAGE CONTENT\n(No visible page text)\n\nINTERACTIVE TARGETS\n(No visible interactive targets)";
    expect(assessSnapshot(tree, "https://www.yelp.com/search")).toEqual({
      blocked: true,
      signal: "empty page",
    });
  });

  it("detects a login wall", () => {
    expect(
      assessSnapshot(
        "Log in to Foursquare\nEnter your email or phone to receive a login code\nContinue",
        "https://app.foursquare.com/login?continue=%2Fexplore",
      ),
    ).toEqual({ blocked: true, signal: "login wall" });
  });

  it("detects a not-found page", () => {
    expect(
      assessSnapshot("Page Not Found - Judy's Book", "https://www.judysbook.com/barbers"),
    ).toEqual({
      blocked: true,
      signal: "not found",
    });
  });

  it("uses Notte automatically when its key is present", () => {
    process.env.NOTTE_API_KEY = "synthetic_notte_key";
    expect(browserProvider()).toBe("notte");
  });

  it("reports a missing Notte key instead of launching local Chrome by default", async () => {
    vi.stubEnv("STAGEHAND_BROWSER", undefined);
    vi.stubEnv("NOTTE_API_KEY", undefined);
    const session = new BrowserSession({ id: "missing-notte-key", traces: [], browser: { provider: "not-started", status: "idle" } });
    expect(browserProvider()).toBe("notte");
    await expect(session.start()).rejects.toThrow("NOTTE_API_KEY is required");
  });

  it("uses local Chrome only when explicitly selected", () => {
    vi.stubEnv("STAGEHAND_BROWSER", "local");
    expect(browserProvider()).toBe("local");
  });

  it("starts Notte with managed proxies", () => {
    expect(notteLaunchOptions("test-key")).toMatchObject({
      proxies: true, browser_type: "chrome",
    });
  });
  it("maps country and city to a native Notte proxy", () => {
    expect(notteLaunchOptions("test-key", undefined, { country: "US", city: "San Francisco" }).proxies)
      .toEqual([{ type: "notte", country: "us", city: "San Francisco" }]);
    expect(() => notteLaunchOptions("test-key", undefined, { country: "US", state: "CA" })).toThrow("not state");
  });
  it("attaches the configured persistent Notte profile", () => {
    process.env.NOTTE_PROFILE_ID = "context_example";
    expect(notteLaunchOptions("test-key").profile).toEqual({ id: "context_example", persist: true });
  });
  it("prefers the durable task profile to the deployment default", () => {
    process.env.NOTTE_PROFILE_ID = "context_new_default";
    expect(notteLaunchOptions("test-key", "context_saved_task").profile).toEqual({ id: "context_saved_task", persist: true });
  });
});
