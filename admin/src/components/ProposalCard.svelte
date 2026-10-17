<script lang="ts" module>
  import type { DiffItem, ProposalEntry, Readiness } from "../lib/types.ts";

  export interface ProposalLike {
    id: string;
    summary: string;
    detail?: string;
    diff: DiffItem[];
    trustKind: string;
    actionName?: string;
    status?: string;
    entry?: (ProposalEntry & { ready?: Readiness | null }) | null;
    createdAt?: string;
  }

  export function proposalKind(p: ProposalLike): "draft" | "refresh" | "look" | "generic" {
    if (p.trustKind === "look" || p.actionName?.startsWith("look.")) return "look";
    if (p.entry && (p.trustKind === "new_post" || p.entry.status === "draft" || p.entry.status === "scheduled") && p.entry.status !== "published") return "draft";
    if (p.entry && (p.trustKind === "refresh" || p.entry.status === "published")) return "refresh";
    return "generic";
  }
</script>

<script lang="ts">
  import { action } from "../lib/api.ts";
  import { navigate } from "../lib/router.svelte.ts";
  import { plural, slot } from "../lib/format.ts";
  import { canReview } from "../lib/session.svelte.ts";
  import { announce, deferred, toast, toastError } from "../lib/toast.svelte.ts";
  import { wordDiff } from "../lib/diff.ts";
  import DiffView from "./DiffView.svelte";
  import ReadyLight from "./ReadyLight.svelte";
  import Swatches from "./Swatches.svelte";

  let {
    proposal,
    ondecide,
    onrestore,
    onedit,
    showEdit = false,
    headingLevel = 3,
  }: {
    proposal: ProposalLike;
    ondecide?: (id: string, status: "approved" | "discarded", result?: any) => void;
    onrestore?: (id: string) => void;
    onedit?: (p: ProposalLike) => void;
    showEdit?: boolean;
    headingLevel?: 2 | 3;
  } = $props();

  const kind = $derived(proposalKind(proposal));
  let showDiff = $state(false);
  let discarding = $state(false);
  let reason = $state("");
  let busy = $state(false);
  let reasonInput: HTMLInputElement | undefined = $state();
  const reviewer = $derived(canReview());

  const colors = $derived([...new Set(proposal.diff.filter((d) => d.format === "color" && d.after && !/dark/i.test(d.label)).map((d) => d.after!.toLowerCase()))].slice(0, 6));
  const font = $derived(proposal.diff.find((d) => d.format === "font" && d.after)?.after ?? null);

  const bullets = $derived(
    proposal.diff.slice(0, 5).map((d) => {
      if (d.format === "markdown" || (d.before && d.after && (d.before.length > 80 || d.after.length > 80))) {
        const ops = wordDiff(d.before ?? "", d.after ?? "");
        const added = ops.filter((o) => o.type === "ins").reduce((n, o) => n + (o.text.trim() ? o.text.trim().split(/\s+/).length : 0), 0);
        const removed = ops.filter((o) => o.type === "del").reduce((n, o) => n + (o.text.trim() ? o.text.trim().split(/\s+/).length : 0), 0);
        return `${d.label}: ${added ? `${plural(added, "word")} added` : ""}${added && removed ? ", " : ""}${removed ? `${plural(removed, "word")} removed` : ""}${!added && !removed ? "reworded" : ""}`;
      }
      if (!d.before) return `${d.label}: ${d.after}`;
      if (!d.after) return `${d.label}: removed ${d.before}`;
      return `${d.label}: ${d.before} → ${d.after}`;
    }),
  );

  export async function approve() {
    if (busy) return;
    busy = true;
    ondecide?.(proposal.id, "approved");
    try {
      const res = await action<any>("proposals.approve", { id: proposal.id });
      const r: any = res.status === "done" ? res.result : res;
      if (r?.status === "applied") {
        announce({ status: "applied", actionId: r.actionId, summary: r.summary ?? proposal.summary, result: r.result, auto: false, undoable: !!r.undoable });
      } else toast(`Approved: ${proposal.summary}`);
      const trust = r?.trust;
      if (trust?.justEarned) toast(`That's ${trust.threshold} clean approvals. Tidequill now handles ${String(trust.label).toLowerCase()} on its own. "Ask me first" takes it back any time.`, { tone: "agent", timeout: 12000 });
      ondecide?.(proposal.id, "approved", r);
    } catch (err) {
      onrestore?.(proposal.id);
      toastError(err);
    } finally {
      busy = false;
    }
  }

  function startDiscard() {
    discarding = true;
    queueMicrotask(() => reasonInput?.focus());
  }

  function confirmDiscard(e?: Event) {
    e?.preventDefault();
    const why = reason.trim();
    discarding = false;
    ondecide?.(proposal.id, "discarded");
    deferred(
      `Discarded: ${proposal.summary}`,
      () => action("proposals.discard", { id: proposal.id, reason: why || undefined }, { keepalive: true }),
      () => onrestore?.(proposal.id),
    );
  }

  const H = $derived(headingLevel === 2 ? "h2" : "h3");
