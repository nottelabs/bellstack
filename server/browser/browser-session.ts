import { personalBrowserEnabled, requireReusableContexts } from "../onepassword/browser-policy";
import Notte from "../notte";
import {
  localBrowser,
  Stagehand,
  type CookieParam,
  type StagehandBrowser,
  type Page,
} from "@browserbasehq/stagehand";

import { addTrace } from "./trace.js";
import type { BrowserProxyLocation, BrowserState, ConversationState, RunAction } from "./types.js";

export interface BrowserRecoveryReport {
  visitedOrigins: string[];
  blockedOrigins: string[];
  liveSourceOrigins: string[];
}

const DISCOVERY_HOSTS = ["google.", "bing.com", "duckduckgo.com", "search.brave.com", "yahoo.com"];

export class BrowserSession {
  private stagehand?: Stagehand;
  private browser?: StagehandBrowser;
  private notte?: Notte;
  private remoteSessionId?: string;
  private startPromise?: Promise<void>;
  private closeRequested = false;
  private operationTail: Promise<void> = Promise.resolve();
  private xpathMap: Record<string, string> = {};
  private readonly visitedOrigins = new Set<string>();
  private readonly blockedOrigins = new Set<string>();
  private readonly liveSourceOrigins = new Set<string>();

  constructor(
    private readonly state: ConversationState,
    private readonly options: {
      contextId?: string;
      proxyLocation?: BrowserProxyLocation;
      ensureContext?: (
        currentContextId?: string,
      ) => Promise<{ id: string; status: "draft" | "saved" }>;
    } = {},
  ) {}

  async start(): Promise<void> {
    if (this.closeRequested)
      throw new DOMException("The browser session was closed.", "AbortError");
    if (this.stagehand && this.browser && !this.browser.closed) return;
    const startPromise = this.startPromise ?? this.startOnce();
    this.startPromise = startPromise;
    try {
      await startPromise;
      if (this.closeRequested)
        throw new DOMException("The browser session was closed.", "AbortError");
    } finally {
      if (this.startPromise === startPromise) this.startPromise = undefined;
    }
  }

  private async startOnce(): Promise<void> {
    this.state.browser.status = "starting";
    const started = performance.now();
    const requested = browserProvider();
    let contextStatus: "draft" | "saved" | undefined;

    try {
      if (requested === "notte") {
        const apiKey = process.env.NOTTE_API_KEY;
        if (!apiKey) throw new Error("NOTTE_API_KEY is required for Notte mode.");
        if (personalBrowserEnabled() && (this.options.contextId || process.env.NOTTE_PROFILE_ID))
          throw new Error("Start a new conversation without a reusable Context for personal 1Password.");
        const currentContextId = this.options.contextId ?? process.env.NOTTE_PROFILE_ID;
        if (this.options.ensureContext && !personalBrowserEnabled()) {
          const context = await this.options.ensureContext(currentContextId);
          this.options.contextId = context.id;
          contextStatus = context.status;
        } else if (currentContextId) {
          this.options.contextId = currentContextId;
          contextStatus = "saved";
        }
        await this.startNotte(apiKey);
      } else {
        this.browser = await localBrowser.launch({
          headless: process.env.BELL_HEADLESS !== "false",
          viewport: { width: 1360, height: 900 },
        });
        await this.attachStagehand(this.browser);
      }

      this.state.browser = {
        provider: requested,
        status: "active",
        proxies: requested === "notte",
        verified: requested === "notte",
        contextId: this.options.contextId ?? process.env.NOTTE_PROFILE_ID,
        contextStatus,
        proxyLocation: requested === "notte" ? this.options.proxyLocation : undefined,
        sessionId: this.remoteSessionId,
      };
      if (requested === "notte" && contextStatus) {
        addTrace(
          this.state,
          "context",
          contextStatus === "draft" ? "context.draft.attach" : "context.attach",
          contextStatus === "draft"
            ? "Attached a draft Context. Browser state is now captured for a later save."
            : "Attached the saved Notte Context.",
          { status: contextStatus, persist: true },
        );
      }
      addTrace(
        this.state,
        "browser",
        "browser.start",
        `Started one persistent ${requested} browser for this conversation.`,
        {
          provider: requested,
          reusedByEveryTool: true,
          proxies: requested === "notte",
          verified: requested === "notte",
          contextStatus,
          proxyLocation: this.options.proxyLocation,
          transport: "Stagehand v4 native Eve tools",
        },
        Math.round(performance.now() - started),
      );
    } catch (error) {
      this.state.browser.status = "error";
      addTrace(this.state, "error", "browser.start", errorMessage(error));
      throw error;
    }
  }

