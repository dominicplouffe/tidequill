<script lang="ts">
  import { untrack } from "svelte";
  import LooksPicker from "../components/LooksPicker.svelte";
  import Logo from "../components/Logo.svelte";
  import { action, errorMessage, pollRun, read } from "../lib/api.ts";
  import { applyLook } from "../lib/look.ts";
  import { navigate } from "../lib/router.svelte.ts";
  import { refreshSites, selectSite, session } from "../lib/session.svelte.ts";
  import { toast } from "../lib/toast.svelte.ts";
  import type { LookOption } from "../lib/types.ts";

  /** Live in under 3 minutes, in 4 steps. Every step can be redone later by asking. */
  let { query }: { params?: any; query: URLSearchParams } = $props();

  const KEY = "tq.onboarding";
  type Saved = { siteId: string; step: number; sentence: string; name: string; domain: string };
  const fresh = untrack(() => query.get("new") === "1");
  const saved: Saved | null = (() => {
    if (fresh) return null;
    try {
      return JSON.parse(sessionStorage.getItem(KEY) ?? "null");
    } catch {
      return null;
    }
  })();

  let step = $state(saved?.step ?? 1);
  let siteId = $state<string | null>(saved?.siteId ?? null);
  let name = $state(saved?.name ?? "");
  let domain = $state(saved?.domain ?? "");
  let sentence = $state(saved?.sentence ?? "");
  let busy = $state(false);
  let error = $state("");
  let setup = $state<{ categories: string[]; pages: string[]; plan: string; running?: string } | null>(null);
  let looks = $state<LookOption[] | null>(null);
  let lookPicked = $state(-1);
  let authorName = $state(session.user?.name ?? "");
  let authorKind = $state<"real" | "persona">("real");

  const STEPS = ["Domain", "About", "Look", "Authors"];
  const LEFT = ["about 2 minutes left", "about a minute left", "under a minute left", "almost done"];

  $effect(() => {
    const s: Saved = { siteId: siteId ?? "", step, sentence, name, domain };
    if (siteId) sessionStorage.setItem(KEY, JSON.stringify(s));
  });

  function list(v: any, keys: string[]): string[] {
    if (!Array.isArray(v)) return [];
    return v.map((x) => (typeof x === "string" ? x : keys.map((k) => x?.[k]).find(Boolean) ?? "")).filter(Boolean);
  }

  function describePlan(r: any): string {
    const p = r?.plan ?? r?.first30Days ?? r?.calendar;
    if (typeof p === "string") return p;
    if (Array.isArray(p)) return `${p.length} post ideas${r?.drafted ? `, ${r.drafted} drafted for your review` : ""}`;
    if (p && typeof p === "object") {
      const ideas = p.ideas?.length ?? p.ideas ?? p.posts ?? 0;
      const drafted = p.drafted?.length ?? p.drafted ?? 0;
      return `${ideas} post ideas${drafted ? `, ${drafted} drafted for your review` : ""}`;
    }
    const ideas = r?.ideas?.length ?? r?.ideas;
    return ideas ? `${ideas} post ideas` : "A month of post ideas, the first drafts for your review";
  }

  async function createSite(e: Event) {
    e.preventDefault();
    error = "";
    if (siteId) return (step = 2);
    busy = true;
    try {
      const res = await action<any>("sites.create", { name: name.trim(), domain: domain.trim() || undefined }, { site: null });
      const id = res.status === "applied" || res.status === "done" ? (res.result as any)?.id : null;
      if (!id) throw new Error("The site wasn't created. Try again.");
      siteId = id;
      await refreshSites();
      selectSite(id);
      step = 2;
    } catch (err) {
      error = errorMessage(err);
    } finally {
      busy = false;
    }
  }

  async function runSetup(e: Event) {
    e.preventDefault();
    if (setup && !setup.running) return (step = 3);
    error = "";
    if (sentence.trim().length < 8) return (error = "Tell me a little more: one full sentence is enough.");
    busy = true;
    try {
      const res = await action<any>("sites.setup", { niche: sentence.trim() });
      const r: any = res.status === "applied" || res.status === "done" ? res.result : res.status === "proposed" ? {} : {};
      // sites.setup → { sections: [{ label, items? | text? }], categories, pages, ideas, runId, ... }
      const sec = (label: string) => (Array.isArray(r?.sections) ? r.sections.find((s: any) => s.label === label) : null);
      const catSec = sec("Categories");
      const pageSec = sec("Starter pages");
      const planSec = sec("First 30 days");
      setup = {
        categories: catSec?.items ?? list(r?.categories, ["name", "title"]),
        pages: pageSec?.text ? [pageSec.text] : list(r?.pages ?? r?.starterPages, ["title", "name"]),
        plan: planSec?.text ?? describePlan(r),
      };
      if (r?.runId) {
        setup.running = "Drafting the first posts";
        pollRun(r.runId, (run) => setup && (setup.running = run.label || "Working on it"))
          .then(() => setup && (setup.running = undefined))
          .catch(() => setup && (setup.running = undefined));
      }
    } catch (err) {
      // Older servers: keep the sentence at least.
      try {
        await action("sites.update", { niche: sentence.trim() });
        setup = { categories: [], pages: [], plan: "I'll suggest categories, pages and posts once setup is available. Ask any time." };
      } catch {
        error = errorMessage(err);
      }
    } finally {
      busy = false;
    }
  }

  async function loadLooks() {
    if (looks) return;
    busy = true;
    error = "";
    try {
      const r = await read<any>("look.describe", { description: sentence.trim() || name });
      const options: LookOption[] = Array.isArray(r) ? r : (r?.options ?? r?.looks ?? []);
      looks = options.slice(0, 3);
    } catch (err) {
      error = errorMessage(err);
      looks = [];
    } finally {
      busy = false;
    }
  }

  $effect(() => {
    if (step === 3) untrack(loadLooks);
  });

  async function pickLook(o: LookOption) {
    busy = true;
    try {
      await applyLook(o);
    } catch (err) {
      error = errorMessage(err);
      lookPicked = -1;
    } finally {
      busy = false;
    }
  }

  async function finish(e?: Event, editorial = false) {
    e?.preventDefault();
    busy = true;
    error = "";
    try {
      if (editorial) {
        const existing = await read<any[]>("authors.list", {}).catch(() => []);
        if (!existing.some((a) => /editorial/i.test(a.name))) await action("authors.create", { name: "Editorial team", isPersona: true, requiresApproval: false, bio: "Written and checked by the site's editorial team." });
      } else if (authorName.trim()) {
        const persona = authorKind === "persona";
        await action("authors.create", { name: authorName.trim(), isPersona: persona, requiresApproval: !persona, userId: persona ? null : session.user?.id ?? null });
      }
      done();
    } catch (err) {
      error = errorMessage(err);
    } finally {
      busy = false;
    }
  }

  function done() {
    sessionStorage.removeItem(KEY);
    refreshSites();
    toast("Your site is set up. The first drafts show up on Today for your approval.", { tone: "agent", timeout: 8000 });
    navigate("/today", { replace: true });
  }

  function skip() {
    if (step < 4) step++;
    else done();
  }
