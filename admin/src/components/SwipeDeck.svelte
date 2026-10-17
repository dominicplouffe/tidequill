<script lang="ts">
  import { untrack } from "svelte";
  import { canReview } from "../lib/session.svelte.ts";
  import { toast } from "../lib/toast.svelte.ts";
  import type { Proposal } from "../lib/types.ts";
  import ProposalCard, { proposalKind } from "./ProposalCard.svelte";

  /**
   * Phone approvals: swipe right to approve, left to skip, tap to read.
   * Buttons on the card do the same, for keyboard and screen-reader users.
   */
  let {
    items,
    ondecide,
    onrestore,
  }: { items: Proposal[]; ondecide: (id: string, status: "approved" | "discarded") => void; onrestore: (id: string) => void } = $props();

  let order = $state<string[]>([]);
  $effect(() => {
    const ids = items.map((p) => p.id);
    untrack(() => {
      const kept = order.filter((id) => ids.includes(id));
      const nextOrder = [...kept, ...ids.filter((id) => !kept.includes(id))];
      if (nextOrder.join() !== order.join()) order = nextOrder;
    });
  });
  const sorted = $derived(order.map((id) => items.find((p) => p.id === id)).filter(Boolean) as Proposal[]);
  const top = $derived(sorted[0]);
  const next = $derived(sorted[1]);

  let dx = $state(0);
  let dragging = $state(false);
  let leaving = $state<"left" | "right" | null>(null);
  let startX = 0;
  let startY = 0;
  let pointerId = -1;
  let card: { approve: () => Promise<void> } | undefined = $state();
  const reviewer = $derived(canReview());

  function down(e: PointerEvent) {
    if ((e.target as HTMLElement).closest("button, a, input, textarea")) return;
    pointerId = e.pointerId;
    startX = e.clientX;
    startY = e.clientY;
    dragging = true;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }
  function move(e: PointerEvent) {
    if (!dragging || e.pointerId !== pointerId) return;
    const x = e.clientX - startX;
    if (Math.abs(e.clientY - startY) > Math.abs(x) && Math.abs(x) < 12) return;
    dx = x;
  }
  function up(e: PointerEvent) {
    if (!dragging || e.pointerId !== pointerId) return;
    dragging = false;
    if (dx > 110 && reviewer) swipe("right");
    else if (dx < -110) swipe("left");
    else dx = 0;
  }

  function swipe(dir: "left" | "right") {
    const p = top;
    if (!p) return;
    leaving = dir;
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    setTimeout(
      () => {
        leaving = null;
        dx = 0;
        if (dir === "right") card?.approve();
        else skip(p.id);
      },
      reduce ? 0 : 200,
    );
  }

  function skip(id: string) {
    const before = [...order];
    order = [...order.filter((x) => x !== id), id];
    toast("Skipped. It's still waiting on Today.", { undo: () => (order = before) });
  }
</script>

{#if top}
  <div class="deck">
    <div
      class="swipe"
      class:dragging
      class:leave-left={leaving === "left"}
      class:leave-right={leaving === "right"}
      style:transform={leaving ? undefined : `translateX(${dx}px) rotate(${dx / 24}deg)`}
      onpointerdown={down}
      onpointermove={move}
      onpointerup={up}
      onpointercancel={() => ((dragging = false), (dx = 0))}
      role="group"
      aria-roledescription="approval card"
      aria-label="{sorted.indexOf(top) + 1} of {sorted.length}"
    >
      <span class="hint-approve" style:opacity={Math.max(0, Math.min(1, dx / 110))} aria-hidden="true">Approve</span>
      <span class="hint-skip" style:opacity={Math.max(0, Math.min(1, -dx / 110))} aria-hidden="true">Skip</span>
      {#key top.id}
        <ProposalCard bind:this={card} proposal={top} {ondecide} {onrestore} headingLevel={2} />
      {/key}
      <div class="foot">
        <span>1 of {sorted.length}</span>
        {#if sorted.length > 1}<button type="button" class="linkish" onclick={() => skip(top.id)}>Skip for now</button>{/if}
      </div>
      <p class="hint">Swipe right to approve, left to skip</p>
    </div>
    {#if next}
      <button type="button" class="next" onclick={() => skip(top.id)}>
        <span class="col"><span class="small muted">{proposalKind(next) === "draft" ? "Draft" : proposalKind(next) === "refresh" ? "Refresh" : proposalKind(next) === "look" ? "Look" : "Change"}</span><span class="t">{next.entry?.title ?? next.summary}</span></span>
        <span class="small muted">Next</span>
      </button>
    {/if}
  </div>
{/if}

<style>
  .deck { display: flex; flex-direction: column; gap: 14px; }
  .swipe { position: relative; touch-action: pan-y; transition: transform var(--t) var(--ease), opacity var(--t) var(--ease); }
  .swipe :global(.card) { border-radius: 18px; box-shadow: 0 8px 24px rgba(12, 58, 85, 0.08); }
  .dragging { transition: none; }
  .leave-right { transform: translateX(120%) rotate(8deg); opacity: 0; }
  .leave-left { transform: translateX(-120%) rotate(-8deg); opacity: 0; }
  .hint-approve, .hint-skip { position: absolute; top: 16px; z-index: 2; font-weight: 800; font-size: 14px; padding: 4px 10px; border-radius: 8px; pointer-events: none; }
  .hint-approve { left: 16px; background: var(--gold); color: var(--on-gold); }
  .hint-skip { right: 16px; background: var(--sunken); color: var(--muted); }
  .foot { display: flex; justify-content: space-between; font-size: 13px; color: var(--muted); padding: 8px 4px 0; }
  .hint { text-align: center; font-size: 12px; color: var(--muted); padding-top: 4px; }
  .next { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 16px 18px; border-radius: 18px; border: 1px solid var(--border); background: var(--surface); text-align: left; cursor: pointer; color: var(--text); }
  .col { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
  .t { font-size: 15px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
