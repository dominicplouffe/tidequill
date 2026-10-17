<script lang="ts">
  import { navigate } from "../lib/router.svelte.ts";
  import { currentSite, selectSite, session } from "../lib/session.svelte.ts";

  let { compact = false }: { compact?: boolean } = $props();
  let open = $state(false);
  let root: HTMLElement | undefined = $state();
  const site = $derived(currentSite());
  const listId = `sites-${Math.random().toString(36).slice(2, 7)}`;

  function pick(id: string) {
    open = false;
    if (id !== session.siteId) {
      selectSite(id);
      navigate("/today");
    }
  }
  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape" && open) {
      open = false;
      (root?.querySelector("button") as HTMLElement | null)?.focus();
    }
    if (open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      const items = [...(root?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? [])];
      const i = items.indexOf(document.activeElement as HTMLElement);
      const next = items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length];
      next?.focus();
      e.preventDefault();
    }
  }
</script>

<svelte:window onclick={(e) => open && root && !e.composedPath().includes(root) && (open = false)} />

<div class="switcher" class:compact bind:this={root} onkeydown={onKey} role="presentation">
  <button type="button" class="current" aria-haspopup="menu" aria-expanded={open} aria-controls={listId} onclick={() => (open = !open)}>
    <span class="names">
      <span class="name">{site?.domain ?? site?.name ?? "Pick a site"}</span>
      {#if !compact}<span class="sub">{session.sites.length === 1 ? (site?.domain ? site.name : "Your site") : `${session.sites.length} sites in this network`}</span>{/if}
    </span>
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M3 5l4 4 4-4" stroke="currentColor" stroke-width="1.6" fill="none" /></svg>
  </button>
  {#if open}
    <div class="menu fade-in" role="menu" id={listId} aria-label="Your sites">
      {#each session.sites as s (s.id)}
        <button type="button" role="menuitem" class="item" aria-current={s.id === session.siteId ? "true" : undefined} onclick={() => pick(s.id)}>
          <span class="names"><span class="name">{s.name}</span><span class="sub">{s.domain ?? "No domain yet"}</span></span>
          {#if s.waiting}<span class="badge" aria-label="{s.waiting} waiting">{s.waiting}</span>{/if}
        </button>
      {/each}
      <a role="menuitem" class="item add" href="/onboarding?new=1" onclick={() => (open = false)}>+ Add a site</a>
    </div>
  {/if}
</div>

<style>
  .switcher { position: relative; }
  .current { display: flex; justify-content: space-between; align-items: center; gap: 8px; width: 100%; min-height: 48px; padding: 10px 12px; border-radius: 10px; border: 1px solid var(--tide-line); background: #104562; color: #fff; text-align: left; cursor: pointer; }
  .compact .current { border: 0; background: none; padding: 0; min-height: 44px; width: auto; }
  .names { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .name { font-weight: 600; font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .compact .name { font-size: 15px; }
  .sub { font-size: 12px; color: var(--tide-muted); }
  svg { color: var(--tide-muted); flex: none; }
  .menu { position: absolute; z-index: 40; top: calc(100% + 6px); left: 0; min-width: 260px; width: 100%; background: var(--surface); color: var(--text); border: 1px solid var(--border); border-radius: 12px; box-shadow: var(--shadow-pop); padding: 6px; display: flex; flex-direction: column; gap: 2px; }
  .item { display: flex; justify-content: space-between; align-items: center; gap: 8px; min-height: 48px; padding: 8px 10px; border-radius: 8px; border: 0; background: none; cursor: pointer; text-align: left; color: var(--text); text-decoration: none; font-size: 14px; }
  .item:hover, .item:focus-visible { background: var(--sunken); }
  .item[aria-current="true"] { background: var(--chip); }
  .item .sub { color: var(--muted); }
  .add { color: var(--link); font-weight: 600; }
</style>
