import type { Block, Doc } from "../content/blocks.ts";
import { blockToMarkdown } from "../content/markdown.ts";
import { findEntry, getEntry, saveEntry, type Entry } from "../core/entries.ts";
import { TqError } from "../core/errors.ts";
import { runEntrySaved } from "../core/hooks.ts";
import type { Applied, DiffItem, Prepared } from "../core/registry.ts";
import type { Ctx, TrustKind } from "../core/types.ts";

/**
 * Block-level patches for small automatic edits (fixes, links, fact tokens).
 * A patch touches only the blocks it changes, so several proposals on the same
 * post can be approved in any order; it refuses to apply if a block it changes
 * was edited since, and its undo reverts only those blocks.
 */

export type BlockOp = { op: "replace"; id: string; block: Block } | { op: "remove"; id: string } | { op: "insert"; afterId: string | null; block: Block };

type Fields = Partial<Pick<Entry, "title" | "description" | "slug">>;

export interface EntryPatch {
  entryId: string;
  ops: BlockOp[];
  /** JSON of each block the patch changes, as it was when prepared. */
  expect: Record<string, string>;
  fields?: Fields;
  /** Field values when prepared (checked on apply, restored on undo). */
  previousFields?: Fields;
}

export interface PatchUndo {
  entryId: string;
  ops: BlockOp[];
  fields?: Fields;
}

export function diffBlocks(before: Doc, after: Doc): { ops: BlockOp[]; expect: Record<string, string> } {
  const ops: BlockOp[] = [];
  const expect: Record<string, string> = {};
  const old = new Map(before.blocks.map((b) => [b.id, b]));
  const kept = new Set<string>();
  let prev: string | null = null;
  for (const b of after.blocks) {
    const o = old.get(b.id);
    if (o) {
      kept.add(b.id);
      if (JSON.stringify(o) !== JSON.stringify(b)) {
        ops.push({ op: "replace", id: b.id, block: b });
        expect[b.id] = JSON.stringify(o);
      }
    } else ops.push({ op: "insert", afterId: prev, block: b });
    prev = b.id;
  }
  for (const b of before.blocks) {
    if (!kept.has(b.id)) {
      ops.push({ op: "remove", id: b.id });
      expect[b.id] = JSON.stringify(b);
    }
  }
  return { ops, expect };
}

export function applyOps(d: Doc, ops: BlockOp[]): Doc {
  const blocks = [...d.blocks];
  for (const op of ops) {
    if (op.op === "replace") {
      const i = blocks.findIndex((b) => b.id === op.id);
      if (i >= 0) blocks[i] = op.block;
    } else if (op.op === "remove") {
      const i = blocks.findIndex((b) => b.id === op.id);
      if (i >= 0) blocks.splice(i, 1);
    } else {
      if (blocks.some((b) => b.id === op.block.id)) continue;
      if (op.afterId === null) blocks.unshift(op.block);
      else {
        const i = blocks.findIndex((b) => b.id === op.afterId);
        blocks.splice(i < 0 ? blocks.length : i + 1, 0, op.block);
      }
    }
  }
  return { v: 1, blocks };
}

/** Ops that undo `ops` when applied to the doc they produced from `before`. */
export function invertOps(before: Doc, ops: BlockOp[]): BlockOp[] {
  const out: BlockOp[] = [];
  for (const op of ops) {
    if (op.op === "replace") {
      const o = before.blocks.find((b) => b.id === op.id);
      if (o) out.push({ op: "replace", id: op.id, block: o });
    } else if (op.op === "insert") out.push({ op: "remove", id: op.block.id });
    else {
      const i = before.blocks.findIndex((b) => b.id === op.id);
      if (i >= 0) out.push({ op: "insert", afterId: i > 0 ? before.blocks[i - 1]!.id : null, block: before.blocks[i]! });
    }
  }
  return out;
}

/** Diff items showing only the blocks that change. */
export function blockDiff(before: Doc, ops: BlockOp[], fields?: Fields, previous?: Fields): DiffItem[] {
  const diff: DiffItem[] = [];
  if (fields?.title !== undefined) diff.push({ label: "Title", before: previous?.title ?? null, after: fields.title });
  if (fields?.description !== undefined) diff.push({ label: "Description", before: previous?.description || null, after: fields.description });
  if (fields?.slug !== undefined) diff.push({ label: "Address", before: previous?.slug ? `/${previous.slug}/` : null, after: `/${fields.slug}/`, format: "url" });
  for (const op of ops) {
    if (op.op === "replace") {
      const o = before.blocks.find((b) => b.id === op.id);
      diff.push({ label: "Text", before: o ? blockToMarkdown(o) : null, after: blockToMarkdown(op.block), format: "markdown" });
    } else if (op.op === "insert") diff.push({ label: "Text", before: null, after: blockToMarkdown(op.block), format: "markdown" });
    else {
      const o = before.blocks.find((b) => b.id === op.id);
      diff.push({ label: "Text", before: o ? blockToMarkdown(o) : null, after: null, format: "markdown" });
    }
  }
  return diff;
}

