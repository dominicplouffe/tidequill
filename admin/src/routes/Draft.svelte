<script lang="ts">
  import { onDestroy, tick, untrack } from "svelte";
  import BlockEditor from "../components/BlockEditor.svelte";
  import Editable from "../components/Editable.svelte";
  import ReadyLight from "../components/ReadyLight.svelte";
  import { ApiError, action, errorMessage, mediaUrl, read, uploadMedia } from "../lib/api.ts";
  import { blockId, convertBlock, isTextBlock, type BlockKind } from "../lib/blocks.ts";
  import { rangeFor, selectRange, setCaret } from "../lib/caret.ts";
  import { ago, initials, slot } from "../lib/format.ts";
  import { navigate } from "../lib/router.svelte.ts";
  import { isOwner } from "../lib/session.svelte.ts";
  import { announce, toast, toastError, undoAction } from "../lib/toast.svelte.ts";
  import type { Block, EntryFull, Finding, Readiness } from "../lib/types.ts";

  let { params }: { params: { entryId: string }; query?: URLSearchParams } = $props();
  const entryId = untrack(() => params.entryId);

  let entry = $state<EntryFull | null>(null);
  let blocks = $state<Block[]>([]);
  let title = $state("");
  let ready = $state<Readiness | null>(null);
  let loadError = $state("");
  let saveState = $state<"saved" | "dirty" | "saving" | "error">("saved");
  let saveError = $state("");
  let savedAt = $state<string | null>(null);
  let nextSlotAt = $state<string | null>(null);
  let publishError = $state<string | null>(null);
  let overrideReason = $state("");
  let showOverride = $state(false);
  let publishing = $state(false);
  let media = $state<Record<string, string>>({});
  let now = $state(Date.now());
  let surface: HTMLElement | undefined = $state();
  let fileInput: HTMLInputElement | undefined = $state();
  let pendingImageBlock: string | null = null;
  let activeFinding = $state<number | null>(null);

  // Selection toolbar
  let sel = $state<{ blockId: string; text: string; top: number; left: number } | null>(null);
  let rewriting = $state(false);

  let lastSaved = "";
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let readyTimer: ReturnType<typeof setTimeout> | undefined;
  const clock = setInterval(() => (now = Date.now()), 30_000);

  function snapshot() {
    return JSON.stringify({ title, blocks });
  }

  async function load(opts: { keepFocus?: boolean } = {}) {
    try {
      const e = await read<EntryFull>("posts.get", { id: entryId, includeBlocks: true });
      entry = e;
      title = e.title;
      blocks = (e.blocks ?? []).length ? e.blocks! : [{ id: blockId(), type: "paragraph", text: "" }];
      ready = e.ready;
      lastSaved = JSON.stringify({ title: e.title, blocks: e.blocks ?? [] });
      savedAt = e.modifiedAt ?? e.updatedAt;
      saveState = "saved";
      loadError = "";
      if (!opts.keepFocus) loadSlot();
      loadImages();
    } catch (err) {
      loadError = errorMessage(err);
    }
  }

  /** Admin preview URLs for image blocks (media:<id>). */
  function loadImages() {
    for (const b of blocks) {
      if (b.type !== "image" || !b.src.startsWith("media:") || media[b.id]) continue;
      read<any>("media.get", { id: b.src.slice(6) })
        .then((m) => {
          const url = mediaUrl(m?.media ?? m);
          if (url) media[b.id] = url;
        })
        .catch(() => {});
    }
  }

  async function loadSlot() {
    if (!entry || entry.status !== "draft") return;
    try {
      const r = await action("posts.publish", { id: entryId, at: "next_slot" }, { dryRun: true });
      if (r.status === "dry_run") nextSlotAt = (r.payload as any)?.at ?? null;
    } catch {
      nextSlotAt = null;
    }
  }

  load();

  function changed() {
    saveState = "dirty";
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 900);
  }

  async function save(): Promise<string | null> {
    clearTimeout(saveTimer);
    const snap = snapshot();
    if (snap === lastSaved) {
      saveState = "saved";
      return null;
    }
    saveState = "saving";
    const body = { v: 1, blocks: $state.snapshot(blocks).filter((b) => !(b.type === "image" && !b.src)) };
    try {
      const res = await action("posts.update", { id: entryId, title: title.trim() || "Untitled", body });
      lastSaved = snap;
      savedAt = new Date().toISOString();
      saveState = snapshot() === snap ? "saved" : "dirty";
      if (saveState === "dirty") saveTimer = setTimeout(save, 900);
      if (res.status === "proposed") toast("Your edit to this live post is waiting on Today for approval.", { tone: "agent" });
      refreshReady();
      return res.status === "applied" ? res.actionId : null;
    } catch (err) {
      saveState = "error";
      saveError = errorMessage(err);
      if (err instanceof ApiError && err.offline) saveTimer = setTimeout(save, 5000);
      return null;
    }
  }

  function refreshReady() {
    clearTimeout(readyTimer);
    readyTimer = setTimeout(async () => {
      try {
        const e = await read<EntryFull>("posts.get", { id: entryId });
        ready = e.ready;
      } catch {
        /* keep the last light */
      }
    }, 1200);
  }

  onDestroy(() => {
    clearInterval(clock);
    clearTimeout(readyTimer);
    if (saveState === "dirty") save();
  });

  /** Make a discrete change, save it right away and offer Undo. */
  async function discrete(message: string) {
    const actionId = await save();
    if (actionId)
      toast(message, {
        undo: async () => {
          await undoAction(actionId);
          await load({ keepFocus: true });
        },
      });
  }

  // ---------- Block operations ----------

  async function focusBlock(id: string, offset: number | "end" = 0) {
    await tick();
    const el = surface?.querySelector<HTMLElement>(`[data-block-id="${id}"] [data-editable]`);
    if (el) setCaret(el, offset);
    else surface?.querySelector<HTMLElement>(`[data-block-id="${id}"] input, [data-block-id="${id}"] textarea, [data-block-id="${id}"] button`)?.focus();
  }

  function split(i: number, before: string, after: string) {
    const b = blocks[i]!;
    if (!isTextBlock(b)) return;
    b.text = before;
    const nb: Block = { id: blockId(), type: "paragraph", text: after };
    blocks.splice(i + 1, 0, nb);
    changed();
    focusBlock(nb.id, 0);
  }

  function mergeUp(i: number) {
    const prev = blocks[i - 1];
    const cur = blocks[i]!;
    if (!prev || !isTextBlock(cur)) return;
    if (!isTextBlock(prev)) {
      focusBlock(prev.id, "end");
      return;
    }
    const join = prev.text.length;
    prev.text = prev.text + cur.text;
    blocks.splice(i, 1);
    changed();
    focusBlock(prev.id, join);
  }

  function remove(i: number) {
    const removed = $state.snapshot(blocks[i]!);
    const prev = blocks[i - 1] ?? blocks[i + 1];
    blocks.splice(i, 1);
    if (!blocks.length) blocks.push({ id: blockId(), type: "paragraph", text: "" });
    if (removed.type !== "paragraph" || ("text" in removed && removed.text)) discrete("Removed a block.");
    else changed();
    if (prev) focusBlock(prev.id, "end");
  }

  function move(i: number, dir: -1 | 1) {
    const j = i + dir;
    if (j < 0 || j >= blocks.length) return;
    const [b] = blocks.splice(i, 1);
    blocks.splice(j, 0, b!);
    discrete(dir < 0 ? "Moved the block up." : "Moved the block down.");
    focusBlock(b!.id, "end");
  }

  function convert(i: number, kind: BlockKind) {
    const b = blocks[i]!;
    if (kind === "image") {
      pendingImageBlock = b.id;
      fileInput?.click();
      return;
    }
    blocks[i] = convertBlock($state.snapshot(b) as Block, kind);
    if (kind === "divider") {
      const nb: Block = { id: blockId(), type: "paragraph", text: "" };
      blocks.splice(i + 1, 0, nb);
      focusBlock(nb.id);
    } else focusBlock(b.id, "end");
    changed();
  }

  function exitList(i: number) {
    const nb: Block = { id: blockId(), type: "paragraph", text: "" };
    blocks.splice(i + 1, 0, nb);
    changed();
    focusBlock(nb.id);
  }

  async function onImagePicked(e: Event) {
    const file = (e.currentTarget as HTMLInputElement).files?.[0];
    (e.currentTarget as HTMLInputElement).value = "";
    const targetId = pendingImageBlock;
    pendingImageBlock = null;
    if (!file || !targetId) return;
    const i = blocks.findIndex((b) => b.id === targetId);
    if (i < 0) return;
    const local = URL.createObjectURL(file);
    const placeholder: Block = { id: targetId, type: "image", src: "", alt: "", caption: "" };
    blocks[i] = placeholder;
    media[targetId] = local;
    try {
      const { media: m } = await uploadMedia(file);
      const b = blocks.find((x) => x.id === targetId);
      if (b && b.type === "image") {
        b.src = `media:${m.id}`;
        b.alt = b.alt || m.alt || "";
        const url = mediaUrl(m);
        if (url) media[targetId] = url;
      }
      await discrete("Added the photo.");
    } catch (err) {
      blocks.splice(blocks.findIndex((x) => x.id === targetId), 1);
      toastError(err);
    }
  }

  // ---------- Selection toolbar: Rewrite / Shorter / Ask ----------

  function onSelectionChange() {
    const s = getSelection();
    if (!s || s.isCollapsed || !s.rangeCount || !surface) {
      if (!rewriting) sel = null;
      return;
    }
    const range = s.getRangeAt(0);
    const editable = (range.commonAncestorContainer instanceof Element ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement)?.closest<HTMLElement>("[data-editable]");
    const blockEl = editable?.closest<HTMLElement>("[data-block-id]");
    if (!editable || !blockEl || !surface.contains(blockEl)) {
      sel = null;
      return;
    }
    const rect = range.getBoundingClientRect();
    const host = surface.getBoundingClientRect();
    sel = { blockId: blockEl.dataset.blockId!, text: s.toString(), top: rect.top - host.top - 48, left: Math.max(0, rect.left - host.left + rect.width / 2 - 120) };
  }

  async function rewrite(instruction: string) {
    if (!sel) return;
    const target = sel;
    rewriting = true;
    try {
      await save();
      const block = blocks.find((b) => b.id === target.blockId);
      const whole = block && isTextBlock(block) && block.text.trim() === target.text.trim();
      const scoped = whole ? instruction : `${instruction}, only this part: “${target.text.slice(0, 380)}”`;
      const res = await action("posts.rewrite_block", { id: entryId, blockId: target.blockId, instruction: scoped.slice(0, 500) });
      announce(res, { afterUndo: () => load({ keepFocus: true }) });
      await load({ keepFocus: true });
    } catch (err) {
      toastError(err);
    } finally {
      rewriting = false;
      sel = null;
    }
  }

  function askAbout() {
    if (!sel) return;
    navigate(`/ask?entryId=${encodeURIComponent(entryId)}&blockId=${encodeURIComponent(sel.blockId)}&from=draft&q=${encodeURIComponent(`About “${sel.text.slice(0, 200)}”: `)}`);
  }

  // ---------- Findings ----------

  const findings = $derived((ready?.findings ?? []).filter((f) => f.severity !== "info" || f.suggestion));
  const passedChecks = $derived((ready?.checks ?? []).filter((c) => c.passed).length);
  const AREA: Record<Finding["area"], string> = { human: "Reads human", seo: "SEO", aeo: "Answer-ready", voice: "Voice", check: "Check" };

  function blockTextOf(id?: string): { el: HTMLElement; text: string } | null {
    if (!id) return null;
    const el = surface?.querySelector<HTMLElement>(`[data-block-id="${id}"] [data-editable]`);
    return el ? { el, text: el.textContent ?? "" } : null;
  }

  function findQuote(f: Finding): { el: HTMLElement; start: number; end: number } | null {
    if (!f.quote) return null;
    const candidates = f.blockId ? [blockTextOf(f.blockId)] : [...(surface?.querySelectorAll<HTMLElement>("[data-editable]") ?? [])].map((el) => ({ el, text: el.textContent ?? "" }));
    for (const c of candidates) {
      if (!c) continue;
      const i = c.text.indexOf(f.quote);
      if (i >= 0) return { el: c.el, start: i, end: i + f.quote.length };
    }
    return null;
  }

  // Highlight quoted text in the editor with the CSS Custom Highlight API (no DOM changes).
  $effect(() => {
    void blocks.length;
    void findings;
    const hl = (CSS as any).highlights as Map<string, any> | undefined;
    const Highlight = (window as any).Highlight;
    if (!hl || !Highlight) return;
    tick().then(() => {
      const all = new Highlight();
      const active = new Highlight();
      findings.forEach((f, i) => {
        const q = findQuote(f);
        if (!q) return;
        const r = rangeFor(q.el, q.start, q.end);
        all.add(r);
        if (i === activeFinding) active.add(r);
      });
      hl.set("tq-finding", all);
      hl.set("tq-finding-active", active);
    });
    return () => {
      hl.delete("tq-finding");
      hl.delete("tq-finding-active");
    };
  });

  function editFinding(f: Finding) {
    const q = findQuote(f);
    if (q) {
      q.el.scrollIntoView({ block: "center" });
      selectRange(q.el, q.start, q.end);
    } else if (f.blockId) focusBlock(f.blockId, "end");
  }

  async function acceptFinding(f: Finding) {
    const b = blocks.find((x) => x.id === f.blockId);
    if (!b || !isTextBlock(b) || !f.quote || f.suggestion == null || !b.text.includes(f.quote)) return fixFinding(f);
    b.text = b.text.replace(f.quote, f.suggestion);
    await discrete("Used the suggestion.");
  }

  async function fixFinding(f: Finding) {
    try {
      await save();
      const res = await action("quality.fix", { id: entryId, code: f.code, blockId: f.blockId, quote: f.quote });
      announce(res, { afterUndo: () => load({ keepFocus: true }) });
      await load({ keepFocus: true });
    } catch (err) {
      toastError(err);
    }
  }

  function markMessage(f: Finding): { before: string; quote: string; after: string } | null {
    if (!f.quote) return null;
    const i = f.message.indexOf(f.quote);
    if (i < 0) return null;
    return { before: f.message.slice(0, i), quote: f.quote, after: f.message.slice(i + f.quote.length) };
  }

  // ---------- Publish ----------

  async function publish(at: string | null, override?: string) {
    publishing = true;
    publishError = null;
    try {
      await save();
      const res = await action("posts.publish", { id: entryId, at: at ?? undefined, override });
      announce(res, { afterUndo: () => load() });
      showOverride = false;
      await load();
    } catch (err) {
      publishError = errorMessage(err);
    } finally {
      publishing = false;
    }
  }

  const author = $derived(entry?.authors?.[0] ?? null);
  const statusWord = $derived(entry ? (entry.status === "draft" ? "Draft" : entry.status === "scheduled" ? `Scheduled for ${slot(entry.publishAt)}` : entry.status === "published" ? "Live" : "Off the site") : "");
  const saveWord = $derived(saveState === "saving" ? "saving…" : saveState === "dirty" ? "editing" : saveState === "error" ? "not saved" : savedAt ? `saved ${ago(savedAt, now)}` : "saved");
  const previewHref = $derived(`/api/preview?entryId=${encodeURIComponent(entryId)}`);