  /** Run a server-owned integration in the existing hosted browser under its operation lock.
   * Never return the connection URL or private request headers from the callback.
   */
  async withHostedPage<T>(
    signal: AbortSignal,
    operation: (page: Page, connectUrl: string, sessionId: string) => Promise<T>,
    privateResult = false,
  ): Promise<T> {
    signal.throwIfAborted();
    const release = await this.acquireOperation();
    try {
      signal.throwIfAborted();
      await this.start();
      if (!this.notte || !this.remoteSessionId || !this.browser)
        throw new Error("This integration requires a hosted Notte session.");
      const page =
        (await this.browser.context.activePage()) ?? (await this.browser.context.newPage());
      const session = await this.notte.sessions.retrieve(this.remoteSessionId);
      if (!session.connectUrl) throw new Error("The hosted browser connection is unavailable.");
      const result = await operation(page, session.connectUrl, this.remoteSessionId);
      this.xpathMap = {};
      if (!privateResult) {
        this.updateBrowserState(await page.url(), await page.title());
      }
      return result;
    } finally {
      release();
    }
  }

  async snapshot(): Promise<{
    tree: string;
    url: string;
    snapshotIdCount: number;
    pageStatus: "live" | "blocked";
    recovery: BrowserRecoveryReport;
  }> {
    const release = await this.acquireOperation();
    try {
      await this.start();
      const started = performance.now();
      const result = await this.withPage(async ({ page }) => {
        const snapshot = await page.snapshot({ includeIframes: true });
        return {
          snapshot,
          url: await page.url(),
          title: await page.title(),
        };
      });
      this.xpathMap = result.snapshot.xpathMap;
      const url = result.url;
      this.updateBrowserState(result.url, result.title);
      const assessment = assessSnapshot(result.snapshot.formattedTree, url);
      const origin = originOf(url);
      if (origin) this.visitedOrigins.add(origin);
      if (assessment.blocked && origin) {
        const firstBlockOnOrigin = !this.blockedOrigins.has(origin);
        this.blockedOrigins.add(origin);
        this.liveSourceOrigins.delete(origin);
        if (firstBlockOnOrigin) {
          addTrace(
            this.state,
            "browser",
            "block.detected",
            `Detected an access block on ${origin}. The task must continue on another source.`,
            { origin, signal: assessment.signal },
          );
        }
      } else if (origin && isLiveSourceUrl(url)) {
        this.liveSourceOrigins.add(origin);
      }
      addTrace(
        this.state,
        "tool",
        "snapshot",
        `Read the current accessibility tree and found ${Object.keys(result.snapshot.xpathMap).length} targets.`,
        {
          url,
          pageStatus: assessment.blocked ? "blocked" : "live",
          treePreview: result.snapshot.formattedTree.slice(0, 1200),
        },
        Math.round(performance.now() - started),
      );
      return {
        tree: result.snapshot.formattedTree.slice(0, 14_000),
        url,
        snapshotIdCount: Object.keys(result.snapshot.xpathMap).length,
        pageStatus: assessment.blocked ? "blocked" : "live",
        recovery: this.recoveryReport(),
      };
    } finally {
      release();
    }
  }

