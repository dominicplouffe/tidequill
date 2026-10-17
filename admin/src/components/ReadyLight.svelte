<script lang="ts">
  import type { Readiness } from "../lib/types.ts";

  /**
   * The one Ready light. Tap it for the details: Human, SEO and answer-ready
   * scores against the site's minimums, voice match and publish checks.
   */
  let { ready, size = "md", authorName = null }: { ready: Readiness | null | undefined; size?: "sm" | "md"; authorName?: string | null } = $props();
  let open = $state(false);
  let root: HTMLElement | undefined = $state();
  const id = `ready-${Math.random().toString(36).slice(2, 8)}`;

  const rows = $derived(
    ready
      ? [
          { key: "human", label: "Reads human", score: ready.scores.human, min: ready.minimums.human },
          { key: "seo", label: "Search-ready (SEO)", score: ready.scores.seo, min: ready.minimums.seo },
          { key: "aeo", label: "Answer-ready", score: ready.scores.aeo, min: ready.minimums.aeo },
        ]
      : [],
  );
  const lightWord = $derived(ready ? (ready.light === "green" ? "Ready" : ready.light === "amber" ? "Almost ready" : "Not ready") : "Not checked yet");

  function onWindowClick(e: MouseEvent) {
    if (open && root && !e.composedPath().includes(root)) open = false;
  }
  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape" && open) {
      open = false;
      (root?.querySelector("button") as HTMLButtonElement | null)?.focus();
    }
  }
</script>

<svelte:window onclick={onWindowClick} onkeydown={onKey} />

<span class="ready {size}" bind:this={root}>
  <button type="button" class="pill light-{ready?.light ?? 'none'}" aria-expanded={open} aria-controls={id} onclick={() => (open = !open)}>
    <span class="dot" aria-hidden="true"></span>
    <span class="sr-only">{lightWord}: </span>{ready?.headline ?? "Not checked yet"}
  </button>
  {#if open}
    <div class="pop fade-in" id={id} role="region" aria-label="Ready details">
      {#if ready}
        <p class="head"><span class="dot big light-{ready.light}" aria-hidden="true"></span>{lightWord}</p>
        {#each rows as r (r.key)}
          {@const below = r.score < r.min}
          <div class="score">
            <div class="line"><span>{r.label}</span><span class:below><strong>{Math.round(r.score)}</strong> <span class="muted">/ {r.min}+ needed</span></span></div>
            <div class="pbar" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(r.score)} aria-label={r.label}><span style:width="{Math.max(2, Math.min(100, r.score))}%" class:below-bar={below}></span></div>
          </div>
        {/each}
        {#if ready.scores.voice != null}
          <p class="voice">Voice match{authorName ? ` with ${authorName}` : ""}: <strong>{Math.round(ready.scores.voice)}</strong></p>
        {/if}
        {#if ready.checks?.length}
          <ul class="checks">
            {#each ready.checks as c (c.name)}
              <li class:fail={!c.passed}><span aria-hidden="true">{c.passed ? "✓" : c.blocking ? "✕" : "!"}</span> {c.message || c.name}</li>
            {/each}
          </ul>
        {/if}
      {:else}
        <p class="muted">The Ready check runs when the draft is saved.</p>
      {/if}
    </div>
  {/if}
</span>

<style>
  .ready { position: relative; display: inline-flex; }
  .pill { display: inline-flex; align-items: center; gap: 8px; min-height: 36px; padding: 0 12px; border-radius: 999px; border: 1px solid var(--border); background: var(--surface); font-size: 14px; font-weight: 600; cursor: pointer; color: var(--text); }
  .md .pill { min-height: 44px; padding: 0 16px; }
  .sm .pill { min-height: 30px; font-size: 13px; padding: 0 10px; }
  .dot { width: 10px; height: 10px; border-radius: 50%; background: var(--muted); flex: none; }
  .dot.big { width: 14px; height: 14px; }
  .light-green .dot, .dot.light-green { background: var(--light-green); }
  .light-amber .dot, .dot.light-amber { background: var(--light-amber); }
  .light-red .dot, .dot.light-red { background: var(--light-red); }
  .light-amber.pill { border-color: var(--light-amber); }
  .light-red.pill { border-color: var(--warn-line); background: var(--warn-bg); }
  .pop { position: absolute; z-index: 30; top: calc(100% + 8px); left: 0; width: min(340px, 86vw); background: var(--surface); border: 1px solid var(--border); border-radius: 14px; box-shadow: var(--shadow-pop); padding: 16px; display: flex; flex-direction: column; gap: 12px; }
  .head { display: flex; align-items: center; gap: 8px; font-weight: 700; }
  .score { display: flex; flex-direction: column; gap: 6px; font-size: 14px; }
  .line { display: flex; justify-content: space-between; gap: 8px; }
  .below { color: var(--warn); }
  .below-bar { background: var(--warn-line) !important; }
  .voice { font-size: 14px; color: var(--muted); }
  .checks { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; font-size: 13px; color: var(--muted); }
  .checks .fail { color: var(--warn); }
</style>
