<script lang="ts">
  import { command } from "../lib/api.ts";
  import { navigate } from "../lib/router.svelte.ts";
  import { closeCommand, ui } from "../lib/ui.svelte.ts";
  import type { CommandResult } from "../lib/types.ts";

  /**
   * ⌘K: one input that searches, navigates and acts. "Do it" items go to Ask;
   * "Go to" items navigate. Arrow keys move, Return runs, Esc closes.
   */

  type Item = { id: string; section: "Do it" | "Go to" | "Recent"; label: string; hint?: string; ask?: string; href?: string; kind?: string };

  const RECENT_KEY = "tq.recent";
  const BUILTIN: { label: string; href: string; kind: string; words: string }[] = [
    { label: "Today", href: "/today", kind: "screen", words: "today inbox approvals waiting home" },
    { label: "Ask Tidequill", href: "/ask", kind: "screen", words: "ask chat agent" },
    { label: "Your site (live editing)", href: "/live?path=/", kind: "screen", words: "site live edit look page" },
    { label: "Settings", href: "/settings", kind: "screen", words: "settings members invite tokens mcp domains budget cadence" },
    { label: "Authors and voices", href: "/authors", kind: "screen", words: "authors voice writers fred" },
    { label: "Capture something", href: "/capture", kind: "screen", words: "capture photo voice note evidence camera" },
  ];

  let query = $state(ui.commandQuery);
  let result = $state<CommandResult | null>(null);
  let active = $state(0);
  let loading = $state(false);
  let input: HTMLInputElement | undefined = $state();
  let dialog: HTMLElement | undefined = $state();
  let previousFocus: Element | null = null;
  let ctrl: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function recent(): Item[] {
    try {
      return (JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]") as Item[]).slice(0, 5).map((r, i) => ({ ...r, id: `r${i}`, section: "Recent" as const }));
    } catch {
      return [];
    }
  }
  function remember(item: Item) {
    try {
      const list = (JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]") as Item[]).filter((r) => r.label !== item.label);
      list.unshift({ ...item, section: "Recent" });
      localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 8)));
    } catch {
      /* ignore */
    }
  }

  const items = $derived.by<Item[]>(() => {
    const q = query.trim();
    const out: Item[] = [];
    if (!q) {
      out.push(...recent());
      for (const b of BUILTIN) out.push({ id: `b${b.href}`, section: "Go to", label: b.label, href: b.href, kind: b.kind });
      return out;
    }
    const doIt = result?.doIt ?? [];
    doIt.forEach((d, i) => out.push({ id: `d${i}`, section: "Do it", label: d.label, hint: d.hint, ask: d.ask }));
    if (!doIt.some((d) => d.ask.trim().toLowerCase() === q.toLowerCase())) {
      out.push({ id: "dq", section: "Do it", label: `Ask: “${q}”`, hint: "Shows a plan first; nothing changes until you approve", ask: q });
    }
    const goTo = result?.goTo ?? [];
    goTo.forEach((g, i) => out.push({ id: `g${i}`, section: "Go to", label: g.label, href: g.href, kind: g.kind }));
    const lq = q.toLowerCase();
    for (const b of BUILTIN) {
      if ((b.label.toLowerCase().includes(lq) || b.words.includes(lq)) && !goTo.some((g) => g.href === b.href)) out.push({ id: `b${b.href}`, section: "Go to", label: b.label, href: b.href, kind: b.kind });
    }
    return out;
  });

  const sections = $derived.by(() => {
    const map = new Map<string, { item: Item; index: number }[]>();
    items.forEach((item, index) => {
      if (!map.has(item.section)) map.set(item.section, []);
      map.get(item.section)!.push({ item, index });
    });
    return [...map.entries()];
  });

  function search() {
    clearTimeout(timer);
    active = 0;
    const q = query.trim();
    if (!q) {
      result = null;
      return;
    }
    timer = setTimeout(async () => {
      ctrl?.abort();
      ctrl = new AbortController();
      loading = true;
      try {
        result = await command(q, ctrl.signal);
      } catch (err) {
        if ((err as Error).name !== "AbortError") result = null;
      } finally {
        loading = false;
      }
    }, 140);
  }

  function runItem(item: Item | undefined) {
    if (!item) return;
    remember(item);
    closeCommand();
    if (item.ask) navigate(`/ask?q=${encodeURIComponent(item.ask)}&send=1`);
    else if (item.href) navigate(item.href);
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      closeCommand();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      active = (active + 1) % Math.max(1, items.length);
      scrollActive();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      active = (active - 1 + items.length) % Math.max(1, items.length);
      scrollActive();
    } else if (e.key === "Enter") {
      e.preventDefault();
      runItem(items[active]);
    } else if (e.key === "Tab") {
      // Focus trap: the input is the only tab stop; options are reached with arrows.
      e.preventDefault();
      input?.focus();
    }
  }

  function scrollActive() {
    queueMicrotask(() => dialog?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" }));
  }

  $effect(() => {
    previousFocus = document.activeElement;
    input?.focus();
    if (query) search();
    return () => {
      ctrl?.abort();
      clearTimeout(timer);
      (previousFocus as HTMLElement | null)?.focus?.();
    };
  });
</script>

<div class="backdrop" onclick={closeCommand} aria-hidden="true"></div>
<div class="dialog fade-in" role="dialog" aria-modal="true" aria-label="Command bar" bind:this={dialog} onkeydown={onKeydown} tabindex="-1">
  <label class="search">
    <svg width="22" height="22" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="8" fill="#F4D35E" /><path d="M6 10h8M10 6v8" stroke="#0C3A55" stroke-width="1.8" /></svg>
    <span class="sr-only">Search or ask</span>
    <input
      bind:this={input}
      bind:value={query}
      oninput={search}
      placeholder="Search or ask"
      role="combobox"
      aria-expanded="true"
      aria-controls="cmd-list"
      aria-autocomplete="list"
      aria-activedescendant={items[active] ? `cmd-${items[active].id}` : undefined}
      autocomplete="off"
      spellcheck="false"
    />
    {#if loading}<span class="spin" aria-hidden="true"></span>{/if}
    <kbd>Esc</kbd>
  </label>

  <div class="list" id="cmd-list" role="listbox" aria-label="Suggestions">
    {#each sections as [name, entries] (name)}
      <div role="group" aria-labelledby="sec-{name.replace(/\s/g, '')}">
        <div class="section" id="sec-{name.replace(/\s/g, '')}">{name}</div>
        {#each entries as { item, index } (item.id)}
          <div
            id="cmd-{item.id}"
            role="option"
            tabindex="-1"
            aria-selected={index === active}
            class="option"
            class:active={index === active}
            data-index={index}
            onclick={() => runItem(item)}
            onkeydown={() => {}}
            onmousemove={() => (active = index)}
          >
            <span class="dot" class:gold={!!item.ask} aria-hidden="true"></span>
            <span class="text">
              <span class="label">{item.label}</span>
              {#if item.hint}<span class="hint">{item.hint}</span>{:else if item.kind && item.kind !== "screen"}<span class="hint">{item.kind}</span>{/if}
            </span>
            {#if index === active}<kbd>Return</kbd>{/if}
          </div>
        {/each}
      </div>
    {:else}
      <p class="empty">Type to search, or say what you want done.</p>
    {/each}
  </div>

  <div class="foot"><span>Arrow keys to move, Return to run</span><span>Searches, navigates and acts in one place</span></div>
</div>

<style>
  .backdrop { position: fixed; inset: 0; background: rgba(12, 58, 85, 0.55); z-index: 90; }
  .dialog { position: fixed; z-index: 91; left: 50%; top: 12vh; transform: translateX(-50%); width: min(680px, calc(100vw - 24px)); max-height: 76vh; background: var(--surface); border-radius: 20px; box-shadow: 0 30px 80px rgba(12, 58, 85, 0.35); overflow: hidden; display: flex; flex-direction: column; outline: none; }
  .search { display: flex; align-items: center; gap: 14px; padding: 0 22px; min-height: 68px; border-bottom: 1px solid var(--border-soft); }
  input { flex: 1; min-width: 0; border: 0; outline: none; font-size: 21px; background: transparent; color: var(--text); }
  kbd { font-family: inherit; font-size: 12px; color: var(--muted); border: 1px solid var(--border); border-radius: 6px; padding: 3px 8px; white-space: nowrap; }
  .option kbd { color: var(--on-gold); background: rgba(12, 58, 85, 0.08); border: 0; font-weight: 600; }
  .list { padding: 10px; overflow-y: auto; display: flex; flex-direction: column; gap: 2px; }
  .section { padding: 8px 12px 4px; font-size: 12px; font-weight: 600; color: var(--muted); }
  .option { display: flex; align-items: center; gap: 12px; padding: 12px; border-radius: 12px; cursor: pointer; }
  .option.active { background: var(--gold-soft); }
  .dot { width: 10px; height: 10px; border-radius: 50%; background: var(--border); flex: none; }
  .dot.gold { background: var(--gold); }
  .text { display: flex; flex-direction: column; gap: 2px; flex: 1; min-width: 0; }
  .label { font-size: 16px; font-weight: 600; }
  .hint { font-size: 13px; color: var(--muted); }
  .empty { padding: 16px 12px; color: var(--muted); }
  .foot { display: flex; justify-content: space-between; gap: 12px; padding: 12px 22px; border-top: 1px solid var(--border-soft); background: var(--surface-2); font-size: 12px; color: var(--muted); flex-wrap: wrap; }
  .spin { width: 16px; height: 16px; border-radius: 50%; border: 2px solid var(--border); border-top-color: var(--ocean); animation: spin 0.8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (max-width: 719px) { .dialog { top: 12px; } input { font-size: 18px; } .foot span:last-child { display: none; } }
</style>