  async run(actions: RunAction[]): Promise<{ completed: number; url: string }> {
    for (const item of actions) {
      if (item.action !== "goto") continue;
      const destination = new URL(item.url);
      if (
        !["https:", "http:"].includes(destination.protocol) ||
        destination.username ||
        destination.password
      )
        throw new Error("Browser navigation requires an HTTP(S) URL without embedded credentials.");
    }
    const release = await this.acquireOperation();
    try {
      await this.start();
      const started = performance.now();
      const resolvedActions = actions.map((item) =>
        "target" in item && item.target
          ? { ...item, target: this.resolveTarget(item.target) }
          : item,
      );
      const result = await this.withPage(
        async ({ page }, batchActions) => {
          for (const item of batchActions) {
            switch (item.action) {
              case "goto":
                await page.goto(item.url);
                await page.waitForLoadState("domcontentloaded", 15_000);
                break;
              case "click":
                await page.locator(item.target).click();
                break;
              case "fill":
                await page.locator(item.target).fill(item.value);
                break;
              case "type":
                await page.locator(item.target).type(item.value);
                break;
              case "press":
                if (item.target) await page.locator(item.target).click();
                await page.keyPress(item.key);
                break;
              case "select":
                await page.locator(item.target).selectOption(item.value);
                break;
              case "wait":
                await page.waitForTimeout(Math.min(item.milliseconds, 10_000));
                break;
            }
          }
          return { url: await page.url(), title: await page.title() };
        },
        resolvedActions,
        { timeout: 60_000 },
      );

      this.xpathMap = {};
      this.updateBrowserState(result.url, result.title);
      const url = result.url;
      const origin = originOf(url);
      if (origin) this.visitedOrigins.add(origin);
      addTrace(
        this.state,
        "tool",
        "run",
        `Completed ${actions.length} exact browser action${actions.length === 1 ? "" : "s"}.`,
        { actions, url, snapshotIdsInvalidated: true },
        Math.round(performance.now() - started),
        formatRunCode(resolvedActions),
      );
      return { completed: actions.length, url };
    } finally {
      release();
    }
  }

