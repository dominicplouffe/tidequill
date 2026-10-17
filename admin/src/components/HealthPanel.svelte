<script lang="ts">
  import { compact } from "../lib/format.ts";
  import type { Health } from "../lib/types.ts";

  let { health }: { health: Health | null } = $props();
  const max = $derived(Math.max(1, ...(health?.aiByAssistant ?? []).map((a) => a.visits)));
  const change = $derived(
    health?.visitsChangePct == null ? "" : health.visitsChangePct === 0 ? ", same as last week" : `, ${health.visitsChangePct > 0 ? "up" : "down"} ${Math.abs(Math.round(health.visitsChangePct))}%`,
  );
</script>

<section class="card" aria-labelledby="health-h">
  <h2 id="health-h">How the site is doing</h2>
  {#if !health}
    <p class="muted">Not enough visits yet to say. Numbers show up here after the first readers arrive.</p>
  {:else}
    <div class="stats">
      <div><span class="num">{compact(health.visitsThisWeek)}</span><span class="lbl">Visits this week{change}</span></div>
      <div><span class="num">{compact(health.aiVisitsThisWeek)}</span><span class="lbl">Visits from AI assistants</span></div>
      <div><span class="num">{health.medianLoadMs == null ? "–" : health.medianLoadMs < 1000 ? `${(health.medianLoadMs / 1000).toFixed(1)}s` : `${(health.medianLoadMs / 1000).toFixed(1)}s`}</span><span class="lbl">Median page load</span></div>
    </div>
    {#if health.aiByAssistant.length}
      <ul class="bars" aria-label="AI assistant visits this week">
        {#each health.aiByAssistant as a (a.name)}
          <li>
            <span class="name">{a.name}</span>
            <span class="pbar" aria-hidden="true"><span style:width="{(a.visits / max) * 100}%"></span></span>
            <span class="n">{a.visits}<span class="sr-only"> visits</span></span>
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</section>

<style>
  .stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; }
  .stats div { display: flex; flex-direction: column; gap: 4px; }
  .num { font-size: 28px; font-weight: 700; letter-spacing: -0.02em; }
  .lbl { font-size: 13px; color: var(--muted); }
  .bars { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; font-size: 14px; }
  .bars li { display: flex; align-items: center; gap: 12px; }
  .name { width: 110px; color: var(--muted); flex: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pbar { flex: 1; }
  .n { width: 32px; text-align: right; font-weight: 600; }
</style>
