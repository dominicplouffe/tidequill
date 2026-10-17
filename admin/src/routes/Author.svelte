<script lang="ts">
  import { untrack } from "svelte";
  import DiffView from "../components/DiffView.svelte";
  import ProposalCard, { type ProposalLike } from "../components/ProposalCard.svelte";
  import { action, errorMessage, read } from "../lib/api.ts";
  import { firstName, initials } from "../lib/format.ts";
  import { announce, toastError } from "../lib/toast.svelte.ts";
  import type { Author, DiffItem, InvokeResult } from "../lib/types.ts";

  let { params }: { params: { key: string }; query?: URLSearchParams } = $props();
  const key = untrack(() => params.key);

  let author = $state<Author | null>(null);
  let error = $state("");
  let adding = $state(false);
  let phrase = $state("");
  let sample = $state<{ base: string; mine: string; match: number | null } | null>(null);
  let sampling = $state(false);
  let adjust = $state("");
  let adjusting = $state(false);
  let adjustResult = $state<{ proposal?: ProposalLike; diff?: DiffItem[]; summary?: string; sample?: { before: string; after: string } } | null>(null);
  let samplesOpen = $state(false);
  let samplesText = $state("");
  let learning = $state(false);
  let phraseInput: HTMLInputElement | undefined = $state();

  const SLIDERS = [
    { k: "sentenceLength", name: "Sentence length", ends: ["Punchy", "Flowing"] },
    { k: "formality", name: "Formality", ends: ["Talking to a friend", "Formal report"] },
    { k: "humor", name: "Humor", ends: ["None", "Lots"] },
    { k: "depth", name: "Technical depth", ends: ["Beginner", "Expert"] },
  ] as const;

  async function load() {
    try {
      author = await read<Author>("authors.get", { author: key });
      error = "";
    } catch (err) {
      error = errorMessage(err);
    }
  }
  load();

  const first = $derived(author ? firstName(author.name) : "");

  async function setBanned(next: string[]) {
    if (!author) return;
    const prev = author.voice.banned;
    author.voice.banned = next;
    try {
      const res = await action("authors.update", { author: author.id, voice: { banned: next } });
      announce(res, { afterUndo: load });
      if (res.status === "proposed") author.voice.banned = prev;
    } catch (err) {
      author.voice.banned = prev;
      toastError(err);
    }
  }

  function addPhrase(e: Event) {
    e.preventDefault();
    const p = phrase.trim();
    if (!p || !author) return;
    phrase = "";
    adding = false;
    if (!author.voice.banned.some((b) => b.toLowerCase() === p.toLowerCase())) setBanned([...author.voice.banned, p]);
  }

  function pick(r: any, keys: string[]): any {
    for (const k of keys) if (r?.[k] != null) return r[k];
    return null;
  }

  async function hearIt() {
    if (!author) return;
    sampling = true;
    try {
      const r = await read<any>("authors.sample", { author: author.id });
      sample = {
        base: String(pick(r, ["default", "defaultText", "base", "before"]) ?? ""),
        mine: String(pick(r, ["author", "authorText", "sample", "text", "after"]) ?? ""),
        match: pick(r, ["voiceMatch", "match", "score"]),
      };
    } catch (err) {
      toastError(err);
    } finally {
      sampling = false;
    }
  }

  function showResult(res: InvokeResult<any>) {
    if (res.status === "proposed") adjustResult = { proposal: { id: res.proposalId, summary: res.summary, diff: res.diff, trustKind: "settings" } };
    else if (res.status === "applied") {
      // Voice actions may delegate the actual change to authors.update (often a proposal).
      const d = res.result?.delegated;
      const sample = res.result?.sample?.before && res.result?.sample?.after ? res.result.sample : undefined;
      if (d?.status === "proposed") adjustResult = { proposal: { id: d.proposalId, summary: d.summary, diff: d.diff ?? [], trustKind: "settings" }, sample };
      else {
        announce(d?.status === "applied" ? d : res, { afterUndo: load });
        adjustResult = { summary: res.summary, diff: d?.diff ?? res.result?.diff ?? [], sample };
      }
      load();
    } else if (res.status === "done") {
      const r: any = res.result;
      if (r?.proposalId) adjustResult = { proposal: { id: r.proposalId, summary: r.summary ?? "Voice change", diff: r.diff ?? [], trustKind: "settings" } };
      else adjustResult = { summary: r?.summary ?? "Done.", diff: r?.diff ?? [] };
      load();
    } else if (res.status === "dry_run") adjustResult = { summary: res.summary, diff: res.diff };
  }

  async function doAdjust(e: Event) {
    e.preventDefault();
    if (!author || !adjust.trim()) return;
    adjusting = true;
    adjustResult = null;
    try {
      showResult(await action("authors.adjust_voice", { author: author.id, instruction: adjust.trim() }));
      adjust = "";
    } catch (err) {
      toastError(err);
    } finally {
      adjusting = false;
    }
  }

  async function learn(e: Event) {
    e.preventDefault();
    if (!author) return;
    const samples = samplesText
      .split(/\n\s*-{3,}\s*\n/)
      .map((s) => s.trim())
      .filter((s) => s.length > 40);
    if (!samples.length) return toastError(new Error("Paste at least one piece of writing (a paragraph or more)."));
    learning = true;
    try {
      showResult(await action("authors.learn_voice", { author: author.id, samples }));
      samplesText = "";
      samplesOpen = false;
    } catch (err) {
      toastError(err);
    } finally {
      learning = false;
    }
  }
