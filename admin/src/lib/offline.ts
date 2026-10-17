import { ApiError, uploadEvidence, type EvidenceInput } from "./api.ts";

/**
 * Captures queue in IndexedDB when the phone is offline (or the upload fails
 * on the network) and are retried when the connection comes back.
 */

export interface QueuedCapture extends EvidenceInput {
  id?: number;
  siteId: string | null;
  createdAt: string;
  attempts: number;
}

const DB = "tidequill";
const STORE = "captures";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function enqueue(item: Omit<QueuedCapture, "attempts" | "createdAt">) {
  await tx("readwrite", (s) => s.add({ ...item, attempts: 0, createdAt: new Date().toISOString() }));
  notify();
}

export async function queued(): Promise<QueuedCapture[]> {
  try {
    return await tx("readonly", (s) => s.getAll() as IDBRequest<QueuedCapture[]>);
  } catch {
    return [];
  }
}

async function remove(id: number) {
  await tx("readwrite", (s) => s.delete(id));
}

async function put(item: QueuedCapture) {
  await tx("readwrite", (s) => s.put(item));
}

const subscribers = new Set<(n: number) => void>();
export function onQueueChange(fn: (n: number) => void) {
  subscribers.add(fn);
  queued().then((q) => fn(q.length));
  return () => subscribers.delete(fn);
}
async function notify() {
  const n = (await queued()).length;
  for (const fn of subscribers) fn(n);
}

let flushing = false;
/** Uploads everything queued. Returns how many went through. */
export async function flush(): Promise<number> {
  if (flushing || !navigator.onLine) return 0;
  flushing = true;
  let sent = 0;
  try {
    for (const item of await queued()) {
      try {
        await uploadEvidence(item, item.siteId);
        await remove(item.id!);
        sent++;
      } catch (err) {
        if (err instanceof ApiError && err.offline) break;
        // A real rejection (e.g. too large): keep it, but stop retrying after 5 tries.
        item.attempts++;
        if (item.attempts >= 5) await remove(item.id!);
        else await put(item);
      }
    }
  } finally {
    flushing = false;
    notify();
  }
  return sent;
}

let installed = false;
export function installOfflineSync(onSent?: (n: number) => void) {
  if (installed) return;
  installed = true;
  const go = () => flush().then((n) => n && onSent?.(n));
  addEventListener("online", go);
  setTimeout(go, 2000);
}