export function isLive(e: Entry): boolean {
  return e.status === "published" || e.status === "scheduled";
}

export interface PatchOptions {
  summary: string;
  detail?: string;
  /** Trust kind when the entry is live; edits to drafts are invisible. */
  liveTrust: TrustKind;
  fields?: Fields;
  /** Extra diff items shown before the block diff. */
  extraDiff?: DiffItem[];
}

/** Prepares a patch that turns `before.body` into `after` (and sets `fields`). */
export function preparePatch(before: Entry, after: Doc, opts: PatchOptions): Prepared<EntryPatch> {
  const { ops, expect } = diffBlocks(before.body, after);
  const fields = opts.fields && Object.keys(opts.fields).length ? opts.fields : undefined;
  const previousFields = fields ? (Object.fromEntries(Object.keys(fields).map((k) => [k, before[k as keyof Fields]])) as Fields) : undefined;
  if (!ops.length && !fields) throw new TqError("invalid", `Nothing to change in “${before.title}”; it already looks like that.`);
  return {
    summary: opts.summary,
    detail: opts.detail,
    diff: [...(opts.extraDiff ?? []), ...blockDiff(before.body, ops, fields, previousFields)],
    entryId: before.id,
    invisible: !isLive(before),
    trustKind: isLive(before) ? opts.liveTrust : "new_post",
    payload: { entryId: before.id, ops, expect, fields, previousFields },
  };
}

async function save(ctx: Ctx & { actionId: string }, current: Entry, next: Entry) {
  saveEntry(ctx.db, next, ctx.actor, ctx.actionId);
  await runEntrySaved(ctx, next);
  ctx.services.emit({ type: "entry.changed", siteId: next.siteId, entryId: next.id });
  if (current.status === "published" || next.status === "published") ctx.services.enqueueBuild(next.siteId, "edit", [next.id]);
}

export async function applyPatch(ctx: Ctx & { actionId: string }, p: EntryPatch): Promise<Applied<{ id: string; title: string }, PatchUndo>> {
  const current = getEntry(ctx.db, ctx.siteId!, p.entryId);
  const stale = Object.entries(p.expect).some(([bid, json]) => {
    const b = current.body.blocks.find((x) => x.id === bid);
    return !b || JSON.stringify(b) !== json;
  });
  const fieldsMoved = p.previousFields && Object.entries(p.previousFields).some(([k, v]) => current[k as keyof Fields] !== v);
  if (stale || fieldsMoved) throw new TqError("conflict", `“${current.title}” changed after this was suggested; ask me to suggest it again on the latest version.`);
  const body = applyOps(current.body, p.ops);
  const next: Entry = { ...current, ...(p.fields ?? {}), body };
  await save(ctx, current, next);
  return {
    result: { id: current.id, title: next.title },
    undo: { entryId: current.id, ops: invertOps(current.body, p.ops), fields: p.previousFields },
  };
}

export async function undoPatch(ctx: Ctx & { actionId: string }, u: PatchUndo) {
  const current = findEntry(ctx.db, ctx.siteId!, u.entryId);
  if (!current) return;
  const next: Entry = { ...current, ...(u.fields ?? {}), body: applyOps(current.body, u.ops) };
  await save(ctx, current, next);
}

/** Replaces the first unprotected occurrence of `find` in one block's inline text. */
export function replaceInBlock(d: Doc, blockId: string, find: string, replacement: string, findIndex: (raw: string, needle: string) => number): Doc | null {
  let done = false;
  const blocks = d.blocks.map((b): Block => {
    if (done || b.id !== blockId) return b;
    const swap = (t: string) => {
      if (done) return t;
      const at = findIndex(t, find);
      if (at < 0) return t;
      done = true;
      return t.slice(0, at) + replacement + t.slice(at + find.length);
    };
    switch (b.type) {
      case "paragraph":
      case "heading":
      case "answer":
      case "callout":
      case "evidence":
      case "quote":
        return { ...b, text: swap(b.text) };
      case "list":
        return { ...b, items: b.items.map(swap) };
      case "faq":
        return { ...b, items: b.items.map((i) => ({ q: swap(i.q), a: swap(i.a) })) };
      case "table":
        return { ...b, header: b.header.map(swap), rows: b.rows.map((r) => r.map(swap)) };
      case "image":
        return b.caption ? { ...b, caption: swap(b.caption) } : b;
      default:
        return b;
    }
  });
  return done ? { v: 1, blocks } : null;
}
