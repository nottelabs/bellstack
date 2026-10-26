import { defineState } from "eve/context";

import type { BrowserProxyLocation, BrowserState } from "../../server/browser/types.js";

export type TaskStatus =
  "idle" | "running" | "waiting_for_user" | "complete" | "failed" | "canceled";
export type BrowserLifecycle =
  "not_started" | "starting" | "active" | "disconnected" | "expired" | "closed" | "error";
export interface DurableTaskRecord {
  version: 1;
  taskId: string;
  sessionId: string;
  title: string;
  status: TaskStatus;
  activeStep?: string;
  waitReason?: "otp" | "approval" | "other";
  browser: {
    sessionId?: string;
    lifecycle: BrowserLifecycle;
    contextId?: string;
    contextStatus?: "draft" | "saved";
    proxyLocation?: BrowserProxyLocation;
    url?: string;
    title?: string;
  };
  processedEventIds: string[];
  createdAt: string;
  updatedAt: string;
}
// Changing this namespace requires retiring conversations from the previous deployment.
export const taskState = defineState<DurableTaskRecord>("bell.notte.v1", () => ({
  version: 1,
  taskId: "",
  sessionId: "",
  title: "New task",
  status: "idle",
  browser: { lifecycle: "not_started" },
  processedEventIds: [],
  createdAt: "",
  updatedAt: "",
}));
export function initializeTask(
  record: DurableTaskRecord,
  sessionId: string,
  at: string,
): DurableTaskRecord {
  return record.sessionId
    ? record
    : { ...record, taskId: sessionId, sessionId, createdAt: at, updatedAt: at };
}
export function applyTaskEvent(
  record: DurableTaskRecord,
  event: {
    type: string;
    data?: Record<string, unknown>;
    meta?: { id?: string; at?: string };
  },
  sessionId: string,
): DurableTaskRecord {
  const id = event.meta?.id,
    at = event.meta?.at ?? new Date().toISOString();
  let next = initializeTask(record, sessionId, at);
  if (id && next.processedEventIds.includes(id)) return next;
  next = {
    ...next,
    processedEventIds: id ? [...next.processedEventIds, id].slice(-2_000) : next.processedEventIds,
    updatedAt: at,
  };
  if (event.type === "message.received") {
    if (next.title === "New task") {
      const text = safeText(event.data?.message ?? event.data?.text);
      if (text) next = { ...next, title: text.slice(0, 64) };
    }
    // A reply after handoff permits a fresh observation of the existing page.
    // It does not assert that the challenge succeeded.
    if (next.status === "waiting_for_user")
      next = { ...next, status: "running", activeStep: "resuming", waitReason: undefined };
  } else if (event.type === "turn.started")
    next = waitingForUser(next)
      ? next
      : {
          ...next,
          status: "running",
          activeStep: "agent turn",
          waitReason: undefined,
        };
  else if (event.type === "step.started")
    next = waitingForUser(next)
      ? next
      : { ...next, status: "running", activeStep: "model step" };
  else if (event.type === "input.requested")
    next = {
      ...next,
      status: "waiting_for_user",
      activeStep: "waiting for user",
      waitReason: classifyWait(event.data),
    };
  else if (event.type === "input.resolved")
    next = {
      ...next,
      status: "running",
      activeStep: "resuming",
      waitReason: undefined,
    };
  else if (event.type === "turn.completed" || event.type === "session.waiting")
    next = waitingForUser(next)
      ? next
      : {
          ...next,
          status: "idle",
          activeStep: undefined,
          waitReason: undefined,
        };
  else if (event.type === "turn.failed" || event.type === "session.failed")
    next = { ...next, status: "failed", activeStep: undefined };
  else if (event.type === "turn.cancelled")
    next = closeTaskBrowser({
      ...next,
      status: "canceled",
      activeStep: undefined,
      waitReason: undefined,
    });
  else if (event.type === "session.completed")
    next = { ...next, status: "complete", activeStep: undefined };
  return next;
}
function waitingForUser(record: DurableTaskRecord): boolean {
  return record.status === "waiting_for_user";
}
export function updateTaskBrowser(
  record: DurableTaskRecord,
  browser: BrowserState,
): DurableTaskRecord {
  const lifecycle: BrowserLifecycle =
    browser.status === "starting"
      ? "starting"
      : browser.status === "active"
        ? "active"
        : browser.status === "error"
          ? "error"
          : browser.sessionId
            ? "closed"
            : "not_started";
  return {
    ...record,
    browser: {
      sessionId: safeId(browser.sessionId),
      lifecycle,
      contextId:
        safeId(browser.contextId) ??
        safeId(record.browser.contextId) ??
        safeId(process.env.NOTTE_PROFILE_ID),
      contextStatus:
        browser.contextStatus ??
        record.browser.contextStatus ??
        (browser.contextId || record.browser.contextId || process.env.NOTTE_PROFILE_ID
          ? "saved"
          : undefined),
      proxyLocation: browser.proxyLocation ?? record.browser.proxyLocation,
      url: safePageUrl(browser.url),
      title: safeText(browser.title),
    },
    updatedAt: new Date().toISOString(),
  };
}

export function setTaskBrowserContext(
  record: DurableTaskRecord,
  contextId: string,
  lifecycle: BrowserLifecycle = "not_started",
  contextStatus: "draft" | "saved" = "saved",
): DurableTaskRecord {
  const safeContextId = safeId(contextId);
  if (!safeContextId) throw new Error("Invalid Context ID.");
  return {
    ...record,
    browser: {
      ...record.browser,
      contextId: safeContextId,
      contextStatus,
      sessionId: undefined,
      lifecycle,
    },
    updatedAt: new Date().toISOString(),
  };
}

export function recordTaskBrowserContext(
  record: DurableTaskRecord,
  contextId: string,
  contextStatus: "draft" | "saved",
): DurableTaskRecord {
  const safeContextId = safeId(contextId);
  if (!safeContextId) throw new Error("Invalid Context ID.");
  return {
    ...record,
    browser: {
      ...record.browser,
      contextId: safeContextId,
      contextStatus,
    },
    updatedAt: new Date().toISOString(),
  };
}

export function closeTaskBrowser(record: DurableTaskRecord): DurableTaskRecord {
  return {
    ...record,
    browser: {
      ...record.browser,
      sessionId: undefined,
      lifecycle: "closed",
    },
    updatedAt: new Date().toISOString(),
  };
}
function classifyWait(data?: Record<string, unknown>): DurableTaskRecord["waitReason"] {
  const value = JSON.stringify(data ?? {}).toLowerCase();
  if (value.includes("otp") || value.includes("code")) return "otp";
  if (value.includes("approval")) return "approval";
  return "other";
}
export function safeText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value
    .replace(/https:\/\/[^\s]*notte\.cc\/[^\s]+/gi, "[redacted live view]")
    .replace(/\b(otp|password|secret|api[_ -]?key)\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .slice(0, 20_000);
}
function safeId(value?: string): string | undefined {
  return value && /^[a-zA-Z0-9_-]{8,128}$/.test(value) ? value : undefined;
}
function safePageUrl(value?: string): string | undefined {
  try {
    if (!value) return;
    const u = new URL(value);
    return `${u.origin}${u.pathname}`;
  } catch {
    return;
  }
}
