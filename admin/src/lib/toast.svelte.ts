import { action, errorMessage } from "./api.ts";
import type { InvokeResult } from "./types.ts";

/**
 * Toasts. Every applied change gets one with Undo for 10 seconds.
 * A "deferred" toast delays a command (discard, skip) until the toast ends,
 * so Undo simply cancels it; pending ones are flushed when the page hides.
 */

export interface Toast {
  id: number;
  message: string;
  tone: "info" | "agent" | "error";
  undo?: () => unknown | Promise<unknown>;
  undoLabel?: string;
  timeout: number;
  paused?: boolean;
  remaining: number;
  started: number;
  timer?: ReturnType<typeof setTimeout>;
  onExpire?: () => void;
}

export const toasts = $state<Toast[]>([]);
let seq = 0;

export const UNDO_MS = 10_000;

function schedule(t: Toast) {
  clearTimeout(t.timer);
  t.started = Date.now();
  t.timer = setTimeout(() => expire(t.id), t.remaining);
}

function expire(id: number) {
  const i = toasts.findIndex((x) => x.id === id);
  if (i < 0) return;
  const [t] = toasts.splice(i, 1);
  t?.onExpire?.();
}

export function dismiss(id: number) {
  expire(id);
}

export function pauseToast(id: number, paused: boolean) {
  const t = toasts.find((x) => x.id === id);
  if (!t) return;
  if (paused && !t.paused) {
    clearTimeout(t.timer);
    t.remaining = Math.max(1500, t.remaining - (Date.now() - t.started));
    t.paused = true;
  } else if (!paused && t.paused) {
    t.paused = false;
    schedule(t);
  }
}

export function toast(message: string, opts: { undo?: Toast["undo"]; undoLabel?: string; tone?: Toast["tone"]; timeout?: number; onExpire?: () => void } = {}) {
  const timeout = opts.timeout ?? (opts.undo ? UNDO_MS : opts.tone === "error" ? 8000 : 5000);
  const t: Toast = { id: ++seq, message, tone: opts.tone ?? "info", undo: opts.undo, undoLabel: opts.undoLabel, timeout, remaining: timeout, started: Date.now(), onExpire: opts.onExpire };
  toasts.push(t);
  if (toasts.length > 4) {
    const old = toasts.shift();
    clearTimeout(old?.timer);
    old?.onExpire?.();
  }
  schedule(toasts[toasts.length - 1]!);
  return t.id;
}

export function toastError(err: unknown) {
  return toast(errorMessage(err), { tone: "error" });
}

export async function runUndo(id: number) {
  const t = toasts.find((x) => x.id === id);
  if (!t?.undo) return;
  const undo = t.undo;
  // Undo cancels a deferred command: drop onExpire before removing.
  t.onExpire = undefined;
  clearTimeout(t.timer);
  toasts.splice(toasts.indexOf(t), 1);
  try {
    await undo();
  } catch (err) {
    toastError(err);
  }
}

/** Undo an applied action by id. */
export async function undoAction(actionId: string) {
  const res = await action<any>("history.undo", { actionId });
  const summary = res.status === "done" ? (res.result as any)?.summary : null;
  toast(summary ? `Undone: ${summary}` : "Undone.");
  return res;
}

/**
 * Standard feedback after any invoke: applied → toast with Undo,
 * proposed → "waiting for approval" toast.
 */
export function announce(res: InvokeResult<any>, opts: { message?: string; afterUndo?: () => void } = {}) {
  if (res.status === "applied") {
    const tone = res.auto ? "agent" : "info";
    toast(opts.message ?? res.summary, {
      tone,
      undo: res.undoable
        ? async () => {
            await undoAction(res.actionId);
            opts.afterUndo?.();
          }
        : undefined,
    });
  } else if (res.status === "proposed") {
    toast(`${opts.message ?? res.summary}. It's waiting on Today for approval.`, { tone: "agent" });
  } else if (res.status === "done" && opts.message) {
    toast(opts.message);
  }
}

/** A command that only runs when its Undo window ends (or the page hides). */
export function deferred(message: string, run: () => Promise<unknown>, onUndo: () => void) {
  let done = false;
  const fire = () => {
    if (done) return;
    done = true;
    pendingFlush.delete(fire);
    run().catch((err) => {
      onUndo();
      toastError(err);
    });
  };
  pendingFlush.add(fire);
  toast(message, {
    undo: () => {
      done = true;
      pendingFlush.delete(fire);
      onUndo();
    },
    onExpire: fire,
  });
}

const pendingFlush = new Set<() => void>();
if (typeof window !== "undefined") {
  addEventListener("pagehide", () => {
    for (const fn of [...pendingFlush]) fn();
  });
}
