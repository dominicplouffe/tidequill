<script lang="ts">
  import { fontStack } from "../lib/format.ts";
  let { colors = [], font = null, size = 36 }: { colors?: string[]; font?: string | null; size?: number } = $props();
</script>

<div class="swatches">
  {#each colors as c, i (i)}
    <span class="sw" style:background={c} style:width="{size}px" style:height="{size}px" title={c}><span class="sr-only">{c}</span></span>
  {/each}
  {#if font}<span class="aa" style:font-family={fontStack(font)} aria-hidden="true">Aa</span>{/if}
</div>

<style>
  .swatches { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .sw { border-radius: 8px; border: 1px solid var(--border); display: inline-block; }
  .aa { font-size: 24px; margin-left: 6px; line-height: 1; }
</style>
