<script lang="ts">
  import { navigate } from "../lib/router.svelte.ts";
  import { modKey } from "../lib/ui.svelte.ts";

  let { placeholder = "Ask anything. Write a post as Suzie, make the site warmer, fix my titles…", context = "" }: { placeholder?: string; context?: string } = $props();
  let text = $state("");

  function submit(e: Event) {
    e.preventDefault();
    const q = text.trim();
    if (!q) return navigate("/ask");
    navigate(`/ask?q=${encodeURIComponent(q)}&send=1${context}`);
  }
</script>

<form class="askbox" onsubmit={submit} role="search">
  <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="8" fill="#F4D35E" /><path d="M6 10h8M10 6v8" stroke="#0C3A55" stroke-width="1.8" /></svg>
  <label class="sr-only" for="askbox-input">Ask Tidequill</label>
  <input id="askbox-input" bind:value={text} {placeholder} autocomplete="off" />
  <kbd aria-hidden="true">{modKey}</kbd>
</form>

<style>
  .askbox { display: flex; align-items: center; gap: 12px; min-height: 60px; padding: 0 20px; border-radius: 16px; background: var(--surface); border: 1px solid var(--border); box-shadow: var(--shadow); }
  .askbox:focus-within { outline: 3px solid var(--focus); outline-offset: 0; border-color: transparent; }
  input { flex: 1; min-width: 0; border: 0; outline: none; font-size: 17px; background: transparent; color: var(--text); }
  kbd { font-family: inherit; font-size: 13px; color: var(--muted); border: 1px solid var(--border); border-radius: 6px; padding: 3px 8px; }
  @media (max-width: 719px) { kbd { display: none; } .askbox { min-height: 52px; padding: 0 14px; } input { font-size: 16px; } }
</style>