  async secureLogin(input: {
    allowedHosts: string[];
    username: string;
    password: string;
    usernameTarget: string;
    passwordTarget: string;
    submitTarget: string;
    totp?: string;
    totpTarget?: string;
    otpSubmitTarget?: string;
    successTarget?: string;
    totpAfterSubmit?: boolean;
  }): Promise<{
    status: "complete" | "waiting_for_user" | "unverified";
    host: string;
    url: string;
  }> {
    const selectors = [input.usernameTarget, input.passwordTarget, input.submitTarget,
      input.totpTarget, input.otpSubmitTarget, input.successTarget];
    if (selectors.some((selector) => selector && (/^\s*(?:xpath=|\/|\()/i.test(selector) || selector.includes(">>"))))
      throw new Error("Secure login requires CSS selectors in the top-level page; frame selectors are not allowed.");
    const release = await this.acquireOperation();
    try {
      await this.start();
      const started = performance.now();
      const result = await this.withPage(
        async ({ page }, values) => {
          const checkDestination = async () => {
            const destination = new URL(await page.url());
            if (
              destination.protocol !== "https:" ||
              destination.username ||
              destination.password ||
              !values.allowedHosts.includes(destination.hostname.toLowerCase())
            )
              throw new Error("Unsafe credential destination.");
          };
          await checkDestination();
          await page.locator(values.usernameTarget).fill(values.username);
          await checkDestination();
          await page.locator(values.passwordTarget).fill(values.password);
          if (values.totpTarget && values.totp && !values.totpAfterSubmit) {
            await checkDestination();
            await page.locator(values.totpTarget).fill(values.totp);
          }
          await checkDestination();
          await page.locator(values.submitTarget).click();
          await page.waitForTimeout(1_000);
          if (values.totpTarget && values.totp && values.totpAfterSubmit) {
            await checkDestination();
            await page.locator(values.totpTarget).fill(values.totp);
            if (values.otpSubmitTarget) {
              await checkDestination();
              await page.locator(values.otpSubmitTarget).click();
            }
            await page.waitForTimeout(1_000);
          }
          const url = await page.url(),
            title = await page.title();
          const success = values.successTarget
            ? (await page.locator(values.successTarget).count()) > 0
            : false;
          return { url, title, success };
        },
        input,
        { timeout: 45_000 },
      );
      this.updateBrowserState(result.url, result.title);
      const host = new URL(result.url).hostname;
      const status =
        input.totpTarget && !input.totp
          ? "waiting_for_user"
          : result.success
            ? "complete"
            : "unverified";
      addTrace(
        this.state,
        "tool",
        "vault.login",
        status === "complete"
          ? `Verified login state on ${host}.`
          : status === "waiting_for_user"
            ? `Login on ${host} is waiting for a human challenge.`
            : `Filled the login on ${host}, but success is not verified yet.`,
        { host, status, secretValuesRedacted: true },
        Math.round(performance.now() - started),
      );
      return { status, host, url: result.url };
    } catch {
      addTrace(
        this.state,
        "error",
        "vault.login",
        "The secure login attempt failed. Secret values were redacted.",
      );
      throw new Error(
        "Secure login failed. Inspect the current page and field selectors, then retry.",
      );
    } finally {
      release();
    }
  }

  async screenshot(): Promise<{
    mediaType: "image/png";
    data: string;
    url: string;
  }> {
    const release = await this.acquireOperation();
    try {
      await this.start();
      const started = performance.now();
      const result = await this.withPage(async ({ page }) => ({
        data: await page.screenshot({ type: "png" }),
        url: await page.url(),
        title: await page.title(),
      }));
      const buffer = toBuffer(result.data);
      this.state.screenshot = buffer;
      this.updateBrowserState(result.url, result.title);
      const url = result.url;
      addTrace(
        this.state,
        "tool",
        "screenshot",
        "Captured the visible browser page.",
        { url, bytes: buffer.byteLength },
        Math.round(performance.now() - started),
      );
      return { mediaType: "image/png", data: buffer.toString("base64"), url };
    } finally {
      release();
    }
  }

  async close(): Promise<void> {
    this.closeRequested = true;
    await this.startPromise?.catch(() => undefined);
    const stagehand = this.stagehand;
    const browser = this.browser;
    // Notte persists writable profiles during stop, before the browser is closed.
    await this.releaseRemoteSession();
    this.stagehand = undefined;
    this.browser = undefined;
    await stagehand?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
    if (this.state.browser.status !== "error") this.state.browser.status = "idle";
  }

  hasStarted(): boolean {
    return Boolean(this.stagehand && this.browser && !this.browser.closed);
  }

  async exportCookies(): Promise<CookieParam[]> {
    requireReusableContexts();
    if (!this.hasStarted()) return [];
    return this.browser!.context.cookies();
  }

  async importCookies(cookies: CookieParam[], url?: string): Promise<void> {
    const release = await this.acquireOperation();
    try {
      await this.start();
      if (cookies.length) await this.browser!.context.addCookies(cookies);
      if (url) {
        const page =
          (await this.browser!.context.activePage()) ?? (await this.browser!.context.newPage());
        await page.goto(url, {
          waitUntil: "domcontentloaded",
          timeout: 30_000,
        });
        this.updateBrowserState(await page.url(), await page.title());
      }
      addTrace(
        this.state,
        "context",
        "context.capture",
        "Moved the current browser cookies into a reusable Notte Context.",
        {
          cookieCount: cookies.length,
          url: url ? safePage(url) : undefined,
        },
      );
    } finally {
      release();
    }
  }

  recoveryReport(): BrowserRecoveryReport {
    return {
      visitedOrigins: [...this.visitedOrigins],
      blockedOrigins: [...this.blockedOrigins],
      liveSourceOrigins: [...this.liveSourceOrigins],
    };
  }

  private resolveTarget(target: string): string {
    const raw = target.replace(/^\[/, "").replace(/\]$/, "");
    const xpath = this.xpathMap[target] ?? this.xpathMap[raw];
    if (!xpath && /^\[?\d+\]?$/.test(target)) {
      throw new Error("This snapshot ID is not in the latest snapshot. Call snapshot again.");
    }
    if (!xpath) return target;
    return xpath.startsWith("xpath=") ? xpath : `xpath=${xpath}`;
  }

  private requireStagehand(): Stagehand {
    if (!this.stagehand) throw new Error("The Stagehand client is not ready.");
    return this.stagehand;
  }

  private async acquireOperation(): Promise<() => void> {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = this.operationTail;
    this.operationTail = previous.then(() => gate);
    await previous;
    if (this.closeRequested) {
      release();
      throw new DOMException("The browser session was closed.", "AbortError");
    }
    return release;
  }

  private async startNotte(apiKey: string): Promise<void> {
    if (personalBrowserEnabled())
      throw new Error("Personal 1Password extension loading is not supported by Notte's session API. Keep ONEPASSWORD_ENABLED=false.");
    this.notte = new Notte({ apiKey });
    const persistedSessionId = this.loadPersistedSessionId();
    if (persistedSessionId) {
      try {
        const prior = await this.notte.sessions.retrieve(persistedSessionId);
        if (prior.status === "active") {
          if (!prior.connectUrl) throw new Error("Notte did not return a browser connection.");
          this.remoteSessionId = persistedSessionId;
          await this.attachStagehand(await localBrowser.connect({ cdpUrl: prior.connectUrl }));
          addTrace(this.state, "browser", "browser.reattach", "Reattached Stagehand to the saved Notte session.");
          return;
        }
        if (prior.status === "authenticating") throw new Error("The saved Notte browser is still authenticating.");
      } catch (error) {
        if (!(error instanceof Notte.APIError) || error.status !== 404) throw error;
      }
      // A confirmed terminal or missing session is already released. Notte rejects a second stop.
      this.clearPersistedSessionId();
    }
    const session = await this.notte.sessions.create(notteLaunchOptions(apiKey, this.options.contextId, this.options.proxyLocation));
    this.remoteSessionId = session.session_id;
    this.persistSessionId(session.session_id);
    let connected: StagehandBrowser | undefined;
    try {
      if (session.status !== "active" || !session.cdp_url) throw new Error("Notte did not return an active browser connection.");
      connected = await localBrowser.connect({ cdpUrl: session.cdp_url });
      await this.attachStagehand(connected);
    } catch {
      // attachStagehand owns cleanup after connection; a failed connect still leaves us the session ID.
      if (!connected) await this.releaseRemoteSession();
      throw new Error("Could not attach Stagehand to the Notte browser. Verify the deployed Stagehand extension version.");
    }
  }

  private async withPage<T, A = undefined>(
    callback: (context: { page: Page }, input: A) => Promise<T>, input?: A,
    options?: { timeout: number },
  ): Promise<T> {
    this.requireStagehand();
    if (!this.browser) throw new Error("The browser is not ready.");
    const page = await this.browser.context.activePage() ?? await this.browser.context.newPage();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        void this.close().then(
          () => reject(new Error("The browser operation timed out and its session was closed.")),
          () => reject(new Error("The browser operation timed out and session cleanup failed. Retry cleanup.")),
        );
      }, options?.timeout ?? 30_000);
    });
    try { return await Promise.race([callback({ page }, input as A), deadline]); }
    finally { clearTimeout(timer); }
  }

  private async attachStagehand(browser: StagehandBrowser): Promise<void> {
    this.browser = browser;
    try {
      const stagehand = await Stagehand.create({
        browser,
        logging: { level: "off" },
        model: { modelName: `openai/${process.env.BELL_MODEL ?? "gpt-4.1"}`, apiKey: process.env.OPENAI_API_KEY ?? "" },
      });
      this.browser = browser;
      this.stagehand = stagehand;
    } catch (error) {
      // Save the profile through Notte before closing its browser, including failed initialization.
      if (this.remoteSessionId) await this.releaseRemoteSession();
      await browser.close().catch(() => undefined);
      this.browser = undefined;
      this.stagehand = undefined;
      throw error;
    }
  }

  private async releaseRemoteSession(): Promise<void> {
    const sessionId = this.remoteSessionId ?? this.loadPersistedSessionId();
    if (!sessionId) return;
    this.notte ??= new Notte({ apiKey: process.env.NOTTE_API_KEY });
    try {
      await this.notte.sessions.update(sessionId, { status: "REQUEST_RELEASE" });
    } catch (error) {
      // An already removed session is released. Keep the ID on every other
      // failure so cleanup can retry instead of silently orphaning the browser.
      if (error instanceof Notte.APIError && error.status === 400) {
        // Concurrent cleanup can stop the same browser. Reconcile only a confirmed terminal state.
        const current = await this.notte.sessions.retrieve(sessionId);
        if (current.status === "active" || current.status === "authenticating")
          throw new Error("The hosted browser could not be released. Retry cleanup.");
      } else if (!(error instanceof Notte.APIError) || error.status !== 404)
          throw new Error("The hosted browser could not be released. Retry cleanup.");
    }
    this.remoteSessionId = undefined;
    this.clearPersistedSessionId();
  }

  private loadPersistedSessionId(): string | undefined {
    return this.state.browser.sessionId;
  }

  private persistSessionId(sessionId: string): void {
    this.state.browser.sessionId = sessionId;
  }

  private clearPersistedSessionId(): void {
    delete this.state.browser.sessionId;
  }

  private updateBrowserState(url: string, title: string): BrowserState {
    this.state.browser.url = url;
    this.state.browser.title = title || "Untitled";
    this.state.browser.status = "active";
    return this.state.browser;
  }
}

