<script lang="ts">
  import AskBox from "../components/AskBox.svelte";
  import HealthPanel from "../components/HealthPanel.svelte";
  import ProposalCard from "../components/ProposalCard.svelte";
  import SwipeDeck from "../components/SwipeDeck.svelte";
  import TrustPanel from "../components/TrustPanel.svelte";
  import { action, errorMessage, read } from "../lib/api.ts";
  import { countWord, greeting, longDate, money } from "../lib/format.ts";
  import { isOwner, session, setWaiting } from "../lib/session.svelte.ts";
  import { toast, toastError, undoAction } from "../lib/toast.svelte.ts";
  import type { ActionRow, TodayData } from "../lib/types.ts";

  let data = $state<TodayData | null>(null);
  let error = $state("");
  let hidden = $state<string[]>([]);
  let undoMode = $state(false);
  let phone = $state(typeof matchMedia !== "undefined" && matchMedia("(max-width: 719px)").matches);

  const pending = $derived((data?.pending ?? []).filter((p) => !hidden.includes(p.id)));
  const done = $derived(data?.doneOnItsOwn ?? []);
  const overnight = $derived(new Date().getHours() < 11 && done.some((d) => Date.now() - Date.parse(d.createdAt) < 12 * 3_600_000));

  const status = $derived.by(() => {
    if (!data) return "";
    const n = pending.length;
    const needs = n === 0 ? "Nothing needs you right now." : `${countWord(n)} ${n === 1 ? "thing needs" : "things need"} you.`;
    if (overnight) return `Your team worked overnight. ${needs}`;
    if (done.length && n === 0) return `All caught up. The site handled ${done.length === 1 ? "one thing" : `${done.length} things`} on its own this week.`;
    return n === 0 ? "All caught up. Nothing needs you right now." : needs;
  });

  let loadSeq = 0;
  async function load() {
    const seq = ++loadSeq;
    const site = session.siteId;
    if (!site) return;
    try {
      const d = await read<TodayData>("today.get", {});
      if (seq !== loadSeq || site !== session.siteId) return;
      data = d;
      hidden = [];
      error = "";
      setWaiting(d.pending.length);
    } catch (err) {
      if (seq === loadSeq) error = errorMessage(err);
    }
  }

  $effect(() => {
    void session.siteId;
    data = null;
    load();
  });

  $effect(() => {
    const mq = matchMedia("(max-width: 719px)");
    const onChange = () => (phone = mq.matches);
    mq.addEventListener("change", onChange);
    const onVisible = () => document.visibilityState === "visible" && load();
    document.addEventListener("visibilitychange", onVisible);
    const timer = setInterval(() => document.visibilityState === "visible" && load(), 60_000);
    return () => {
      mq.removeEventListener("change", onChange);
      document.removeEventListener("visibilitychange", onVisible);
      clearInterval(timer);
    };
  });

  function ondecide(id: string) {
    if (!hidden.includes(id)) hidden = [...hidden, id];
    setWaiting(pending.length);
  }
  function onrestore(id: string) {
    hidden = hidden.filter((x) => x !== id);
    setWaiting(pending.length);
  }

  async function undoDone(row: ActionRow) {
    const prev = row.status;
    row.status = "undone";
    try {
      await undoAction(row.id);
      row.undoable = false;
    } catch (err) {
      row.status = prev;
      toastError(err);
    }
  }

  async function setAskMeFirst(on: boolean) {
    if (!data) return;
    const before = data.askMeFirst;
    data.askMeFirst = on;
    try {
      await action("autonomy.ask_me_first", { on });
      toast(on ? "Ask me first is on. Tidequill will ask before every change." : "Ask me first is off. Earned work happens on its own again.", {
        undo: async () => {
          await action("autonomy.ask_me_first", { on: before });
          if (data) data.askMeFirst = before;
        },
      });
    } catch (err) {
      data.askMeFirst = before;
      toastError(err);
    }
  }
</script>

