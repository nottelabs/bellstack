import { afterEach, describe, expect, it, vi } from "vitest";
import Notte, { NotteAPIError } from "../server/notte";

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
describe("Notte infrastructure adapter", () => {
  const session = { session_id: "synthetic-session", status: "active", cdp_url: "wss://router.notte.cc/synthetic", viewer_url: "https://console.notte.cc/static/viewer?jwt=synthetic" };
  it("uses native session and profile routes with server-only bearer authentication", async () => {
    vi.stubEnv("NOTTE_API_URL", "https://api.notte.cc");
    const request = vi.fn().mockResolvedValueOnce(Response.json(session))
      .mockResolvedValueOnce(Response.json(session))
      .mockResolvedValueOnce(Response.json({ ...session, status: "closed" }))
      .mockResolvedValueOnce(Response.json({ profile_id: "notte-profile-synthetic", name: "Fixture" }))
      .mockResolvedValueOnce(Response.json({ profile_id: "notte-profile-synthetic", name: "Fixture" }))
      .mockResolvedValueOnce(Response.json({ success: true }));
    vi.stubGlobal("fetch", request);
    const client = new Notte({ apiKey: "synthetic-private-key" });
    expect(await client.sessions.create({ proxies: true })).toEqual(session);
    expect((await client.sessions.retrieve(session.session_id)).connectUrl).toBe(session.cdp_url);
    expect((await client.sessions.update(session.session_id, { status: "REQUEST_RELEASE" })).status).toBe("closed");
    expect((await client.contexts.create({ name: "Fixture" })).id).toBe("notte-profile-synthetic");
    await client.contexts.retrieve("notte-profile-synthetic");
    await client.contexts.delete("notte-profile-synthetic");
    expect(request.mock.calls.map(([url, options]) => [new URL(url).pathname, options.method])).toEqual([
      ["/sessions/start", "POST"], ["/sessions/synthetic-session", "GET"], ["/sessions/synthetic-session/stop", "DELETE"],
      ["/profiles/create", "POST"], ["/profiles/notte-profile-synthetic", "GET"], ["/profiles/notte-profile-synthetic", "DELETE"],
    ]);
    for (const [, options] of request.mock.calls) {
      expect(options.headers.Authorization).toBe("Bearer synthetic-private-key");
      expect(options.redirect).toBe("error");
    }
  });
  it.each(["http://untrusted.example", "https://api.notte.cc/path", "https://user:pass@api.notte.cc"])("rejects unsafe origins %s before sending credentials", value => {
    vi.stubEnv("NOTTE_API_URL", value);
    expect(() => new Notte({ apiKey: "private" })).toThrow("exact HTTPS origin");
  });
  it("rejects unsafe resource IDs before making a request", async () => {
    const request = vi.fn(); vi.stubGlobal("fetch", request);
    const client = new Notte({ apiKey: "private" });
    await expect(client.sessions.retrieve("../another-resource")).rejects.toThrow();
    await expect(client.contexts.delete("id?token=private")).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
  it("withholds provider bodies and transport credentials and never repeats creation", async () => {
    const request = vi.fn().mockResolvedValueOnce(new Response("synthetic-private-provider-body", { status: 503 }))
      .mockRejectedValueOnce(new Error("wss://private?token=synthetic-private-token"));
    vi.stubGlobal("fetch", request);
    const client = new Notte({ apiKey: "private" });
    await expect(client.sessions.create({})).rejects.toEqual(new NotteAPIError(503));
    await expect(client.sessions.create({})).rejects.toThrow("Check connectivity and reconcile");
    expect(request).toHaveBeenCalledTimes(2);
  });
});