</script>

<article class="card proposal kind-{kind}" aria-label={proposal.summary} data-proposal={proposal.id}>
  {#if kind === "draft" && proposal.entry}
    {@const e = proposal.entry}
    <div class="card-meta">
      <span>{e.authors?.length ? `New ${e.type === "page" ? "page" : "draft"}, written as ${e.authors.join(" and ")}` : proposal.summary}</span>
      {#if e.publishAt}<span>Scheduled for {slot(e.publishAt)}</span>{/if}
    </div>
    <svelte:element this={H} class="title serif">{e.title}</svelte:element>
    {#if e.excerpt}<p class="excerpt serif">{e.excerpt}</p>{/if}
    <div class="row">
      <ReadyLight ready={e.ready} size="sm" authorName={e.authors?.[0] ?? null} />
      {#if e.words != null}<span class="chip chip-quiet">{plural(e.words, "word")}{e.sources != null ? `, ${plural(e.sources, "source")}` : ""}</span>{/if}
    </div>
  {:else if kind === "refresh" && proposal.entry}
    <div class="card-meta"><span>{proposal.trustKind === "refresh" ? "Refresh of a live post" : "Change to a live page"}</span>{#if proposal.detail}<span>{proposal.detail}</span>{/if}</div>
    <svelte:element this={H} class="title serif">{proposal.entry.title}</svelte:element>
    <ul class="bullets">
      {#if bullets.length}{#each bullets as b, i (i)}<li>{b}</li>{/each}{:else}<li>{proposal.summary}</li>{/if}
    </ul>
  {:else if kind === "look"}
    <div class="card-meta"><span>Look change</span></div>
    <svelte:element this={H} class="title-ui">{proposal.summary}</svelte:element>
    {#if colors.length || font}<Swatches {colors} {font} />{/if}
  {:else}
    <div class="card-meta"><span>{proposal.detail || "Waiting for your OK"}</span></div>
    <svelte:element this={H} class="title-ui">{proposal.summary}</svelte:element>
    {#if proposal.diff.length && proposal.diff.length <= 3 && !showDiff}<DiffView diff={proposal.diff} compact />{/if}
  {/if}

  {#if showDiff}
    <div class="diffbox fade-in"><DiffView diff={proposal.diff} /></div>
  {/if}

  {#if discarding}
    <form class="discard fade-in" onsubmit={confirmDiscard}>
      <label class="field">
        <span>Why not? <span class="muted">(optional, helps the team learn)</span></span>
        <input class="input" bind:this={reasonInput} bind:value={reason} placeholder="e.g. Too salesy, or we covered this already" onkeydown={(e) => e.key === "Escape" && (discarding = false)} />
      </label>
      <div class="row">
        <button class="btn btn-dark btn-sm" type="submit">Discard</button>
        <button class="btn btn-quiet btn-sm" type="button" onclick={() => (discarding = false)}>Keep it</button>
      </div>
    </form>
  {:else if reviewer}
    <div class="row">
      <button type="button" class="btn btn-primary" disabled={busy} onclick={approve}>
        {kind === "refresh" ? "Approve changes" : kind === "look" ? "Apply to site" : "Approve"}
      </button>
      {#if kind === "draft" && proposal.entry}
        <a class="btn" href="/drafts/{proposal.entry.id}">Open draft</a>
      {:else if proposal.diff.length}
        <button type="button" class="btn" aria-expanded={showDiff} onclick={() => (showDiff = !showDiff)}>{showDiff ? "Hide diff" : kind === "look" ? "Preview" : "See diff"}</button>
      {/if}
      {#if showEdit}
        <button type="button" class="btn" onclick={() => (proposal.entry ? navigate(`/drafts/${proposal.entry.id}`) : onedit?.(proposal))}>Edit</button>
      {/if}
      <button type="button" class="btn btn-quiet" onclick={startDiscard}>Discard</button>
    </div>
  {:else}
    <p class="hint">Waiting for an owner or reviewer to approve.</p>
  {/if}
</article>

<style>
  .proposal { transition: opacity var(--t) var(--ease), transform var(--t) var(--ease); }
  .title { font-size: 23px; font-weight: 500; line-height: 1.25; }
  .title-ui { font-size: 19px; font-weight: 700; line-height: 1.3; }
  .excerpt { font-size: 16px; line-height: 1.5; color: var(--text-2); display: -webkit-box; -webkit-line-clamp: 3; line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
  .bullets { margin: 0; padding-left: 18px; display: flex; flex-direction: column; gap: 4px; font-size: 15px; color: var(--text-2); line-height: 1.45; }
  .diffbox { border-top: 1px solid var(--border-soft); padding-top: 4px; }
  .discard { display: flex; flex-direction: column; gap: 10px; }
</style>
