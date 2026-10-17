<script lang="ts">
  import { BLOCK_LABEL, BLOCK_MENU, type BlockKind } from "../lib/blocks.ts";
  import { atStart, caretOffset } from "../lib/caret.ts";
  import type { Block } from "../lib/types.ts";
  import Editable from "./Editable.svelte";

  let {
    block = $bindable(),
    first = false,
    last = false,
    imageUrl = null,
    onchange,
    onsplit,
    onmergeup,
    onconvert,
    ondelete,
    onmove,
    onexitlist,
    onfocusblock,
  }: {
    block: Block;
    first?: boolean;
    last?: boolean;
    imageUrl?: string | null;
    onchange: () => void;
    onsplit: (before: string, after: string) => void;
    onmergeup: () => void;
    onconvert: (kind: BlockKind) => void;
    ondelete: () => void;
    onmove: (dir: -1 | 1) => void;
    onexitlist: () => void;
    onfocusblock?: () => void;
  } = $props();

  let menuOpen = $state(false);
  let menuIndex = $state(0);
  let optionsOpen = $state(false);
  let root: HTMLElement | undefined = $state();
  const menuId = `bm-${Math.random().toString(36).slice(2, 8)}`;

  const slashFilter = $derived(block.type === "paragraph" && /^\/[\w ]*$/.test(block.text) ? block.text.slice(1).toLowerCase() : null);
  const menuItems = $derived(slashFilter == null ? BLOCK_MENU : BLOCK_MENU.filter((m) => !slashFilter || m.label.toLowerCase().includes(slashFilter) || m.keywords.includes(slashFilter)));

  $effect(() => {
    menuOpen = slashFilter != null;
    menuIndex = 0;
  });

  function choose(kind: BlockKind) {
    menuOpen = false;
    optionsOpen = false;
    if (block.type === "paragraph" && slashFilter != null) block.text = "";
    onconvert(kind);
  }

  function textKey(e: KeyboardEvent, el: HTMLElement) {
    if (menuOpen && menuItems.length) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        menuIndex = (menuIndex + 1) % menuItems.length;
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        menuIndex = (menuIndex - 1 + menuItems.length) % menuItems.length;
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        choose(menuItems[menuIndex]!.kind);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        menuOpen = false;
        return;
      }
    }
    if (!("text" in block)) return;
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing && block.type !== "code") {
      e.preventDefault();
      const off = caretOffset(el);
      const text = block.text;
      onsplit(text.slice(0, off), text.slice(off));
    } else if (e.key === "Backspace" && atStart(el)) {
      if (!block.text) {
        e.preventDefault();
        ondelete();
      } else if (!first) {
        e.preventDefault();
        onmergeup();
      }
    }
  }

  function listKey(e: KeyboardEvent, el: HTMLElement) {
    if (block.type !== "list") return;
    const text = block.items.join("\n");
    if (e.key === "Enter" && !e.shiftKey && caretOffset(el) === text.length && text.endsWith("\n")) {
      // Enter on an empty last item leaves the list.
      e.preventDefault();
      block.items = block.items.slice(0, -1);
      onchange();
      onexitlist();
    } else if (e.key === "Backspace" && atStart(el) && !text) {
      e.preventDefault();
      ondelete();
    }
  }

  let listText = $state(block.type === "list" ? block.items.join("\n") : "");
  $effect(() => {
    if (block.type === "list" && block.items.join("\n") !== listText) listText = block.items.join("\n");
  });
  function listInput(v: string) {
    if (block.type !== "list") return;
    block.items = v.split("\n");
    onchange();
  }

  function addFaq() {
    if (block.type !== "faq") return;
    block.items = [...block.items, { q: "", a: "" }];
    onchange();
  }

  const placeholders: Partial<Record<Block["type"], string>> = {
    paragraph: "Type, or press / for blocks",
    heading: "Heading",
    answer: "A short, direct answer an assistant could quote",
    quote: "Quote",
    callout: "Note",
  };
</script>

