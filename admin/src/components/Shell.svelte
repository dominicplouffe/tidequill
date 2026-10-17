<script lang="ts">
  import type { Snippet } from "svelte";
  import { router } from "../lib/router.svelte.ts";
  import { session, signOut } from "../lib/session.svelte.ts";
  import { modKey, openCommand } from "../lib/ui.svelte.ts";
  import HoldToAsk from "./HoldToAsk.svelte";
  import Logo from "./Logo.svelte";
  import SiteSwitcher from "./SiteSwitcher.svelte";

  let { children }: { children: Snippet } = $props();

  const name = $derived(router.route.name);
  const links = $derived([
    { href: "/today", label: "Today", active: name === "today" || name === "home", badge: session.waiting },
    { href: "/ask", label: "Ask", active: name === "ask", badge: 0 },
    { href: "/live?path=/", label: "Your site", active: name === "live", badge: 0 },
  ]);
  const phoneLinks = $derived([...links, { href: "/capture", label: "Capture", active: name === "capture", badge: 0 }]);
</script>

<a class="skip" href="#main">Skip to content</a>
<div class="shell" class:full={name === "live"}>
  <nav class="side" aria-label="Main">
    <a class="brand" href="/today" aria-label="Tidequill, Today"><Logo label /></a>
    <SiteSwitcher />
    <div class="links">
      {#each links as l (l.href)}
        <a href={l.href} class="link" aria-current={l.active ? "page" : undefined}>
          {l.label}
          {#if l.badge}<span class="badge" aria-label="{l.badge} waiting">{l.badge}</span>{/if}
        </a>
      {/each}
    </div>
    <button type="button" class="ask" onclick={() => openCommand()}>Ask Tidequill<kbd>{modKey}</kbd></button>
    <div class="me">
      <span class="who">{session.user?.name}</span>
      <button type="button" class="out" onclick={signOut}>Sign out</button>
    </div>
  </nav>

  <header class="top">
    <SiteSwitcher compact />
    <button type="button" class="search" aria-label="Search or ask" onclick={() => openCommand()}>
      <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><circle cx="9" cy="9" r="6" stroke="currentColor" stroke-width="1.8" fill="none" /><path d="M13.5 13.5L18 18" stroke="currentColor" stroke-width="1.8" /></svg>
    </button>
    {#if session.waiting}<a class="badge" href="/today" aria-label="{session.waiting} waiting on Today">{session.waiting}</a>{/if}
  </header>

  <main id="main" class="content" tabindex="-1">
    {@render children()}
  </main>

  <nav class="bottom" aria-label="Main">
    {#each phoneLinks as l (l.href)}
      <a href={l.href} aria-current={l.active ? "page" : undefined}><span class="tick" aria-hidden="true"></span>{l.label}{#if l.badge}<span class="sr-only"> ({l.badge} waiting)</span>{/if}</a>
    {/each}
  </nav>
  {#if name !== "ask" && name !== "capture"}<div class="phone-only"><HoldToAsk /></div>{/if}
</div>

<style>
  .skip { position: absolute; left: -9999px; top: 8px; z-index: 200; background: var(--gold); color: var(--on-gold); padding: 8px 12px; border-radius: 8px; font-weight: 700; }
  .skip:focus { left: 8px; }
  .shell { display: grid; grid-template-columns: 248px minmax(0, 1fr); min-height: 100vh; min-height: 100dvh; }
  .side { position: sticky; top: 0; height: 100vh; height: 100dvh; background: var(--tide); color: var(--tide-text); padding: 28px 16px 20px; display: flex; flex-direction: column; gap: 28px; overflow-y: auto; }
  .brand { padding: 0 8px; text-decoration: none; }
  .links { display: flex; flex-direction: column; gap: 4px; }
  .link { display: flex; justify-content: space-between; align-items: center; min-height: 44px; padding: 0 12px; border-radius: 10px; color: #c4dde9; text-decoration: none; font-weight: 500; transition: background var(--t) var(--ease); }
  .link:hover { background: rgba(255, 255, 255, 0.06); color: #fff; }
  .link[aria-current="page"] { background: var(--tide-hi); color: #fff; font-weight: 600; }
  .ask { margin-top: auto; display: flex; justify-content: space-between; align-items: center; min-height: 48px; padding: 0 14px; border-radius: 12px; border: 0; background: var(--gold); color: var(--on-gold); font-weight: 700; cursor: pointer; }
  .ask kbd { font-family: inherit; font-size: 12px; font-weight: 600; background: rgba(12, 58, 85, 0.12); border-radius: 6px; padding: 3px 7px; }
  .me { display: flex; justify-content: space-between; align-items: center; gap: 8px; font-size: 13px; color: var(--tide-muted); padding: 0 4px; }
  .who { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .out { background: none; border: 0; color: var(--tide-muted); cursor: pointer; text-decoration: underline; font-size: 13px; min-height: 32px; }
  .content { min-width: 0; outline: none; }
  .top, .bottom, .phone-only { display: none; }

  @media (max-width: 719px) {
    .shell { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto 1fr auto; }
    .side { display: none; }
    .top { display: flex; align-items: center; gap: 12px; position: sticky; top: 0; z-index: 20; background: var(--tide); color: #fff; padding: 8px 16px; padding-top: max(8px, env(safe-area-inset-top)); }
    .top :global(.switcher) { flex: 1; min-width: 0; }
    .search { width: 44px; height: 44px; border: 0; background: none; color: #fff; display: flex; align-items: center; justify-content: center; border-radius: 10px; cursor: pointer; }
    .top .badge { text-decoration: none; }
    .bottom { display: grid; grid-auto-flow: column; grid-auto-columns: minmax(0, 1fr); position: fixed; bottom: 0; left: 0; right: 0; z-index: 40; background: var(--surface); border-top: 1px solid var(--border); padding: 6px 4px calc(8px + env(safe-area-inset-bottom)); }
    .bottom a { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; min-height: 48px; font-size: 12px; color: var(--muted); text-decoration: none; }
    .bottom a[aria-current="page"] { color: var(--text); font-weight: 700; }
    .tick { width: 22px; height: 4px; border-radius: 2px; }
    .bottom a[aria-current="page"] .tick { background: var(--text); }
    .phone-only { display: block; }
    .full .content { padding-bottom: 0; }
  }
</style>
