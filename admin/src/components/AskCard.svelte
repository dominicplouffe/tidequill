<script lang="ts">
  import { money } from "../lib/format.ts";
  import { applyLook } from "../lib/look.ts";
  import { isAdminHref } from "../lib/router.svelte.ts";
  import { toastError, undoAction } from "../lib/toast.svelte.ts";
  import type { Card, RunStatus } from "../lib/types.ts";
  import LooksPicker from "./LooksPicker.svelte";
  import ProposalCard, { type ProposalLike } from "./ProposalCard.svelte";
  import SettingsList from "./SettingsList.svelte";

  let {
    card,
    decided = {},
    runs = {},
    ondecide,
    onrestore,
    onedit,
    compact = false,
  }: {
    card: Card;
    decided?: Record<string, string>;
    runs?: Record<string, RunStatus>;
    ondecide?: (id: string, status: "approved" | "discarded", result?: any) => void;
    onrestore?: (id: string) => void;
    onedit?: (p: ProposalLike) => void;
    compact?: boolean;
  } = $props();

  let undone = $state(false);
  let lookBusy = $state(false);
  let lookPicked = $state(-1);

  async function undo(actionId: string) {
    try {
      await undoAction(actionId);
      undone = true;
    } catch (err) {
      toastError(err);
    }
  }

  const STEP_ICON: Record<string, string> = { pending: "○", running: "◐", done: "✓", failed: "✕" };
  function planSteps(c: Extract<Card, { type: "plan" }>) {
    const run = c.runId ? runs[c.runId] : null;
    if (!run || run.steps.length !== c.steps.length) return c.steps;
    return c.steps.map((s, i) => ({ ...s, status: (["pending", "running", "done", "failed"].includes(run.steps[i]!.status) ? run.steps[i]!.status : s.status) as typeof s.status }));
  }
</script>