<div class="block type-{block.type}" data-block-id={block.id} bind:this={root} role="group" aria-label={BLOCK_LABEL[block.type]} onfocusin={() => onfocusblock?.()}>
  <div class="tools">
    <button type="button" class="handle" aria-label="Options for this {BLOCK_LABEL[block.type].toLowerCase()}" aria-haspopup="menu" aria-expanded={optionsOpen} onclick={() => (optionsOpen = !optionsOpen)}>⋮</button>
    {#if optionsOpen}
      <div class="menu options fade-in" role="menu" tabindex="-1" onkeydown={(e) => e.key === "Escape" && (optionsOpen = false)}>
        <span class="mh">Turn into</span>
        {#each BLOCK_MENU.filter((m) => m.kind !== "image") as m (m.kind)}
          <button type="button" role="menuitem" onclick={() => choose(m.kind)}>{m.label}</button>
        {/each}
        <span class="sep"></span>
        <button type="button" role="menuitem" disabled={first} onclick={() => ((optionsOpen = false), onmove(-1))}>Move up</button>
        <button type="button" role="menuitem" disabled={last} onclick={() => ((optionsOpen = false), onmove(1))}>Move down</button>
        <button type="button" role="menuitem" class="danger" onclick={() => ((optionsOpen = false), ondelete())}>Remove</button>
      </div>
    {/if}
  </div>

  {#if block.type === "paragraph"}
    <Editable bind:value={block.text} tag="p" label="Paragraph" class="p" placeholder={placeholders.paragraph} onkeydown={textKey} oninput={onchange} />
  {:else if block.type === "heading"}
    <Editable bind:value={block.text} tag={`h${block.level}`} label="Heading level {block.level}" class="h h{block.level}" placeholder="Heading" multiline={false} onkeydown={textKey} oninput={onchange} />
  {:else if block.type === "answer"}
    <div class="answer">
      <span class="tag">Direct answer</span>
      <Editable bind:value={block.text} label="Direct answer" class="p" placeholder={placeholders.answer} onkeydown={textKey} oninput={onchange} />
    </div>
  {:else if block.type === "quote"}
    <blockquote>
      <Editable bind:value={block.text} label="Quote" class="p" placeholder="Quote" onkeydown={textKey} oninput={onchange} />
      <input class="cite" placeholder="Who said it (optional)" aria-label="Quote source" value={block.cite ?? ""} oninput={(e) => { if (block.type === "quote") { block.cite = (e.currentTarget as HTMLInputElement).value || undefined; onchange(); } }} />
    </blockquote>
  {:else if block.type === "callout"}
    <div class="callout tone-{block.tone}">
      <span class="tag">{block.tone === "tip" ? "Tip" : block.tone === "warning" ? "Warning" : block.tone === "disclosure" ? "Disclosure" : "Note"}</span>
      <Editable bind:value={block.text} label="Note" class="p" placeholder="Note" onkeydown={textKey} oninput={onchange} />
    </div>
  {:else if block.type === "list"}
    <Editable bind:value={listText} tag={block.ordered ? "ol" : "ul"} label="{block.ordered ? 'Numbered' : 'Bulleted'} list, one item per line" class="list {block.ordered ? 'ordered' : ''}" placeholder="One item per line" onkeydown={listKey} oninput={listInput} />
  {:else if block.type === "faq"}
    <div class="faq">
      <span class="tag">FAQ</span>
      {#each block.items as item, i (i)}
        <div class="qa">
          <input class="q" aria-label="Question {i + 1}" placeholder="Question" bind:value={item.q} oninput={onchange} />
          <textarea class="a" aria-label="Answer {i + 1}" placeholder="Answer" rows="2" bind:value={item.a} oninput={onchange}></textarea>
        </div>
      {/each}
      <button type="button" class="btn btn-sm" onclick={addFaq}>Add a question</button>
    </div>
  {:else if block.type === "image"}
    <figure class="image">
      {#if imageUrl}<img src={imageUrl} alt={block.alt} />{:else}<div class="ph">{block.src ? "Photo" : "Uploading…"}</div>{/if}
      <input aria-label="Describe the photo (alt text)" placeholder="Describe the photo for people who can't see it" bind:value={block.alt} oninput={onchange} />
      <input aria-label="Caption" placeholder="Caption (optional)" value={block.caption ?? ""} oninput={(e) => { if (block.type === "image") { block.caption = (e.currentTarget as HTMLInputElement).value; onchange(); } }} />
    </figure>
  {:else if block.type === "code"}
    <textarea class="code" aria-label="Code" rows={Math.max(3, block.text.split("\n").length)} bind:value={block.text} oninput={onchange}></textarea>
  {:else if block.type === "divider"}
    <hr />
  {:else if block.type === "table"}
    <div class="readonly" role="note">
      <table><thead><tr>{#each block.header as h, i (i)}<th>{h}</th>{/each}</tr></thead><tbody>{#each block.rows as r, i (i)}<tr>{#each r as c, j (j)}<td>{c}</td>{/each}</tr>{/each}</tbody></table>
      <span class="hint">Ask to change tables: select a row and press Ask.</span>
    </div>
  {:else if block.type === "evidence"}
    <div class="evidence readonly"><span class="tag">First-hand {block.kind}</span><p>{block.text}</p></div>
  {/if}

  {#if menuOpen && menuItems.length}
    <div class="menu slash fade-in" role="listbox" id={menuId} aria-label="Insert a block">
      {#each menuItems as m, i (m.kind)}
        <div role="option" tabindex="-1" aria-selected={i === menuIndex} class:active={i === menuIndex} onmousedown={(e) => { e.preventDefault(); choose(m.kind); }} onkeydown={() => {}} onmousemove={() => (menuIndex = i)}>
          <strong>{m.label}</strong><span>{m.hint}</span>
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .block { position: relative; padding: 2px 0; border-radius: 8px; }
  .tools { position: absolute; left: -40px; top: 2px; }
  .handle { width: 28px; height: 32px; border: 0; background: none; color: var(--muted); border-radius: 6px; cursor: pointer; opacity: 0; font-size: 18px; transition: opacity var(--t) var(--ease); }
  .block:hover .handle, .block:focus-within .handle, .handle[aria-expanded="true"] { opacity: 1; }
  .handle:hover { background: var(--sunken); }
  .menu { position: absolute; z-index: 25; background: var(--surface); border: 1px solid var(--border); border-radius: 12px; box-shadow: var(--shadow-pop); padding: 6px; display: flex; flex-direction: column; min-width: 220px; font-family: var(--font-ui); font-size: 14px; }
  .options { left: 0; top: 34px; }
  .options button { text-align: left; border: 0; background: none; padding: 8px 10px; border-radius: 8px; cursor: pointer; color: var(--text); }
  .options button:hover, .options button:focus-visible { background: var(--sunken); }
  .options button:disabled { opacity: 0.4; }
  .danger { color: var(--bad) !important; }
  .mh { font-size: 12px; color: var(--muted); padding: 6px 10px 2px; font-weight: 600; }
  .sep { height: 1px; background: var(--border-soft); margin: 4px 0; }
  .slash { left: 0; top: 100%; max-height: 320px; overflow-y: auto; }
  .slash [role="option"] { display: flex; flex-direction: column; padding: 8px 10px; border-radius: 8px; cursor: pointer; }
  .slash [role="option"] span { font-size: 12px; color: var(--muted); }
  .slash .active { background: var(--gold-soft); }

  .block :global(.p) { font-size: 19px; line-height: 1.65; margin: 0; }
  .block :global(.h) { font-family: var(--font-ui); font-weight: 700; margin: 8px 0 0; }
  .block :global(.h2) { font-size: 24px; }
  .block :global(.h3) { font-size: 20px; }
  .block :global(.h4) { font-size: 18px; }
  .block :global(.list) { font-size: 19px; line-height: 1.65; margin: 0; padding-left: 0; list-style: none; }
  .block :global(.list:not(.empty)) { background-image: none; }
  .type-list :global(.list) { border-left: 3px solid var(--border); padding-left: 16px; }
  .tag { font-family: var(--font-ui); font-size: 12px; font-weight: 700; color: var(--muted); text-transform: none; }
  .answer { background: var(--chip); border-radius: 10px; padding: 12px 16px; display: flex; flex-direction: column; gap: 4px; }
  .answer .tag { color: var(--chip-text); }
  blockquote { margin: 0; border-left: 3px solid var(--gold); padding-left: 16px; font-style: italic; display: flex; flex-direction: column; gap: 4px; }
  .cite, .image input, .q { font-family: var(--font-ui); font-size: 14px; border: 0; border-bottom: 1px dashed var(--border); background: transparent; padding: 6px 0; color: var(--muted); outline: none; width: 100%; font-style: normal; }
  .cite:focus-visible, .image input:focus-visible, .q:focus-visible { border-bottom-color: var(--focus); border-bottom-style: solid; }
  .callout { background: var(--surface-2); border: 1px solid var(--border); border-radius: 10px; padding: 12px 16px; display: flex; flex-direction: column; gap: 4px; }
  .faq { display: flex; flex-direction: column; gap: 12px; border: 1px solid var(--border); border-radius: 10px; padding: 12px 16px; }
  .faq .btn { align-self: flex-start; }
  .qa { display: flex; flex-direction: column; gap: 4px; }
  .q { font-size: 17px !important; font-weight: 600; color: var(--text) !important; }
  .a { font-family: var(--font-content); font-size: 17px; line-height: 1.5; border: 0; resize: vertical; background: transparent; color: var(--text); outline: none; padding: 4px 0; }
  .image { margin: 0; display: flex; flex-direction: column; gap: 6px; }
  .image img { border-radius: 12px; max-height: 420px; object-fit: cover; width: 100%; }
  .ph { height: 200px; border-radius: 12px; background: var(--sunken); display: flex; align-items: center; justify-content: center; color: var(--muted); font-family: var(--font-ui); font-size: 14px; }
  .code { font-family: ui-monospace, Menlo, monospace; font-size: 14px; width: 100%; border-radius: 10px; border: 1px solid var(--border); background: var(--surface-2); color: var(--text); padding: 12px; resize: vertical; }
  hr { border: 0; border-top: 2px solid var(--border); margin: 16px 0; }
  .readonly { font-family: var(--font-ui); font-size: 14px; display: flex; flex-direction: column; gap: 6px; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid var(--border); padding: 6px 8px; text-align: left; }
  .evidence { background: var(--surface-2); border-radius: 10px; padding: 12px 16px; }
  @media (max-width: 719px) { .tools { left: auto; right: 0; top: -30px; } .handle { opacity: 0.6; } }
</style>
