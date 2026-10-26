import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserSession } from "../../server/browser/browser-session";
import { prepareMerchantAccess } from "../../server/merchant-access";
import { submitPayment } from "../../server/link/checkout-browser";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe.each(["notte", "auto", "local"])("credential operations with default recording (%s)", provider => {
  it("fills a login without an additional recording opt-in", async () => {
    vi.stubEnv("STAGEHAND_BROWSER", provider);
    const session = new BrowserSession({ id: "default-recording", traces: [], browser: { provider: "not-started", status: "idle" } });
    const fill = vi.fn<(selector: string, value: string) => Promise<void>>().mockResolvedValue();
    const click = vi.fn(async () => {});
    const page = {
      url: async () => "https://shop.example/login",
      title: async () => "Synthetic shop",
      waitForTimeout: async () => {},
      locator: (selector: string) => ({
        fill: (value: string) => fill(selector, value),
        click,
        count: async () => 1,
      }),
    };
    const batch = async <T, A>(callback: (context: { page: typeof page }, args: A) => Promise<T>, args: A) => callback({ page }, args);
    vi.spyOn(session, "start").mockResolvedValue();
    vi.spyOn(session as unknown as { withPage: typeof batch }, "withPage").mockImplementation(batch);
    await expect(session.secureLogin({
      allowedHosts: ["shop.example"], username: "synthetic-user", password: "synthetic-password",
      usernameTarget: "#user", passwordTarget: "#password", submitTarget: "#submit", successTarget: "#success",
    })).resolves.toMatchObject({ status: "complete" });
    expect(fill.mock.calls).toEqual([["#user", "synthetic-user"], ["#password", "synthetic-password"]]);
    expect(click).toHaveBeenCalledOnce();
  });

  it("prepares and signs a merchant proof without an additional recording opt-in", async () => {
    vi.stubEnv("STAGEHAND_BROWSER", provider);
    const { privateKey } = generateKeyPairSync("ed25519");
    const mint = vi.fn(async () => ({
      credential: "synthetic-proof~", privateJwk: privateKey.export({ format: "jwk" }),
      audience: "merchant.example", expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }));
    const access = await prepareMerchantAccess("https://merchant.example/protected", new AbortController().signal, {
      config: { apiKey: "synthetic", principalRef: "synthetic", allowedOrigins: ["https://merchant.example"] },
      mint,
      fetch: async (_url, init) => Response.json(init?.method === "POST"
        ? { nonce: "synthetic-nonce", audience: "merchant.example" }
        : { audience: "merchant.example", nonce_endpoint: "/nonces", scopes: [{ id: "trade", resources: ["/protected"], accepted_levels: ["L2"] }] }),
    });
    expect((await access.headers())["KYA-Credential"]).toMatch(/^synthetic-proof~/);
    expect(mint).toHaveBeenCalledOnce();
  });

  it("submits payment without an additional recording opt-in and retains transcript quarantine", async () => {
    vi.stubEnv("STAGEHAND_BROWSER", provider);
    const handle = { evaluate: vi.fn(async () => true), click: vi.fn(async () => {}), dispose: vi.fn(async () => {}) };
    const locator = { count: async () => 1, elementHandle: async () => handle };
    const frame = { url: () => "https://merchant.example/checkout", locator: () => locator };
    const page = { ...frame, mainFrame: () => frame };
    const credentials = vi.fn(async () => ({ card: { number: "4242424242424242", cvc: "123", exp_month: 12, exp_year: 2040 } }));
    const quarantine = vi.fn(async () => {});
    const result = await submitPayment(page as never, {
      id: "synthetic-payment", amount: 100, currency: "usd", credential: "card",
      fields: [{ field: "number", selector: "#number" }], submit: { selector: "#pay" },
    }, ["https://merchant.example"], credentials, new AbortController().signal, quarantine);
    expect(result.status).toBe("submission_attempted");
    expect(credentials).toHaveBeenCalledOnce();
    expect(quarantine).toHaveBeenCalledOnce();
    expect(handle.click).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toContain("4242424242424242");
  });
});