export function formatRunCode(actions: RunAction[]): string {
  return actions
    .flatMap((item) => {
      switch (item.action) {
        case "goto":
          return [
            `await page.goto(${JSON.stringify(safeActivityUrl(item.url))});`,
            'await page.waitForLoadState("domcontentloaded", 15_000);',
          ];
        case "click":
          return `await page.locator(${JSON.stringify(item.target)}).click();`;
        case "fill":
          return `await page.locator(${JSON.stringify(item.target)}).fill("[value hidden]");`;
        case "type":
          return `await page.locator(${JSON.stringify(item.target)}).type("[value hidden]");`;
        case "press":
          return [
            ...(item.target ? [`await page.locator(${JSON.stringify(item.target)}).click();`] : []),
            'await page.keyPress("[key hidden]");',
          ];
        case "select":
          return `await page.locator(${JSON.stringify(item.target)}).selectOption("[value hidden]");`;
        case "wait":
          return `await page.waitForTimeout(${Math.min(item.milliseconds, 10_000)});`;
      }
    })
    .join("\n");
}

function safeActivityUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    for (const key of url.searchParams.keys()) {
      if (/(?:auth|code|key|otp|password|secret|token)/i.test(key))
        url.searchParams.set(key, "[REDACTED]");
    }
    return url.toString();
  } catch {
    return value;
  }
}

