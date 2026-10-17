<script lang="ts">
  import { action, errorMessage, read } from "../lib/api.ts";
  import { initials } from "../lib/format.ts";
  import { isOwner } from "../lib/session.svelte.ts";
  import { announce, toastError } from "../lib/toast.svelte.ts";
  import type { Author } from "../lib/types.ts";

  let authors = $state<Author[] | null>(null);
  let error = $state("");
  let name = $state("");
  let persona = $state(false);
  let busy = $state(false);

  async function load() {
    try {
      authors = await read<Author[]>("authors.list", {});
    } catch (err) {
      error = errorMessage(err);
    }
  }
  load();

  async function add(e: Event) {
    e.preventDefault();
    if (!name.trim()) return;
    busy = true;
    try {
      const res = await action("authors.create", { name: name.trim(), isPersona: persona, requiresApproval: !persona });
      announce(res, { afterUndo: load });
      name = "";
      await load();
    } catch (err) {
      toastError(err);
    } finally {
      busy = false;
    }
  }
</script>

<div class="page">
  <h1 class="page-title">Authors</h1>
  <p class="muted">Each author has a byline and a voice. Real people approve drafts written in their name; personas never claim first-hand experience.</p>
  {#if error}<p class="error-box">{error}</p>{/if}
  <ul class="list">
    {#each authors ?? [] as a (a.id)}
      <li>
        <a class="card author" href="/authors/{a.slug}">
          <span class="avatar" aria-hidden="true">{a.initials || initials(a.name)}</span>
          <span class="col"><span class="name">{a.name}</span><span class="small muted">{a.isPersona ? "Persona" : "Real person"}{a.posts != null ? `, ${a.posts} ${a.posts === 1 ? "post" : "posts"}` : ""} · {a.voice?.sentenceLength?.label ?? ""}</span></span>
        </a>
      </li>
    {:else}
      {#if authors}<li class="muted">No authors yet.</li>{:else}<li class="skeleton" style="height: 72px"></li>{/if}
    {/each}
  </ul>
  {#if isOwner()}
    <form class="card add" onsubmit={add}>
      <h2>Add an author</h2>
      <label class="field"><span>Name</span><input class="input" bind:value={name} placeholder="e.g. Fred Laurent" /></label>
      <fieldset class="kind">
        <legend class="sr-only">Who is this?</legend>
        <label><input type="radio" name="kind" checked={!persona} onchange={() => (persona = false)} /> A real person who approves drafts</label>
        <label><input type="radio" name="kind" checked={persona} onchange={() => (persona = true)} /> A persona (no real person behind it)</label>
      </fieldset>
      <div class="row"><button class="btn btn-primary" type="submit" disabled={busy || !name.trim()}>Add author</button></div>
    </form>
  {/if}
</div>

<style>
  .list { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 16px; }
  .author { flex-direction: row; align-items: center; text-decoration: none; color: var(--text); }
  .author:hover { border-color: var(--muted); }
  .avatar { width: 48px; height: 48px; border-radius: 50%; background: var(--ocean); color: #fff; font-weight: 700; display: flex; align-items: center; justify-content: center; flex: none; }
  .col { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .name { font-weight: 700; font-size: 17px; }
  .add { max-width: 560px; }
  .kind { border: 0; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 8px; font-size: 15px; }
  .kind label { display: flex; gap: 8px; align-items: center; min-height: 32px; }
</style>