</script>

{#if error}
  <div class="page"><p class="error-box" role="alert">{error}</p><a href="/authors">All authors</a></div>
{:else if !author}
  <div class="page" aria-busy="true"><div class="skeleton" style="height: 80px"></div><div class="skeleton" style="height: 360px"></div></div>
{:else}
  <div class="page">
    <nav class="crumbs small" aria-label="Breadcrumb"><a href="/settings">Settings</a><span aria-hidden="true">/</span><a href="/authors">Authors</a><span aria-hidden="true">/</span><span aria-current="page">{author.name}</span></nav>

    <header class="head">
      <div class="avatar" aria-hidden="true">{author.initials || initials(author.name)}</div>
      <div class="who">
        <h1 class="page-title">{author.name}</h1>
        <p class="muted">
          {author.expertise.length ? `Covers ${author.expertise.join(", ").toLowerCase()}. ` : ""}{author.isPersona ? "A persona: never claims first-hand experience." : author.requiresApproval ? `Real person; approves drafts in ${first === author.name ? "their" : "their"} name.` : "Real person."}
        </p>
      </div>
      <div class="row">
        <button type="button" class="btn" aria-expanded={samplesOpen} onclick={() => (samplesOpen = !samplesOpen)}>Add samples</button>
        <a class="btn btn-primary" href="/ask?q={encodeURIComponent(`Write a post as ${first} about `)}">Write as {first}</a>
      </div>
    </header>

    {#if samplesOpen}
      <form class="card fade-in" onsubmit={learn}>
        <h2>Teach {first}'s voice</h2>
        <p class="muted small">Paste 3 to 10 pieces {first} wrote. Separate them with a line of three dashes (---). The more real writing, the closer the match.</p>
        <label class="sr-only" for="samples">Writing samples</label>
        <textarea id="samples" class="textarea serif" rows="8" bind:value={samplesText}></textarea>
        <div class="row"><button class="btn btn-dark" type="submit" disabled={learning}>{learning ? "Learning…" : "Learn from these"}</button><button class="btn btn-quiet" type="button" onclick={() => (samplesOpen = false)}>Cancel</button></div>
      </form>
    {/if}

    <div class="grid">
      <section class="card voice" aria-labelledby="voice-h">
        <div class="vh"><h2 id="voice-h">Voice</h2><span class="small muted">{author.voice.learnedFrom}</span></div>
        {#each SLIDERS as s (s.k)}
          {@const v = author.voice[s.k]}
          <div class="slider">
            <div class="line"><span class="strong">{s.name}</span><span class="muted">{v.label}</span></div>
            <div class="track" role="meter" aria-label={s.name} aria-valuemin={0} aria-valuemax={100} aria-valuenow={v.value} aria-valuetext={v.label}>
              <span class="fill" style:width="{v.value}%"></span><span class="knob" style:left="calc({v.value}% - 9px)"></span>
            </div>
            <div class="ends"><span>{s.ends[0]}</span><span>{s.ends[1]}</span></div>
          </div>
        {/each}
        <dl class="facts">
          <div><dt>Writes as</dt><dd>{author.voice.person === "I" ? "“I”" : author.voice.person === "we" ? "“We”" : author.voice.person === "you" ? "“You”" : "A mix"}</dd></div>
          <div><dt>Words</dt><dd>{author.voice.vocabulary}</dd></div>
          <div><dt>Structure</dt><dd>{author.voice.structure}</dd></div>
          <div><dt>Spelling</dt><dd>{author.voice.spelling}</dd></div>
        </dl>
        <div class="chips-group">
          <h3>Habits</h3>
          <div class="row">{#each author.voice.habits as h (h)}<span class="chip habit">{h}</span>{:else}<span class="muted small">None learned yet.</span>{/each}</div>
        </div>
        <div class="chips-group">
          <h3>Never says</h3>
          <div class="row">
            {#each author.voice.banned as b (b)}
              <span class="chip chip-warn">{b}<button type="button" class="x" aria-label="Allow “{b}” again" onclick={() => setBanned(author!.voice.banned.filter((x) => x !== b))}>×</button></span>
            {/each}
            {#if adding}
              <form class="add" onsubmit={addPhrase}>
                <label class="sr-only" for="phrase">Phrase {first} never says</label>
                <input id="phrase" class="input" bind:this={phraseInput} bind:value={phrase} placeholder="e.g. game-changer" onkeydown={(e) => e.key === "Escape" && (adding = false)} />
                <button class="btn btn-sm btn-dark" type="submit">Add</button>
              </form>
            {:else}
              <button type="button" class="addbtn" onclick={() => { adding = true; queueMicrotask(() => phraseInput?.focus()); }}>Add phrase</button>
            {/if}
          </div>
        </div>
      </section>

      <div class="stack" style="gap: 24px">
        <section class="card" aria-labelledby="hear-h">
          <h2 id="hear-h">Hear it</h2>
          <p class="muted small">The same paragraph, in the site's default voice and in {first}'s.</p>
          {#if sample}
            <div class="sample base"><span class="small strong muted">Default</span><p class="serif">{sample.base}</p></div>
            <div class="sample mine"><span class="small strong">{first}{sample.match != null ? `, voice match ${Math.round(sample.match)}` : ""}</span><p class="serif">{sample.mine}</p></div>
            <button type="button" class="btn btn-sm" disabled={sampling} onclick={hearIt}>{sampling ? "Writing…" : "Another one"}</button>
          {:else}
            <button type="button" class="btn" disabled={sampling} onclick={hearIt}>{sampling ? "Writing a sample…" : `Hear ${first}'s voice`}</button>
          {/if}
          <form class="adjust" onsubmit={doAdjust}>
            <label class="sr-only" for="adjust">Adjust {first}'s voice</label>
            <input id="adjust" bind:value={adjust} placeholder="Tell me how to adjust {first}, e.g. a bit less jokey" />
            <button class="btn btn-sm btn-dark" type="submit" disabled={adjusting || !adjust.trim()}>{adjusting ? "Working…" : "Adjust"}</button>
          </form>
          {#if adjustResult}
            <div class="fade-in stack" style="gap: 12px">
              {#if adjustResult.sample}
                <div class="sample base"><span class="small strong muted">Now</span><p class="serif">{adjustResult.sample.before}</p></div>
                <div class="sample mine"><span class="small strong">After the change</span><p class="serif">{adjustResult.sample.after}</p></div>
              {/if}
              {#if adjustResult.proposal}
                <ProposalCard proposal={adjustResult.proposal} ondecide={(_id, s) => { if (s === "approved") load(); }} onrestore={() => {}} />
              {:else}
                <p class="small">{adjustResult.summary}</p>
                {#if adjustResult.diff?.length}<DiffView diff={adjustResult.diff} compact />{/if}
              {/if}
            </div>
          {/if}
        </section>

        <section class="card" aria-labelledby="pub-h">
          <h2 id="pub-h">Public profile</h2>
          {#if author.bio}<p class="serif bio">{author.bio}</p>{/if}
          <dl class="profile">
            <div><dt>Expertise</dt><dd>{author.expertise.join(", ") || "Not set"}</dd></div>
            <div><dt>First-hand notes</dt><dd>{author.evidence ? `${author.evidence.items} ${author.evidence.items === 1 ? "item" : "items"}, ${author.evidence.photos ?? 0} photos` : "None yet"}</dd></div>
            <div><dt>Approval</dt><dd>{author.isPersona ? "Persona, no approval" : author.requiresApproval ? "Required before publish" : "Not required"}</dd></div>
            <div><dt>Credentials</dt><dd>{author.credentials || "Not set"}</dd></div>
          </dl>
          <a class="small" href="/ask?q={encodeURIComponent(`Update ${first}'s public profile: `)}">Change the profile by asking</a>
          {#if !author.isPersona}<a class="small" href="/capture?author={author.id}">Capture something {first} saw or did</a>{/if}
        </section>
      </div>
    </div>
  </div>
{/if}

<style>
  .crumbs { display: flex; gap: 10px; color: var(--muted); }
  .crumbs a { color: var(--muted); text-decoration: none; }
  .crumbs [aria-current] { color: var(--text); font-weight: 600; }
  .head { display: flex; flex-wrap: wrap; align-items: center; gap: 20px; }
  .avatar { width: 76px; height: 76px; border-radius: 50%; background: var(--ocean); color: #fff; font-size: 28px; font-weight: 700; display: flex; align-items: center; justify-content: center; flex: none; }
  .who { flex: 1; min-width: 240px; display: flex; flex-direction: column; gap: 6px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap: 24px; align-items: start; }
  .voice { gap: 20px; padding: 24px; }
  .vh { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; flex-wrap: wrap; }
  .slider { display: flex; flex-direction: column; gap: 8px; }
  .line { display: flex; justify-content: space-between; font-size: 14px; gap: 8px; }
  .strong { font-weight: 600; }
  .track { position: relative; height: 6px; border-radius: 3px; background: var(--track); }
  .fill { position: absolute; left: 0; top: 0; height: 6px; border-radius: 3px; background: var(--ocean); }
  .knob { position: absolute; top: -6px; width: 18px; height: 18px; border-radius: 50%; background: var(--surface); border: 2px solid var(--ocean); }
  .ends { display: flex; justify-content: space-between; font-size: 12px; color: var(--muted); }
  .facts, .profile { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin: 0; font-size: 14px; }
  dt { color: var(--muted); }
  dd { margin: 2px 0 0; font-weight: 600; }
  h3 { font-size: 14px; font-weight: 600; margin-bottom: 10px; }
  .habit { font-weight: 500; font-size: 14px; padding: 6px 12px; }
  .chip-warn { font-size: 14px; font-weight: 500; padding: 4px 6px 4px 12px; }
  .x { background: none; border: 0; color: inherit; cursor: pointer; font-size: 16px; width: 24px; height: 24px; border-radius: 50%; }
  .x:hover { background: rgba(0, 0, 0, 0.08); }
  .addbtn { min-height: 32px; padding: 0 12px; border-radius: 999px; border: 1px dashed var(--muted); background: var(--surface); color: var(--muted); cursor: pointer; font-size: 14px; }
  .add { display: flex; gap: 6px; }
  .add .input { min-height: 36px; width: 200px; padding: 4px 10px; }
  .sample { display: flex; flex-direction: column; gap: 6px; padding: 14px; border-radius: 10px; }
  .sample p { font-size: 17px; line-height: 1.55; }
  .base { background: var(--sunken); }
  .mine { background: var(--chip); }
  .mine .strong { color: var(--chip-text); }
  .adjust { display: flex; align-items: center; gap: 10px; min-height: 52px; padding: 0 8px 0 16px; border-radius: 12px; border: 1px solid var(--border); }
  .adjust:focus-within { outline: 3px solid var(--focus); border-color: transparent; }
  .adjust input { flex: 1; min-width: 0; border: 0; outline: none; background: transparent; font-size: 15px; color: var(--text); }
  .bio { font-size: 16px; line-height: 1.5; }
</style>