{#if card.type === "plan"}
  <article class="card" aria-label="Plan">
    <div class="head">
      <h3>{card.title || `Plan, ${card.steps.length} ${card.steps.length === 1 ? "step" : "steps"}`}</h3>
      <span class="small muted">Estimated cost {money(card.costUsd)}{card.minutes ? `, about ${card.minutes} ${card.minutes === 1 ? "minute" : "minutes"}` : ""}</span>
    </div>
    <ol class="steps">
      {#each planSteps(card) as s, i (i)}
        <li class="step {s.status}"><span class="icon" aria-hidden="true">{STEP_ICON[s.status] ?? "○"}</span><span>{s.text}<span class="sr-only"> ({s.status})</span></span></li>
      {/each}
    </ol>
  </article>
{:else if card.type === "proposal"}
  {@const status = decided[card.proposalId] ?? card.status}
  {#if status === "pending"}
    <ProposalCard proposal={{ id: card.proposalId, summary: card.summary, diff: card.diff, trustKind: card.trustKind, status: card.status, entry: card.entry ?? null }} showEdit {ondecide} {onrestore} {onedit} />
  {:else}
    <div class="resolved"><span class="chip {status === 'approved' ? '' : 'chip-quiet'}">{status === "approved" ? "Approved" : status === "discarded" ? "Discarded" : status}</span><span>{card.summary}</span></div>
  {/if}
{:else if card.type === "applied"}
  <article class="card applied" class:auto={card.auto}>
    <div class="row">
      {#if card.auto}<span class="dot" aria-hidden="true"></span><span class="small strong">Done on its own</span>{:else}<span class="small muted">Done</span>{/if}
    </div>
    <p class:struck={undone}>{card.summary}</p>
    {#if card.undoable}
      {#if undone}<span class="small muted">Undone</span>{:else}<button type="button" class="btn btn-sm" onclick={() => undo(card.actionId)}>Undo</button>{/if}
    {/if}
  </article>
{:else if card.type === "settings"}
  <article class="card"><h3>Your settings</h3><SettingsList sentences={card.sentences} /></article>
{:else if card.type === "results"}
  <article class="card">
    <h3>{card.title}</h3>
    <ul class="results">
      {#each card.items as it, i (i)}
        <li>
          {#if it.href}<a href={it.href} target={isAdminHref(it.href) ? undefined : "_blank"} rel="noreferrer" class:serif={it.kind === "post" || it.kind === "page"}>{it.title}</a>{:else}<span class:serif={it.kind === "post" || it.kind === "page"}>{it.title}</span>{/if}
          {#if it.subtitle}<span class="small muted">{it.subtitle}</span>{/if}
        </li>
      {:else}
        <li class="muted">Nothing found.</li>
      {/each}
    </ul>
  </article>
{:else if card.type === "progress"}
  {@const run = runs[card.runId]}
  {@const st = run?.status ?? card.status}
  <div class="pill {st}" role="status" aria-live="polite">
    <span class="spinner" aria-hidden="true"></span>
    <span>{run?.label ?? card.label}</span>
    <span class="small muted">{st === "done" ? "Done" : st === "failed" ? "Didn't finish" : st === "paused" ? "Paused" : st === "queued" ? "Starting" : "Working"}{run?.costUsd ? `, ${money(run.costUsd)}` : ""}</span>
  </div>
  {#if run?.error}<p class="error-box">{run.error}</p>{/if}
{:else if card.type === "looks"}
  <article class="card">
    <h3>Pick a look</h3>
    <LooksPicker
      options={card.options}
      bind:selected={lookPicked}
      busy={lookBusy}
      onpick={async (o) => {
        lookBusy = true;
        try {
          await applyLook(o);
        } catch (err) {
          toastError(err);
          lookPicked = -1;
        } finally {
          lookBusy = false;
        }
      }}
    />
  </article>
{:else if card.type === "navigate"}
  <a class="btn" href={card.to} target={isAdminHref(card.to) ? undefined : "_blank"} rel="noreferrer">{card.label} →</a>
{:else if card.type === "error"}
  <p class="error-box" role="alert">{card.message}</p>
{/if}

<style>
  .head { display: flex; justify-content: space-between; flex-wrap: wrap; gap: 8px; align-items: baseline; }
  h3 { font-size: 17px; font-weight: 700; }
  .steps { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 8px; font-size: 15px; line-height: 1.45; }
  .step { display: flex; gap: 10px; }
  .icon { width: 18px; flex: none; text-align: center; color: var(--muted); }
  .step.done .icon { color: var(--good); }
  .step.running .icon { color: var(--on-gold); background: var(--gold); border-radius: 50%; height: 18px; line-height: 18px; font-size: 12px; }
  .step.failed .icon { color: var(--bad); }
  .resolved { display: flex; gap: 10px; align-items: center; font-size: 14px; color: var(--muted); padding: 4px 0; }
  .applied { gap: 8px; }
  .applied.auto { border-color: var(--gold); }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--gold); }
  .strong { font-weight: 700; }
  .struck { text-decoration: line-through; color: var(--muted); }
  .results { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
  .results li { display: flex; flex-direction: column; gap: 2px; padding: 10px 0; border-bottom: 1px solid var(--border-soft); }
  .results li:last-child { border-bottom: 0; }
  .results a { color: var(--text); text-decoration: none; font-weight: 600; }
  .results a.serif { font-weight: 500; font-size: 18px; }
  .results a:hover { text-decoration: underline; }
  .pill { display: inline-flex; align-items: center; gap: 10px; align-self: flex-start; padding: 8px 14px; border-radius: 999px; background: var(--surface); border: 1px solid var(--border); font-size: 14px; font-weight: 600; }
  .spinner { width: 12px; height: 12px; border-radius: 50%; background: var(--gold); animation: pulse 1.2s ease-in-out infinite; }
  .done .spinner { background: var(--good); animation: none; }
  .failed .spinner { background: var(--bad); animation: none; }
  .paused .spinner { background: var(--muted); animation: none; }
  @keyframes pulse { 50% { opacity: 0.35; transform: scale(0.8); } }
</style>
