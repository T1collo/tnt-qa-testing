"use client";

// Run-page state that has to outlive the page component. Navigating to another page
// unmounts <Run>, which used to drop the live run and everything typed into the form.
//
// - The run itself (results, status, test sheet) lives in a module-level store that the
//   progress stream keeps writing to while the page is away. It is mirrored to
//   sessionStorage so a reload of the tab can pick the run back up; the stream route
//   replays every stored result, so reconnecting loses nothing.
// - Form fields, tokens included, are held in memory only. Tokens are never written to
//   any browser storage; they last until the tab is reloaded or closed.
// Only starting a new run or pressing Clear resets the run.

import { useEffect, useState, useSyncExternalStore, type Dispatch, type SetStateAction } from "react";

export type RunResultVariant = {
  variant: string;
  status: number | null;
  ok: boolean;
  durationMs: number;
  method?: string;
  url?: string;
  /** The document as sent. Absent for a document too large to inline - see documentPath. */
  requestBody?: string;
  responseBody?: string;
  /** Where the run saved the document, read back through /api/runs?id=&document=. */
  documentPath?: string;
};
export type RunResult = {
  testId: string;
  stepKey?: string;
  eventType: string;
  path: string[];
  role?: string;
  variants: RunResultVariant[];
  ok: boolean;
  skipped?: boolean;
  error?: string;
  /** Why it failed, in plain English (set by the runners on every failed result). */
  reason?: string;
  eventId?: string;
  /** Set when several steps travelled in one document (combined per role). */
  batchId?: string;
  batchSize?: number;
  batchEventCount?: number;
};
export type TestSheet = { ok: boolean; path?: string; dateKey?: string; matchedRows?: number; error?: string };
type ProgressEvent =
  | { type: "result"; result: RunResult }
  | { type: "done"; status: string; error?: string; testSheet?: TestSheet }
  // Playwright runs only: expected test count, runner output, and a replay marker.
  | { type: "total"; total: number }
  | { type: "log"; line: string }
  | { type: "reset" };

/** "api" runs go through /api/run or /api/e2e; "ui" runs are the Playwright browser suite. */
export type RunKind = "api" | "ui";
const MAX_LOG_LINES = 400;
const CONNECTION_LOST = "Lost the live connection to the dashboard server.";

export type RunState = {
  kind: RunKind;
  runId: string | null;
  runBaseUrl: string | null;
  running: boolean;
  results: Record<string, RunResult>;
  runStatus: string | null;
  runError: string | null;
  testSheet: TestSheet | null;
  /** Tests the Playwright run will execute, once it has said so. */
  total: number | null;
  logs: string[];
};

const EMPTY: RunState = {
  kind: "api",
  runId: null,
  runBaseUrl: null,
  running: false,
  results: {},
  runStatus: null,
  runError: null,
  testSheet: null,
  total: null,
  logs: [],
};

const STORAGE_KEY = "tnt-dashboard:last-run";

let state: RunState = EMPTY;
let loaded = false;
let source: EventSource | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retries = 0;
const MAX_RETRIES = 8;
const listeners = new Set<() => void>();

function persist() {
  try {
    if (state.runId) sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    else sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage can be unavailable (private mode, quota) - the in-memory copy still works.
  }
}

function setRunState(patch: Partial<RunState>) {
  state = { ...state, ...patch };
  persist();
  listeners.forEach((l) => l());
}

function ensureLoaded() {
  if (loaded || typeof window === "undefined") return;
  loaded = true;
  try {
    const saved = sessionStorage.getItem(STORAGE_KEY);
    if (saved) state = { ...EMPTY, ...(JSON.parse(saved) as RunState) };
  } catch {
    state = EMPTY;
  }
  // A reload interrupted the stream of a run that may still be going - follow it again.
  if (state.running && state.runId) followRun(state.runId, state.kind);
  // A run left "in progress" by an earlier dropped connection is picked up again too.
  else if (state.runId && !state.runStatus) queueMicrotask(reconnect);
}

