<script lang="ts">
  import { trustLine } from "../lib/format.ts";
  import type { TrustState } from "../lib/types.ts";
  import Switch from "./Switch.svelte";

  let { trust = [], askMeFirst = false, onaskmefirst, canChange = true }: { trust?: TrustState[]; askMeFirst?: boolean; onaskmefirst?: (on: boolean) => void; canChange?: boolean } = $props();
</script>

<section class="card" aria-labelledby="trust-h">
  <div class="head">
    <h2 id="trust-h">Trust earned so far</h2>
    <Switch label="Ask me first" checked={askMeFirst} disabled={!canChange} onchange={(v) => onaskmefirst?.(v)} />
  </div>
  {#if askMeFirst}
    <p class="hint">Ask me first is on: Tidequill asks before every change, even work it has earned.</p>
  {/if}
  <ul class="list">
    {#each trust as t (t.kind)}
      <li>
        <div class="line">
          <span>{t.label}</span>
          <span class:earned={t.earned && !askMeFirst} class="state">{askMeFirst && t.earned ? "Earned, but asking first" : trustLine(t)}</span>
        </div>
        {#if !t.earned && t.threshold}
          <div class="pbar" role="progressbar" aria-label="{t.label}: {t.clean} of {t.threshold} clean approvals" aria-valuemin={0} aria-valuemax={t.threshold} aria-valuenow={Math.min(t.clean, t.threshold)}>
            <span style:width="{Math.min(100, (t.clean / t.threshold) * 100)}%"></span>
          </div>
        {/if}
      </li>
    {/each}
  </ul>
  <p class="hint">Each change you approve without edits counts. Deleting anything always asks.</p>
</section>

<style>
  .head { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; }
  .list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 12px; font-size: 14px; }
  li { display: flex; flex-direction: column; gap: 6px; }
  .line { display: flex; justify-content: space-between; gap: 12px; }
  .state { color: var(--muted); text-align: right; }
  .earned { color: var(--link); font-weight: 600; }
  .pbar { height: 6px; }
</style>