</script>

<svelte:document onselectionchange={onSelectionChange} />
<svelte:window onbeforeunload={(e) => { if (saveState === "dirty" || saveState === "saving") { save(); e.preventDefault(); } }} />

<input type="file" accept="image/*" class="sr-only" tabindex="-1" aria-hidden="true" bind:this={fileInput} onchange={onImagePicked} />

{#if loadError}
  <div class="page"><p class="error-box" role="alert">{loadError}</p><a href="/today">Back to Today</a></div>
{:else if !entry}
  <div class="page" aria-busy="true"><div class="skeleton" style="height: 48px"></div><div class="skeleton" style="height: 420px"></div></div>
{:else}
  <div class="draft">
    <header class="bar">
      <div class="who">
        <a href="/today" class="crumb">Today</a><span aria-hidden="true" class="muted">/</span>
        {#if author}
          <a class="author" href="/authors/{author.slug ?? author.id}"><span class="avatar" aria-hidden="true">{initials(author.name)}</span>Written as {author.name}</a>
        {/if}
        <span class="small muted" role="status" aria-live="polite">{statusWord}, {saveWord}</span>
      </div>
      <div class="row">
        <a class="btn" href={previewHref} target="_blank" rel="noreferrer">Preview</a>
        {#if entry.status === "draft"}
          {#if nextSlotAt}<button type="button" class="btn btn-quiet" disabled={publishing} onclick={() => publish(null)}>Publish now</button>{/if}
          <button type="button" class="btn btn-primary" disabled={publishing} onclick={() => publish(nextSlotAt ? "next_slot" : null)}>{nextSlotAt ? `Schedule for ${slot(nextSlotAt)}` : "Publish"}</button>
        {:else if entry.status === "scheduled"}
          <button type="button" class="btn btn-primary" disabled={publishing} onclick={() => publish(null)}>Publish now</button>
        {:else if entry.status === "published"}
          <a class="btn btn-primary" href="/live?path={encodeURIComponent(entry.path)}">See it on the site</a>
        {:else}
          <button type="button" class="btn btn-primary" disabled={publishing} onclick={() => publish(null)}>Publish again</button>
        {/if}
      </div>
    </header>

    {#if publishError}
      <div class="notice error-box" role="alert">
        <p>{publishError}</p>
        {#if isOwner() && ready && !ready.ready}
          {#if showOverride}
            <form class="row" onsubmit={(e) => { e.preventDefault(); if (overrideReason.trim()) publish(entry?.status === "draft" && nextSlotAt ? "next_slot" : null, overrideReason.trim()); }}>
              <label class="sr-only" for="override">Reason to publish anyway</label>
              <input id="override" class="input" style="max-width: 420px" placeholder="Why publish it anyway? (logged)" bind:value={overrideReason} />
              <button class="btn btn-dark btn-sm" type="submit">Publish anyway</button>
            </form>
          {:else}
            <button type="button" class="linkish" onclick={() => (showOverride = true)}>Publish anyway with a reason</button>
          {/if}
        {/if}
      </div>
    {/if}
    {#if saveState === "error"}
      <div class="notice error-box" role="alert">{saveError} <button class="linkish" onclick={save}>Try again</button></div>
    {/if}

    <div class="readybar">
      <ReadyLight {ready} authorName={author?.name ?? null} />
      {#if ready?.scores.voice != null && author}<span class="small muted">Voice match with {author.name.split(" ")[0]}: {Math.round(ready.scores.voice)}</span>{/if}
    </div>

    <div class="body">
      <article class="surface" bind:this={surface}>
        <div class="paper serif">
          <Editable bind:value={title} tag="h1" label="Title" class="title" placeholder="Title" multiline={false} oninput={changed} onkeydown={(e) => { if (e.key === "Enter") { e.preventDefault(); if (blocks[0]) focusBlock(blocks[0].id, 0); } }} />
          {#each blocks as b, i (b.id)}
            <BlockEditor
              bind:block={blocks[i]!}
              first={i === 0}
              last={i === blocks.length - 1}
              imageUrl={b.type === "image" ? media[b.id] ?? null : null}
              onchange={changed}
              onsplit={(before, after) => split(i, before, after)}
              onmergeup={() => mergeUp(i)}
              onconvert={(k) => convert(i, k)}
              ondelete={() => remove(i)}
              onmove={(d) => move(i, d)}
              onexitlist={() => exitList(i)}
            />
          {/each}
          <p class="hint ui">Type / for blocks, or select text to rewrite it.</p>
        </div>

        {#if sel}
          <div class="seltools fade-in" role="toolbar" aria-label="Selected text" style:top="{sel.top}px" style:left="{sel.left}px">
            <button type="button" disabled={rewriting} onmousedown={(e) => e.preventDefault()} onclick={() => rewrite(author ? `Rewrite this in ${author.name}'s voice` : "Rewrite this")}>{rewriting ? "Rewriting…" : "Rewrite"}</button>
            <button type="button" disabled={rewriting} onmousedown={(e) => e.preventDefault()} onclick={() => rewrite("Make this shorter")}>Shorter</button>
            <button type="button" disabled={rewriting} onmousedown={(e) => e.preventDefault()} onclick={askAbout}>Ask</button>
          </div>
        {/if}
      </article>

      <aside class="fixes" aria-labelledby="fixes-h">
        <h2 id="fixes-h">{findings.length ? `${findings.length} ${findings.length === 1 ? "fix" : "fixes"} suggested` : ready?.ready ? "Ready to publish" : "Fixes"}</h2>
        {#if !ready}
          <p class="muted small">The Ready check runs after the first save.</p>
        {:else if !findings.length}
          <p class="muted small">Nothing to fix. {ready.headline}</p>
        {/if}
        {#each findings as f, i (f.code + (f.blockId ?? "") + i)}
          <div class="fix card" role="group" aria-label={AREA[f.area]} onmouseenter={() => (activeFinding = i)} onmouseleave={() => (activeFinding = null)} onfocusin={() => (activeFinding = i)}>
            <span class="area area-{f.area}">{AREA[f.area]}{f.severity === "error" ? ", needed to publish" : ""}</span>
            {#if markMessage(f)}
              {@const m = markMessage(f)!}
              <p>{m.before}<mark>{m.quote}</mark>{m.after}</p>
            {:else}
              <p>{f.message}</p>
              {#if f.quote}<p class="quote"><mark>{f.quote}</mark></p>{/if}
            {/if}
            {#if f.suggestion}<p class="suggestion serif">{f.suggestion}</p>{/if}
            <div class="row">
              {#if f.suggestion && f.quote}
                <button type="button" class="btn btn-sm btn-primary" onclick={() => acceptFinding(f)}>Accept</button>
              {:else}
                <button type="button" class="btn btn-sm btn-primary" onclick={() => fixFinding(f)}>Fix it</button>
              {/if}
              {#if f.blockId || f.quote}<button type="button" class="btn btn-sm" onclick={() => editFinding(f)}>Edit</button>{/if}
              {#if author && f.area === "human"}<a class="btn btn-sm btn-quiet" href="/ask?entryId={entryId}&blockId={f.blockId ?? ''}&q={encodeURIComponent(`Ask ${author.name.split(' ')[0]} for a first-hand detail: ${f.message}`)}">Ask {author.name.split(" ")[0]}</a>{/if}
            </div>
          </div>
        {/each}
        {#if ready?.checks?.length}
          <details class="card checks">
            <summary>Checks passed, {passedChecks} of {ready.checks.length}</summary>
            <ul>{#each ready.checks as c (c.name)}<li class:fail={!c.passed}>{c.passed ? "✓" : "✕"} {c.message || c.name}</li>{/each}</ul>
          </details>
        {/if}
        <a class="small" href="/ask?entryId={entryId}&from=draft">Ask about this draft</a>
      </aside>
    </div>
  </div>
{/if}

<style>
  .draft { display: flex; flex-direction: column; min-height: 100vh; }
  .bar { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 12px; padding: 14px 32px; background: var(--surface); border-bottom: 1px solid var(--border); position: sticky; top: 0; z-index: 15; }
  .who { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; min-width: 0; }
  .crumb { color: var(--muted); text-decoration: none; font-size: 14px; }
  .author { display: flex; align-items: center; gap: 8px; font-size: 14px; font-weight: 600; color: var(--text); text-decoration: none; }
  .avatar { width: 26px; height: 26px; border-radius: 50%; background: var(--ocean); color: #fff; font-size: 11px; display: flex; align-items: center; justify-content: center; }
  .notice { margin: 12px 32px 0; display: flex; flex-direction: column; align-items: flex-start; gap: 8px; }
  .readybar { display: flex; flex-wrap: wrap; align-items: center; gap: 16px; padding: 12px 32px; background: var(--surface); border-bottom: 1px solid var(--border); }
  .body { display: grid; grid-template-columns: minmax(0, 3fr) minmax(280px, 1fr); flex: 1; }
  .surface { position: relative; padding: 48px 56px 96px; background: var(--surface); }
  .paper { max-width: 680px; margin: 0 auto; display: flex; flex-direction: column; gap: 20px; color: var(--text); }
  .paper :global(.title) { font-size: 40px; font-weight: 500; line-height: 1.15; letter-spacing: -0.01em; margin: 0; }
  .hint.ui { font-family: var(--font-ui); font-size: 14px; color: var(--muted); }
  .seltools { position: absolute; z-index: 20; display: flex; gap: 2px; background: var(--tide); border-radius: 10px; padding: 4px; box-shadow: var(--shadow-pop); }
  .seltools button { background: none; border: 0; color: #fff; font-weight: 600; font-size: 14px; min-height: 36px; padding: 0 12px; border-radius: 7px; cursor: pointer; }
  .seltools button:hover, .seltools button:focus-visible { background: var(--tide-hi); }
  .seltools button:first-child { color: var(--gold); }
  .fixes { padding: 28px 24px; background: var(--bg); border-left: 1px solid var(--border); display: flex; flex-direction: column; gap: 16px; }
  .fixes h2 { font-size: 16px; font-weight: 700; }
  .fix { padding: 16px; gap: 10px; border-radius: 14px; }
  .fix p { font-size: 15px; line-height: 1.45; }
  .area { font-size: 12px; font-weight: 700; color: var(--warn); }
  .area-human, .area-voice { color: var(--link); }
  .suggestion { font-size: 15px !important; line-height: 1.5; color: var(--text-2); background: var(--surface-2); border-radius: 8px; padding: 10px; }
  .checks { padding: 14px 16px; font-size: 14px; }
  .checks summary { cursor: pointer; font-weight: 600; }
  .checks ul { margin: 8px 0 0; padding: 0; list-style: none; color: var(--muted); display: flex; flex-direction: column; gap: 4px; }
  .checks .fail { color: var(--warn); }
  :global(::highlight(tq-finding)) { background-color: var(--del-bg); text-decoration: underline wavy var(--warn-line); }
  :global(::highlight(tq-finding-active)) { background-color: var(--gold-soft); }
  @media (max-width: 1000px) {
    .body { grid-template-columns: minmax(0, 1fr); }
    .fixes { border-left: 0; border-top: 1px solid var(--border); }
  }
  @media (max-width: 719px) {
    .bar { padding: 10px 16px; position: static; }
    .readybar, .notice { padding-left: 16px; padding-right: 16px; margin-left: 0; margin-right: 0; }
    .surface { padding: 24px 16px 64px; }
    .paper :global(.title) { font-size: 30px; }
  }
</style>
