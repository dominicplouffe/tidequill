<script lang="ts">
  import { currentSite, session } from "../lib/session.svelte.ts";

  /** "Your site": the live site with the editing overlay (served by the server at /live/<siteId>/<path>). */
  let { query }: { params?: any; query: URLSearchParams } = $props();
  const path = $derived.by(() => {
    const p = query.get("path") || "/";
    return p.startsWith("/") ? p : `/${p}`;
  });
  const src = $derived(session.siteId ? `/live/${session.siteId}${path}` : null);
  const site = $derived(currentSite());
</script>

<div class="live">
  <div class="bar">
    <span class="small muted">Click anything on the page to change it. Changes go through the same undo as everywhere else.</span>
    {#if src}<a class="small" href={src} target="_blank" rel="noreferrer">Open full screen</a>{/if}
    {#if site?.domain}<a class="small" href="https://{site.domain}{path}" target="_blank" rel="noreferrer">View public site</a>{/if}
  </div>
  {#if src}
    {#key src}<iframe title="Your live site, with editing" {src}></iframe>{/key}
  {:else}
    <div class="page"><p class="muted">Pick a site first.</p></div>
  {/if}
</div>

<style>
  .live { display: flex; flex-direction: column; height: 100vh; height: 100dvh; }
  .bar { display: flex; gap: 16px; align-items: center; flex-wrap: wrap; padding: 10px 20px; background: var(--surface); border-bottom: 1px solid var(--border); }
  .bar span { flex: 1; min-width: 200px; }
  iframe { flex: 1; width: 100%; border: 0; background: #fff; }
  @media (max-width: 719px) {
    .live { height: calc(100dvh - 60px - 70px); }
    .bar span { display: none; }
  }
</style>