<div class="page today">
  <header class="head">
    <div class="stack" style="gap: 6px">
      <h1 class="page-title">{phone && pending.length ? `${countWord(pending.length)} ${pending.length === 1 ? "thing needs" : "things need"} you` : greeting()}</h1>
      {#if !phone || !pending.length}<p class="lead">{data ? status : " "}</p>{/if}
    </div>
    <p class="date muted">{longDate()}</p>
  </header>

  {#if !phone}<AskBox />{/if}

  {#if error && !data}
    <div class="error-box" role="alert">{error} <button class="linkish" onclick={load}>Try again</button></div>
  {:else if !data}
    <div class="grid" aria-busy="true">
      <div class="stack"><div class="skeleton" style="height: 220px"></div><div class="skeleton" style="height: 180px"></div></div>
      <div class="stack"><div class="skeleton" style="height: 200px"></div><div class="skeleton" style="height: 220px"></div></div>
    </div>
  {:else}
    <div class="grid">
      <section aria-labelledby="needs" class="stack col">
        <h2 id="needs" class="h2" class:sr-only={phone}>Needs you</h2>
        {#if phone && pending.length}
          <SwipeDeck items={pending} {ondecide} {onrestore} />
        {:else}
          {#each pending as p (p.id)}
            <ProposalCard proposal={p} {ondecide} {onrestore} />
          {:else}
            <div class="card empty">
              <h3>You're all caught up</h3>
              <p class="muted">When the team drafts a post or proposes a change, it shows up here. Ask for something to get started.</p>
              <div class="row"><a class="btn" href="/ask?q={encodeURIComponent('Write a post about ')}">Ask for a post</a><a class="btn btn-quiet" href="/live?path=/">Open your site</a></div>
            </div>
          {/each}
        {/if}
      </section>

      <div class="stack col">
        <section class="card card-dark" aria-labelledby="done-h">
          <div class="dh">
            <h2 id="done-h">{overnight ? "Done while you slept" : "Done on its own"}</h2>
            {#if done.some((d) => d.undoable)}
              <button type="button" class="linkish" aria-expanded={undoMode} onclick={() => (undoMode = !undoMode)}>{undoMode ? "Done" : "Undo any"}</button>
            {/if}
          </div>
          {#if done.length}
            <ul class="done">
              {#each done.slice(0, phone ? 4 : 12) as d (d.id)}
                <li class:undone={d.status === "undone"}>
                  <span class="dot" aria-hidden="true"></span>
                  <span class="txt">{d.summary}{#if d.status === "undone"}<span class="sr-only"> (undone)</span> <span class="tag">Undone</span>{/if}</span>
                  {#if undoMode && d.undoable && d.status !== "undone"}
                    <button type="button" class="undo" onclick={() => undoDone(d)} aria-label="Undo: {d.summary}">Undo</button>
                  {/if}
                </li>
              {/each}
            </ul>
          {:else}
            <p class="muted">Nothing yet. As Tidequill earns your trust, it starts doing small jobs on its own and lists them here.</p>
          {/if}
          <p class="spend muted">Agent spend this month: {money(data.spend.thisMonthUsd)} of your {money(data.spend.budgetUsd).replace(/\.00$/, "")} budget</p>
        </section>

        <TrustPanel trust={data.trust} askMeFirst={data.askMeFirst} canChange={isOwner()} onaskmefirst={setAskMeFirst} />
        <HealthPanel health={data.health} />
      </div>
    </div>
  {/if}
</div>

<style>
  .head { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: flex-end; gap: 16px; }
  .lead { font-size: 17px; color: var(--muted); min-height: 1.5em; }
  .date { font-size: 14px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap: 28px; align-items: start; }
  .col { gap: 14px; }
  .h2 { font-size: 18px; font-weight: 700; }
  .empty h3 { font-size: 19px; }
  .dh { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; }
  .done { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 12px; font-size: 15px; line-height: 1.4; }
  .done li { display: flex; gap: 12px; align-items: flex-start; }
  .dot { flex: none; width: 8px; height: 8px; margin-top: 7px; border-radius: 50%; background: var(--gold); }
  .txt { flex: 1; min-width: 0; }
  .undone .txt { color: var(--tide-muted); text-decoration: line-through; }
  .undone .dot { background: var(--tide-muted); }
  .tag { text-decoration: none; display: inline-block; font-size: 12px; color: var(--tide-muted); }
  .undo { background: none; border: 1px solid var(--tide-line); color: var(--gold); font-weight: 700; border-radius: 8px; min-height: 32px; padding: 0 10px; cursor: pointer; flex: none; }
  .spend { font-size: 13px; }
  @media (max-width: 719px) {
    .grid { grid-template-columns: minmax(0, 1fr); gap: 20px; }
    .head { display: block; }
    .date { display: none; }
  }
</style>
