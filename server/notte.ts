import { z } from "zod";

const identifier = z.string().regex(/^[A-Za-z0-9_-]{8,128}$/);
const sessionSchema = z.object({
  session_id: identifier, status: z.enum(["active", "authenticating", "closed", "error", "timed_out"]),
  cdp_url: z.string().nullable().optional(), viewer_url: z.string().nullable().optional(),
});
const profileSchema = z.object({ profile_id: identifier, name: z.string().nullable().optional() });

export class NotteAPIError extends Error {
  readonly status: number;
  constructor(status: number) { super(`Notte request failed (HTTP ${status}).`); this.status = status; }
}

/** Bell owns Notte sessions; Stagehand only controls the returned CDP browser. */
export default class Notte {
  static APIError = NotteAPIError;
  private readonly origin: string;
  private readonly apiKey: string;
  constructor(options: { apiKey?: string } = {}) {
    this.apiKey = options.apiKey ?? process.env.NOTTE_API_KEY ?? "";
    this.origin = process.env.NOTTE_API_URL ?? "https://api.notte.cc";
    const url = new URL(this.origin);
    if (url.origin !== this.origin || url.username || url.password ||
      (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))))
      throw new Error("NOTTE_API_URL must be an exact HTTPS origin (or loopback HTTP).");
    if (!this.apiKey.trim()) throw new Error("Set NOTTE_API_KEY on the server.");
  }

  private async request(path: string, method = "GET", body?: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(this.origin + path, { method, redirect: "error", signal: AbortSignal.timeout(60_000),
        headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch { throw new Error("Notte request failed. Check connectivity and reconcile the existing operation before retrying."); }
    if (!response.ok) throw new NotteAPIError(response.status);
    if (response.status === 204) return undefined;
    try { return await response.json(); } catch { throw new Error("Notte returned an invalid response."); }
  }

  sessions = {
    create: async (options: Record<string, unknown>) => {
      const raw = await this.request("/sessions/start", "POST", options);
      // Capture ownership before checking connection fields so failed attachment can release it.
      return sessionSchema.parse(raw);
    },
    retrieve: async (id: string) => {
      const session = sessionSchema.parse(await this.request(`/sessions/${identifier.parse(id)}`));
      return { ...session, connectUrl: session.cdp_url, viewerUrl: session.viewer_url };
    },
    update: async (id: string, options: { status: "REQUEST_RELEASE"; projectId?: string }) => {
      if (options.status !== "REQUEST_RELEASE") throw new Error("Unsupported session update.");
      return sessionSchema.parse(await this.request(`/sessions/${identifier.parse(id)}/stop`, "DELETE"));
    },
    debug: async (id: string) => ({ debuggerFullscreenUrl: (await this.sessions.retrieve(id)).viewerUrl ?? undefined }),
  };

  contexts = {
    create: async (options: { name: string }) => {
      const profile = profileSchema.parse(await this.request("/profiles/create", "POST", { name: options.name }));
      return { id: profile.profile_id, name: profile.name };
    },
    retrieve: async (id: string) => {
      const profile = profileSchema.parse(await this.request(`/profiles/${identifier.parse(id)}`));
      return { id: profile.profile_id, name: profile.name };
    },
    delete: async (id: string) => this.request(`/profiles/${identifier.parse(id)}`, "DELETE"),
  };
}
