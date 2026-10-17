<script lang="ts">
  import type { Component } from "svelte";
  import CommandBar from "./components/CommandBar.svelte";
  import Shell from "./components/Shell.svelte";
  import Toasts from "./components/Toasts.svelte";
  import { navigate, onNavigate, router } from "./lib/router.svelte.ts";
  import { boot, refreshSites, session } from "./lib/session.svelte.ts";
  import { closeCommand, openCommand, ui } from "./lib/ui.svelte.ts";
  import { installOfflineSync } from "./lib/offline.ts";
  import { toast } from "./lib/toast.svelte.ts";
  import Auth from "./routes/Auth.svelte";
  import Today from "./routes/Today.svelte";

  type Loader = () => Promise<{ default: Component<any> }>;
  const loaders: Record<string, Loader> = {
    ask: () => import("./routes/Ask.svelte"),
    draft: () => import("./routes/Draft.svelte"),
    author: () => import("./routes/Author.svelte"),
    authors: () => import("./routes/Authors.svelte"),
    live: () => import("./routes/Live.svelte"),
    settings: () => import("./routes/Settings.svelte"),
    capture: () => import("./routes/Capture.svelte"),
    onboarding: () => import("./routes/Onboarding.svelte"),
    notfound: () => import("./routes/NotFound.svelte"),
  };

  let Page = $state<Component<any> | null>(null);
  let pageName = $state("");
  let loadError = $state(false);

  boot();
  // Keep the Today badge fresh as people move around (sites.list carries waiting counts).
  let lastRefresh = Date.now();
  onNavigate(() => {
    if (session.user && Date.now() - lastRefresh > 15_000) {
      lastRefresh = Date.now();
      refreshSites();
    }
  });
  installOfflineSync((n) => toast(`Back online. ${n === 1 ? "1 capture" : `${n} captures`} uploaded.`));

  const route = $derived(router.route);
  const bare = $derived(route.name === "onboarding" || route.name === "invite" || route.name === "signin");

  // Guards: signed in → sites → onboarding.
  $effect(() => {
    if (!session.ready || !session.user) return;
    if (route.name === "home" || route.name === "signin") navigate(session.sites.length ? "/today" : "/onboarding", { replace: true });
    else if (!session.sites.length && route.name !== "onboarding" && route.name !== "invite") navigate("/onboarding", { replace: true });
  });

  $effect(() => {
    const name = route.name;
    if (name === "today" || name === "home" || name === "signin" || name === "invite") {
      Page = null;
      pageName = name;
      return;
    }
    const load = loaders[name] ?? loaders.notfound!;
    loadError = false;
    load()
      .then((m) => {
        if (router.route.name === name) {
          Page = m.default;
          pageName = name;
        }
      })
      .catch(() => (loadError = true));
  });

  $effect(() => {
    // Titles help screen-reader users and tab switching.
    const titles: Record<string, string> = { today: "Today", ask: "Ask", draft: "Draft", author: "Author", authors: "Authors", live: "Your site", settings: "Settings", capture: "Capture", onboarding: "Set up your site" };
    document.title = `${titles[route.name] ?? "Tidequill"} · Tidequill`;
  });

  function onKeydown(e: KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      if (ui.commandOpen) closeCommand();
      else if (session.user && session.sites.length) openCommand();
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />

{#if !session.ready}
  <div class="splash" aria-busy="true" aria-label="Loading Tidequill"></div>
{:else if !session.user}
  <Auth mode={route.name === "invite" ? "invite" : session.needsSetup ? "setup" : "signin"} token={route.params.token} />
{:else if bare}
  {#if route.name === "invite"}
    <Auth mode="invite" token={route.params.token} />
  {:else if Page && pageName === route.name}
    <Page params={route.params} query={route.query} />
  {/if}
{:else}
  <Shell>
    {#if route.name === "today" || route.name === "home"}
      <Today />
    {:else if loadError}
      <div class="page"><p class="error-box">This screen didn't load. Check your connection and <button class="linkish" onclick={() => location.reload()}>reload</button>.</p></div>
    {:else if Page && pageName === route.name}
      {#key route.name === "draft" || route.name === "author" ? route.path : route.name}
        <Page params={route.params} query={route.query} />
      {/key}
    {:else}
      <div class="page" aria-busy="true"><div class="skeleton" style="height: 40px; width: 320px"></div><div class="skeleton" style="height: 240px"></div></div>
    {/if}
  </Shell>
{/if}

{#if ui.commandOpen}<CommandBar />{/if}
<Toasts />

<style>
  .splash { min-height: 100vh; background: var(--bg); }
</style>