function subscribe(listener: () => void) {
  ensureLoaded();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot() {
  ensureLoaded();
  return state;
}

const getServerSnapshot = () => EMPTY;

export function useRunState() {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

function closeStream() {
  source?.close();
  source = null;
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
}

function followRun(runId: string, kind: RunKind) {
  closeStream();
  // Query-string form: plain paths keep working even when the dev server loses dynamic routes.
  const id = encodeURIComponent(runId);
  const url = kind === "ui" ? `/api/playwright/stream?runId=${id}` : `/api/run/stream?runId=${id}`;
  const es = new EventSource(url);
  source = es;
  es.onmessage = (msg) => {
    if (source !== es) return;
    const event = JSON.parse(msg.data) as ProgressEvent;
    retries = 0;
    if (state.runError?.startsWith(CONNECTION_LOST)) setRunState({ runError: null });
    if (event.type === "reset") {
      setRunState({ results: {}, logs: [] });
    } else if (event.type === "total") {
      setRunState({ total: event.total });
    } else if (event.type === "log") {
      setRunState({ logs: [...state.logs, event.line].slice(-MAX_LOG_LINES) });
    } else if (event.type === "result") {
      // Journey steps can share a workbook Test ID, so index by stepKey where present.
      setRunState({
        results: { ...state.results, [event.result.stepKey || event.result.testId]: event.result },
      });
    } else if (event.type === "done") {
      // A reconnect's replayed "done" carries no test sheet or error - keep what we had.
      setRunState({
        running: false,
        runStatus: event.status,
        runError: event.error ?? state.runError,
        testSheet: event.testSheet ?? state.testSheet,
      });
      closeStream();
    }
  };
  // A dropped stream is not the end of the run: the server keeps going, and every reconnect
  // replays what already happened. Retry with backoff before giving up.
  es.onerror = () => {
    if (source !== es) return;
    closeStream();
    if (retries >= MAX_RETRIES) {
      setRunState({
        running: false,
        runError: `${CONNECTION_LOST} Press Reconnect once the dashboard server is back.`,
      });
      return;
    }
    retries += 1;
    setRunState({ runError: `${CONNECTION_LOST} Reconnecting (attempt ${retries} of ${MAX_RETRIES})…` });
    retryTimer = setTimeout(() => followRun(runId, kind), Math.min(15000, 1000 * 2 ** (retries - 1)));
  };
}

/** Wipes the previous run before a new one is requested. */
export function beginRun(runBaseUrl: string, kind: RunKind = "api") {
  closeStream();
  setRunState({ ...EMPTY, kind, running: true, runBaseUrl });
}

export function runStarted(runId: string, total: number | null = null) {
  setRunState({ runId, total: total ?? state.total });
  followRun(runId, state.kind);
}

/** Playwright runs can be stopped; the stream then reports them as "stopped". */
export async function stopRun() {
  if (state.kind !== "ui" || !state.runId || !state.running) return;
  try {
    const res = await fetch(`/api/playwright?runId=${encodeURIComponent(state.runId)}`, { method: "DELETE" });
    if (!res.ok) setRunState({ runError: "The run could not be stopped — it may already have finished." });
  } catch {
    setRunState({ runError: "Could not reach the dashboard server to stop the run." });
  }
}

/** Re-attaches to the current run after the live connection was lost. */
export function reconnect() {
  if (!state.runId) return;
  retries = 0;
  setRunState({ running: true, runError: null });
  followRun(state.runId, state.kind);
}

export function runFailedToStart(error: string) {
  setRunState({ running: false, runError: error });
}

export function clearRun() {
  closeStream();
  setRunState(EMPTY);
}

// Form fields: kept in memory across page switches, never written to storage.
const formStore = new Map<string, unknown>();

export function useFormField<T>(key: string, initial: T): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => (formStore.has(key) ? (formStore.get(key) as T) : initial));
  useEffect(() => {
    formStore.set(key, value);
  }, [key, value]);
  return [value, setValue];
}

export function hasFormField(key: string) {
  return formStore.has(key);
}