</script>

<div class="wrap">
  <div class="top">
    <span class="brand"><Logo label /></span>
    <ol class="progress" aria-label="Setup progress">
      {#each STEPS as s, i (s)}
        {#if i > 0}<li class="line" aria-hidden="true"></li>{/if}
        <li aria-current={step === i + 1 ? "step" : undefined} class:done={step > i + 1}>
          <span class="n">{step > i + 1 ? "✓" : i + 1}</span><span class="label">{s}</span>
        </li>
      {/each}
    </ol>
  </div>

  <section class="panel fade-in" aria-labelledby="ob-title">
    {#if step === 1}
      <form class="stack" onsubmit={createSite}>
        <div class="intro">
          <span class="small muted">Welcome{session.user ? `, ${session.user.name.split(" ")[0]}` : ""}. Let's get your site live.</span>
          <h1 id="ob-title" class="serif">What's your site called?</h1>
        </div>
        <label class="field"><span>Site name</span><input class="input big" bind:value={name} placeholder="Walnut & Wire" required autocomplete="off" /></label>
        <label class="field">
          <span>Domain <span class="muted">(optional, you can add it later)</span></span>
          <input class="input big" bind:value={domain} placeholder="walnutandwire.com" autocomplete="off" autocapitalize="off" spellcheck="false" />
        </label>
        {#if error}<p class="error-box" role="alert">{error}</p>{/if}
        <div class="foot">
          <span class="small muted">Point the domain's DNS at this server; HTTPS is automatic.</span>
          <button class="btn btn-primary btn-lg" type="submit" disabled={busy || !name.trim()}>{busy ? "Creating…" : "Continue"}</button>
        </div>
      </form>
    {:else if step === 2}
      <form class="stack" onsubmit={runSetup}>
        <div class="intro">
          <span class="small muted">{domain ? `${domain} is connected` : `${name || "Your site"} is ready`}</span>
          <h1 id="ob-title" class="serif">What is this site about?</h1>
          <p class="muted">One sentence is enough. Tidequill uses it to set up categories, starter pages, a look and your first month of posts.</p>
        </div>
        <label class="sr-only" for="sentence">Describe your site</label>
        <textarea id="sentence" class="sentence serif" rows="2" bind:value={sentence} placeholder="Honest guides to TV stands and media furniture for small living rooms, written by people who build and test them." oninput={() => setup && !busy && (setup = null)}></textarea>
        {#if busy}
          <p class="working" role="status"><span class="dot" aria-hidden="true"></span>Setting up categories, starter pages and a plan…</p>
        {/if}
        {#if setup}
          <div class="plan fade-in">
            <div class="ph"><span class="dot" aria-hidden="true"></span><h2>Here's what I'll set up</h2></div>
            <div class="cols">
              <div class="box"><h3>Categories</h3>{#if setup.categories.length}<div class="row">{#each setup.categories as c (c)}<span class="pill">{c}</span>{/each}</div>{:else}<p class="small muted">Suggested as posts arrive.</p>{/if}</div>
              <div class="box"><h3>Starter pages</h3><p>{setup.pages.length ? setup.pages.join(", ") : "About, Contact, Privacy"}</p></div>
              <div class="box"><h3>First 30 days</h3><p>{setup.plan}</p>{#if setup.running}<p class="small muted" role="status">{setup.running}…</p>{/if}</div>
            </div>
          </div>
        {/if}
        {#if error}<p class="error-box" role="alert">{error}</p>{/if}
        <div class="foot">
          <span class="small muted">You can change any of this later by asking.</span>
          <div class="row">
            <button type="button" class="btn btn-quiet btn-lg" onclick={() => (step = 1)}>Back</button>
            {#if !setup}<button type="button" class="btn btn-quiet btn-lg" onclick={skip}>Skip</button>{/if}
            <button class="btn btn-primary btn-lg" type="submit" disabled={busy}>{setup ? "Continue to Look" : busy ? "Setting up…" : "Set it up"}</button>
          </div>
        </div>
      </form>
    {:else if step === 3}
      <div class="stack">
        <div class="intro">
          <h1 id="ob-title" class="serif">Pick a look</h1>
          <p class="muted">Three looks made for {sentence ? "what you described" : name}. Pick one; you can describe changes any time (“make it warmer”).</p>
        </div>
        {#if busy && !looks}
          <div class="looks-skel" aria-busy="true"><div class="skeleton" style="height: 300px"></div><div class="skeleton" style="height: 300px"></div><div class="skeleton" style="height: 300px"></div></div>
        {:else if looks?.length}
          <LooksPicker options={looks} bind:selected={lookPicked} onpick={pickLook} {busy} siteName={name || "Your site"} />
        {:else}
          <p class="muted">No looks to show right now. The site starts with the house design; ask for a new look any time.</p>
        {/if}
        {#if error}<p class="error-box" role="alert">{error}</p>{/if}
        <div class="foot">
          <span class="small muted">You can change any of this later by asking.</span>
          <div class="row">
            <button type="button" class="btn btn-quiet btn-lg" onclick={() => (step = 2)}>Back</button>
            {#if lookPicked < 0}<button type="button" class="btn btn-quiet btn-lg" onclick={skip}>Skip</button>{/if}
            <button type="button" class="btn btn-primary btn-lg" disabled={busy || (lookPicked < 0 && !!looks?.length)} onclick={() => (step = 4)}>Continue to Authors</button>
          </div>
        </div>
      </div>
    {:else}
      <form class="stack" onsubmit={(e) => finish(e)}>
        <div class="intro">
          <h1 id="ob-title" class="serif">Who writes here?</h1>
          <p class="muted">Add one author now; add more later. Real people approve drafts written in their name. Personas never claim first-hand experience.</p>
        </div>
        <label class="field"><span>Author name</span><input class="input big" bind:value={authorName} placeholder="Fred Laurent" /></label>
        <fieldset class="kind">
          <legend class="sr-only">Who is this author?</legend>
          <label class:on={authorKind === "real"}><input type="radio" name="kind" value="real" bind:group={authorKind} /><span><strong>A real person</strong><span class="small muted">Approves drafts written in their name</span></span></label>
          <label class:on={authorKind === "persona"}><input type="radio" name="kind" value="persona" bind:group={authorKind} /><span><strong>A persona</strong><span class="small muted">A byline with no real person behind it</span></span></label>
        </fieldset>
        {#if error}<p class="error-box" role="alert">{error}</p>{/if}
        <div class="foot">
          <button type="button" class="btn btn-lg" disabled={busy} onclick={() => finish(undefined, true)}>Use the Editorial team</button>
          <div class="row">
            <button type="button" class="btn btn-quiet btn-lg" onclick={() => (step = 3)}>Back</button>
            <button class="btn btn-primary btn-lg" type="submit" disabled={busy || !authorName.trim()}>{busy ? "Finishing…" : "Finish"}</button>
          </div>
        </div>
      </form>
    {/if}
  </section>

  <p class="left" aria-live="polite">Step {step} of 4, {LEFT[step - 1]}</p>
</div>

<style>
  .wrap { min-height: 100vh; min-height: 100dvh; background: var(--tide); padding: 48px 24px; display: flex; flex-direction: column; align-items: center; gap: 36px; }
  .top { width: 100%; max-width: 980px; display: flex; justify-content: space-between; align-items: center; gap: 16px; flex-wrap: wrap; }
  .progress { list-style: none; margin: 0; padding: 0; display: flex; gap: 8px; align-items: center; font-size: 13px; color: var(--tide-muted); }
  .progress li { display: flex; align-items: center; gap: 6px; }
  .progress .line { width: 24px; height: 1px; background: #2c6e8f; }
  .n { width: 22px; height: 22px; border-radius: 50%; border: 1px solid #4a87a6; display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 12px; }
  .progress .done .n { background: var(--ocean); border-color: transparent; color: #fff; }
  .progress [aria-current="step"] { color: #fff; font-weight: 600; }
  .progress [aria-current="step"] .n { background: var(--gold); color: var(--on-gold); border-color: transparent; }
  .panel { width: 100%; max-width: 980px; background: var(--surface); border-radius: 24px; padding: 48px; }
  .stack { gap: 28px; }
  .intro { display: flex; flex-direction: column; gap: 10px; }
  h1 { font-size: 52px; font-weight: 500; line-height: 1.05; letter-spacing: -0.015em; }
  .intro p { font-size: 17px; max-width: 620px; }
  .big { min-height: 56px; font-size: 20px; }
  .sentence { width: 100%; resize: none; border-radius: 16px; border: 2px solid var(--ocean); padding: 18px 20px; font-size: 24px; line-height: 1.4; color: var(--text); background: var(--surface); }
  .sentence:focus-visible { outline: 3px solid var(--gold); outline-offset: 2px; }
  .working { display: flex; align-items: center; gap: 10px; color: var(--muted); }
  .dot { width: 10px; height: 10px; border-radius: 50%; background: var(--gold); flex: none; }
  .working .dot { animation: pulse 1.2s infinite; }
  @keyframes pulse { 50% { opacity: 0.3; } }
  .plan { display: flex; flex-direction: column; gap: 14px; }
  .ph { display: flex; align-items: center; gap: 10px; }
  .ph h2 { font-size: 16px; }
  .cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 16px; }
  .box { background: var(--bg); border-radius: 14px; padding: 18px; display: flex; flex-direction: column; gap: 10px; }
  .box h3 { font-size: 14px; }
  .box p { font-size: 14px; line-height: 1.6; color: var(--text-2); }
  .pill { background: var(--surface); border: 1px solid var(--border); border-radius: 999px; padding: 5px 10px; font-size: 13px; }
  .looks-skel { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; }
  .kind { border: 0; padding: 0; margin: 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 12px; }
  .kind label { display: flex; gap: 12px; align-items: flex-start; padding: 16px; border: 2px solid var(--border); border-radius: 14px; cursor: pointer; }
  .kind label.on { border-color: var(--gold); }
  .kind label > span { display: flex; flex-direction: column; gap: 2px; }
  .kind input { margin-top: 4px; accent-color: var(--ocean); }
  .foot { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 16px; padding-top: 8px; border-top: 1px solid var(--border-soft); }
  .left { font-size: 14px; color: var(--tide-muted); }
  @media (max-width: 719px) {
    .wrap { padding: 20px 12px; gap: 20px; }
    .panel { padding: 24px 18px; border-radius: 18px; }
    h1 { font-size: 34px; }
    .sentence { font-size: 20px; }
    .progress .label { display: none; }
  }
</style>
