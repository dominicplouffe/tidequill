<script lang="ts">
  import { untrack } from "svelte";
  import { action, errorMessage, read } from "../lib/api.ts";
  import { isOwner } from "../lib/session.svelte.ts";
  import { announce, toast, toastError } from "../lib/toast.svelte.ts";
  import Switch from "./Switch.svelte";

  /**
   * Every setting is a sentence. With `controls`, each sentence carries a small
   * inline control that calls settings.update (Ask me first has its own command).
   */
  type Sentence = { key: string; sentence: string; say: string };
  let { sentences: initial = null, controls = false }: { sentences?: Sentence[] | null; controls?: boolean } = $props();

  let sentences = $state<Sentence[]>(untrack(() => initial ?? []));
  let settings = $state<any>(null);
  let error = $state("");
  const owner = $derived(isOwner());
  const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const zones: string[] = (() => {
    try {
      return (Intl as any).supportedValuesOf?.("timeZone") ?? [];
    } catch {
      return [];
    }
  })();

  async function load() {
    try {
      const r = await read<{ sentences: Sentence[]; settings: any }>("settings.show", {});
      sentences = r.sentences;
      settings = r.settings;
      error = "";
    } catch (err) {
      error = errorMessage(err);
    }
  }
  $effect(() => {
    if (controls || !initial) load();
  });

  async function update(patch: Record<string, unknown>) {
    try {
      const res = await action("settings.update", patch);
      announce(res, { afterUndo: load });
      await load();
    } catch (err) {
      toastError(err);
      await load();
    }
  }

  async function askMeFirst(on: boolean) {
    try {
      await action("autonomy.ask_me_first", { on });
      toast(on ? "Ask me first is on." : "Ask me first is off.", {
        undo: async () => {
          await action("autonomy.ask_me_first", { on: !on });
          await load();
        },
      });
      await load();
    } catch (err) {
      toastError(err);
    }
  }

  function toggleDay(d: number) {
    const days: number[] = settings.cadence.days.includes(d) ? settings.cadence.days.filter((x: number) => x !== d) : [...settings.cadence.days, d].sort();
    update({ cadence: { ...settings.cadence, days } });
  }

  function numberFrom(e: Event) {
    const n = Number((e.currentTarget as HTMLInputElement).value);
    return Number.isFinite(n) ? n : null;
  }
</script>

{#if error}<p class="error-box">{error}</p>{/if}
<ul class="sentences">
  {#each sentences as s (s.key)}
    <li>
      <p class="sentence">{s.sentence}</p>
      <p class="say">Say {s.say}</p>
      {#if controls && settings}
        <div class="control">
          {#if s.key === "askMeFirst"}
            <Switch label="Ask me first" checked={settings.askMeFirst} disabled={!owner} onchange={askMeFirst} />
          {:else if s.key === "monthlyBudgetUsd"}
            <label class="inline">Budget $<input class="input num" type="number" min="0" step="5" value={settings.monthlyBudgetUsd} disabled={!owner} onchange={(e) => { const n = numberFrom(e); if (n != null) update({ monthlyBudgetUsd: n }); }} /> a month</label>
          {:else if s.key === "cadence"}
            <div class="row" role="group" aria-label="Publishing days">
              {#each DAYS as d, i (d)}
                <button type="button" class="day" aria-pressed={settings.cadence.days.includes(i)} disabled={!owner} onclick={() => toggleDay(i)}>{d}</button>
              {/each}
            </div>
            <div class="row">
              <label class="inline">at <input class="input time" type="time" value={settings.cadence.time} disabled={!owner} onchange={(e) => update({ cadence: { ...settings.cadence, time: (e.currentTarget as HTMLInputElement).value } })} /></label>
              <label class="inline">time zone
                <input class="input tz" list="tq-zones" value={settings.timezone} disabled={!owner} onchange={(e) => update({ timezone: (e.currentTarget as HTMLInputElement).value.trim() })} />
              </label>
              <datalist id="tq-zones">{#each zones as z (z)}<option value={z}></option>{/each}</datalist>
            </div>
          {:else if s.key === "readyMinimums"}
            <div class="row">
              {#each [["human", "Reads human"], ["seo", "Search-ready"], ["aeo", "Answer-ready"]] as [k, label] (k)}
                <label class="inline">{label} <input class="input num" type="number" min="0" max="100" value={settings.readyMinimums[k]} disabled={!owner} onchange={(e) => { const n = numberFrom(e); if (n != null) update({ readyMinimums: { [k]: n } }); }} /></label>
              {/each}
            </div>
          {:else if s.key === "aiDisclosure"}
            <Switch label="Show the AI line" checked={settings.aiDisclosure} disabled={!owner} onchange={(v) => update({ aiDisclosure: v })} />
          {:else if s.key === "allowTrainingCrawlers"}
            <Switch label="Allow AI training" checked={settings.allowTrainingCrawlers} disabled={!owner} onchange={(v) => update({ allowTrainingCrawlers: v })} />
          {:else if s.key === "domains"}
            <a href="/settings#domains">Manage domains</a>
          {:else if s.key === "trust"}
            <a href="/today">See trust earned</a>
          {/if}
        </div>
      {/if}
    </li>
  {/each}
</ul>
{#if !controls}<a class="small" href="/settings">Change these in settings</a>{/if}

<style>
  .sentences { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
  li { padding: 14px 0; border-bottom: 1px solid var(--border-soft); display: flex; flex-direction: column; gap: 6px; }
  li:last-child { border-bottom: 0; }
  .sentence { font-size: 16px; line-height: 1.45; }
  .say { font-size: 13px; color: var(--muted); }
  .control { display: flex; flex-direction: column; gap: 8px; padding-top: 4px; }
  .inline { display: inline-flex; align-items: center; gap: 8px; font-size: 14px; color: var(--muted); }
  .num { width: 88px; min-height: 36px; padding: 4px 8px; }
  .time { width: 120px; min-height: 36px; padding: 4px 8px; }
  .tz { width: 200px; min-height: 36px; padding: 4px 8px; }
  .day { min-width: 48px; min-height: 36px; border-radius: 999px; border: 1px solid var(--border); background: var(--surface); cursor: pointer; font-size: 13px; font-weight: 600; color: var(--muted); }
  .day[aria-pressed="true"] { background: var(--tide); color: #fff; border-color: transparent; }
</style>