function safePage(value: string): { origin: string; path: string } | undefined {
  try {
    const url = new URL(value);
    return { origin: url.origin, path: url.pathname };
  } catch {
    return undefined;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function browserProvider(): "local" | "notte" {
  if (process.env.STAGEHAND_BROWSER === "local") return "local";
  return "notte";
}

export function notteLaunchOptions(
  _apiKey: string,
  durableContextId?: string,
  proxyLocation?: BrowserProxyLocation,
) {
  const contextId = durableContextId ?? process.env.NOTTE_PROFILE_ID;
  if (personalBrowserEnabled() && contextId) throw new Error("Personal 1Password cannot use a reusable Context.");
  if (proxyLocation?.state) throw new Error("Notte proxies support country and city, not state. Omit state instead of silently changing the requested location.");
  return {
    browser_type: "chrome",
    proxies: proxyLocation ? [{ type: "notte", country: proxyLocation.country.toLowerCase(), ...(proxyLocation.city ? { city: proxyLocation.city } : {}) }] : true,
    idle_timeout_minutes: 30,
    max_duration_minutes: Number(process.env.NOTTE_MAX_DURATION_MINUTES ?? 30),
    ...(contextId ? { profile: { id: contextId, persist: true } } : {}),
  };
}

export function assessSnapshot(tree: string, url: string): { blocked: boolean; signal?: string } {
  const text = `${url}\n${tree}`.toLowerCase();
  if (
    tree.includes("(No visible page text)") &&
    tree.includes("(No visible interactive targets)") &&
    /^https?:\/\//i.test(url)
  ) {
    return { blocked: true, signal: "empty page" };
  }
  const signals: Array<[string, RegExp]> = [
    ["access blocked", /you have been blocked|access (?:is )?denied|request blocked/],
    ["bot challenge", /verify (?:that )?you are human|unusual traffic|robot or human|captcha/],
    ["challenge page", /just a moment|checking your browser|enable javascript and cookies/],
    [
      "navigation error",
      /chrome-error:\/\/chromewebdata|privacy error|your connection is not private/,
    ],
    ["login wall", /\/login(?:\?|\s)|log in to .{1,80}(?:email|phone|continue)/],
    ["not found", /page not found|404 not found|the page you requested (?:was|could not be) found/],
  ];
  const match = signals.find(([, pattern]) => pattern.test(text));
  return match ? { blocked: true, signal: match[0] } : { blocked: false };
}

function originOf(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin : undefined;
  } catch {
    return undefined;
  }
}

function isLiveSourceUrl(url: string): boolean {
  const parsed = new URL(url);
  const host = parsed.hostname;
  if (host.includes("google.")) return /^\/maps\/place\//.test(parsed.pathname);
  return !DISCOVERY_HOSTS.some((item) => host.includes(item));
}

function toBuffer(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (Array.isArray(value) && value.every((item) => typeof item === "number")) {
    return Buffer.from(value);
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.data)) return Buffer.from(record.data as number[]);
    const numericValues = Object.values(record);
    if (numericValues.length && numericValues.every((item) => typeof item === "number")) {
      return Buffer.from(numericValues as number[]);
    }
  }
  throw new Error("Stagehand returned a screenshot in an unsupported byte format.");
}
