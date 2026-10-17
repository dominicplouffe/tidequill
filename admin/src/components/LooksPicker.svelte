<script lang="ts">
  import { fontName, fontStack } from "../lib/format.ts";
  import type { LookOption } from "../lib/types.ts";

  /** Three generated looks as mini previews: palette swatches and "Aa" in the heading font. */
  let { options = [], selected = $bindable(-1), onpick, busy = false, siteName = "Your site" }: { options?: LookOption[]; selected?: number; onpick?: (o: LookOption, i: number) => void; busy?: boolean; siteName?: string } = $props();

  function c(o: LookOption, k: keyof LookOption["tokens"]["colors"], fallback: string) {
    return o.tokens?.colors?.[k] ?? fallback;
  }
</script>

<div class="looks" role="radiogroup" aria-label="Pick a look">
  {#each options as o, i (i)}
    <button
      type="button"
      role="radio"
      aria-checked={selected === i}
      class="look"
      disabled={busy}
      onclick={() => {
        selected = i;
        onpick?.(o, i);
      }}
    >
      <span class="preview" style:background={c(o, "background", "#fff")} style:color={c(o, "text", "#111")} style:border-radius="{Math.min(16, o.tokens?.layout?.radius ?? 8)}px">
        <span class="bar" style:border-color={c(o, "border", "#ddd")}>
          <span style:font-family={fontStack(o.tokens?.fonts?.heading)}>{siteName}</span>
          <span class="nav" style:color={c(o, "muted", "#666")}>Guides · About</span>
        </span>
        <span class="aa" style:font-family={fontStack(o.tokens?.fonts?.heading)}>Aa</span>
        <span class="body" style:font-family={fontStack(o.tokens?.fonts?.body)} style:color={c(o, "muted", "#555")}>The quick brown fox jumps over the lazy dog.</span>
        <span class="cta" style:background={c(o, "accent", "#333")} style:color={c(o, "accentText", "#fff")}>Read more</span>
      </span>
      <span class="swatches" aria-hidden="true">
        {#each ["background", "surface", "text", "accent", "link"] as k (k)}
          <span class="sw" style:background={c(o, k as any, "transparent")}></span>
        {/each}
      </span>
      <span class="name">{o.name}</span>
      <span class="desc">{o.description}</span>
      <span class="fonts">{fontName(o.tokens?.fonts?.heading)}{o.tokens?.fonts?.body && o.tokens.fonts.body !== o.tokens.fonts.heading ? ` + ${fontName(o.tokens.fonts.body)}` : ""}</span>
    </button>
  {/each}
</div>

<style>
  .looks { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; }
  .look { display: flex; flex-direction: column; gap: 10px; text-align: left; padding: 12px; border-radius: 16px; border: 2px solid var(--border); background: var(--surface); cursor: pointer; color: var(--text); transition: border-color var(--t) var(--ease), transform var(--t) var(--ease); }
  .look:hover { border-color: var(--muted); }
  .look[aria-checked="true"] { border-color: var(--gold); box-shadow: 0 0 0 3px var(--gold-soft); }
  .preview { display: flex; flex-direction: column; gap: 8px; padding: 12px; border: 1px solid rgba(0, 0, 0, 0.08); min-height: 168px; overflow: hidden; }
  .bar { display: flex; justify-content: space-between; align-items: baseline; gap: 6px; border-bottom: 1px solid; padding-bottom: 6px; font-size: 14px; }
  .nav { font-size: 10px; }
  .aa { font-size: 40px; line-height: 1; }
  .body { font-size: 12px; line-height: 1.4; }
  .cta { align-self: flex-start; font-size: 11px; font-weight: 600; padding: 5px 9px; border-radius: 6px; margin-top: auto; }
  .swatches { display: flex; gap: 6px; }
  .sw { width: 22px; height: 22px; border-radius: 6px; border: 1px solid var(--border); }
  .name { font-weight: 700; font-size: 16px; }
  .desc { font-size: 14px; color: var(--muted); line-height: 1.4; }
  .fonts { font-size: 12px; color: var(--muted); }
</style>
