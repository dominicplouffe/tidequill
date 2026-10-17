<script lang="ts">
  import { paragraphDiff, wordDiff, type DiffOp } from "../lib/diff.ts";
  import { fontName, fontStack, isColor } from "../lib/format.ts";
  import type { DiffItem } from "../lib/types.ts";

  let { diff = [], compact = false }: { diff?: DiffItem[]; compact?: boolean } = $props();

  function isLong(d: DiffItem) {
    return (d.format === "markdown" || d.format === "text" || !d.format) && ((d.before?.length ?? 0) > 60 || (d.after?.length ?? 0) > 60 || /\n/.test(`${d.before ?? ""}${d.after ?? ""}`));
  }

  function textOps(d: DiffItem): { changed: boolean; ops: DiffOp[] }[] {
    const a = d.before ?? "";
    const b = d.after ?? "";
    if (d.format === "markdown" || /\n\n/.test(a + b)) return paragraphDiff(a, b);
    return [{ changed: true, ops: wordDiff(a, b) }];
  }

  /** Collapses runs of unchanged paragraphs to keep long diffs readable. */
  function collapse(parts: { changed: boolean; ops: DiffOp[] }[]) {
    const out: ({ kind: "para"; changed: boolean; ops: DiffOp[] } | { kind: "gap"; n: number })[] = [];
    parts.forEach((p, i) => {
      const near = parts[i - 1]?.changed || parts[i + 1]?.changed;
      if (p.changed || near || parts.length <= 3) out.push({ kind: "para", ...p });
      else {
        const last = out[out.length - 1];
        if (last && last.kind === "gap") last.n++;
        else out.push({ kind: "gap", n: 1 });
      }
    });
    return out;
  }
</script>

<div class="diff" class:compact>
  {#each diff as d, i (i)}
    {#if d.format === "color" || (isColor(d.before) && isColor(d.after))}
      <div class="row3">
        <span class="label">{d.label}</span>
        {#if d.before}<span class="before"><span class="sw" style:background={d.before}></span><s>{d.before}</s></span>{:else}<span class="before muted">None</span>{/if}
        {#if d.after}<span class="after"><span class="sw" style:background={d.after}></span>{d.after}</span>{:else}<span class="after muted">Removed</span>{/if}
      </div>
    {:else if d.format === "font"}
      <div class="row3">
        <span class="label">{d.label}</span>
        <span class="before"><s style:font-family={fontStack(d.before)}>{fontName(d.before) || "Default"}</s></span>
        <span class="after font" style:font-family={fontStack(d.after)}>{fontName(d.after) || "Default"} <span class="aa">Aa</span></span>
      </div>
    {:else if d.format === "url" || d.format === "number" || !isLong(d)}
      <div class="row3">
        <span class="label">{d.label}</span>
        {#if d.before != null && d.before !== ""}<span class="before"><s>{d.before}</s></span>{:else}<span class="before muted">None</span>{/if}
        {#if d.after != null && d.after !== ""}<span class="after" class:mono={d.format === "url"}>{d.after}</span>{:else}<span class="after muted">Removed</span>{/if}
      </div>
    {:else}
      <div class="long">
        <span class="label">{d.label}</span>
        <div class="text" class:serif={d.format === "markdown"}>
          {#each collapse(textOps(d)) as part, j (j)}
            {#if part.kind === "gap"}
              <p class="gap">{part.n} unchanged {part.n === 1 ? "paragraph" : "paragraphs"}</p>
            {:else}
              <p class:dim={!part.changed}>{#each part.ops as op, k (k)}{#if op.type === "ins"}<ins>{op.text}</ins>{:else if op.type === "del"}<del>{op.text}</del>{:else}{op.text}{/if}{/each}</p>
            {/if}
          {/each}
        </div>
      </div>
    {/if}
  {/each}
</div>

<style>
  .diff { display: flex; flex-direction: column; font-size: 14px; }
  .row3 { display: grid; grid-template-columns: minmax(90px, 1fr) minmax(0, 1.4fr) minmax(0, 1.4fr); gap: 12px; padding: 10px 0; border-bottom: 1px solid var(--border-soft); align-items: center; }
  .row3:last-child, .long:last-child { border-bottom: 0; }
  .label { color: var(--muted); font-size: 13px; }
  .before { color: var(--del-text); display: flex; align-items: center; gap: 8px; min-width: 0; overflow-wrap: anywhere; }
  .after { color: var(--link); display: flex; align-items: center; gap: 8px; min-width: 0; overflow-wrap: anywhere; font-weight: 600; }
  .mono { font-family: ui-monospace, Menlo, monospace; font-size: 13px; font-weight: 500; }
  .font { font-size: 17px; font-weight: 500; }
  .aa { font-size: 20px; }
  .sw { width: 16px; height: 16px; border-radius: 4px; border: 1px solid var(--border); flex: none; }
  .long { padding: 10px 0; border-bottom: 1px solid var(--border-soft); display: flex; flex-direction: column; gap: 6px; }
  .text { display: flex; flex-direction: column; gap: 10px; line-height: 1.55; color: var(--text-2); white-space: pre-wrap; overflow-wrap: anywhere; }
  .text.serif { font-family: var(--font-content); font-size: 16px; }
  .dim { color: var(--muted); }
  .gap { font-family: var(--font-ui); font-size: 12px; color: var(--muted); font-style: italic; }
  ins { background: var(--ins-bg); color: var(--ins-text); text-decoration: none; border-radius: 3px; padding: 0 1px; }
  del { background: var(--del-bg); color: var(--del-text); border-radius: 3px; padding: 0 1px; }
  .compact .row3 { grid-template-columns: minmax(70px, 0.8fr) 1fr 1fr; padding: 6px 0; }
  @media (max-width: 520px) {
    .row3 { grid-template-columns: 1fr 1fr; }
    .row3 .label { grid-column: 1 / -1; }
  }
</style>
