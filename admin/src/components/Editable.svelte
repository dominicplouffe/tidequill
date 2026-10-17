<script lang="ts">
  import { editableText, insertPlainText, makeEditable } from "../lib/caret.ts";

  /** A plain-text contenteditable field bound to a string (inline markdown stays as typed). */
  let {
    value = $bindable(""),
    tag = "div",
    label,
    placeholder = "",
    class: cls = "",
    multiline = true,
    onkeydown,
    oninput,
    onfocus,
    onblur,
    element = $bindable(),
  }: {
    value?: string;
    tag?: string;
    label: string;
    placeholder?: string;
    class?: string;
    multiline?: boolean;
    onkeydown?: (e: KeyboardEvent, el: HTMLElement) => void;
    oninput?: (value: string, el: HTMLElement) => void;
    onfocus?: (el: HTMLElement) => void;
    onblur?: (el: HTMLElement) => void;
    element?: HTMLElement;
  } = $props();

  let el: HTMLElement | undefined = $state();
  let empty = $state(!value);

  $effect(() => {
    if (!el) return;
    element = el;
    makeEditable(el);
  });

  // Push outside changes into the DOM, but never under the caret.
  $effect(() => {
    const v = value;
    if (!el) return;
    if (document.activeElement === el && editableText(el) === v) return;
    if (editableText(el) !== v) el.textContent = v;
    empty = !v;
  });

  function handleInput() {
    if (!el) return;
    let v = editableText(el);
    if (!multiline) v = v.replace(/\n/g, " ");
    value = v;
    empty = !v;
    oninput?.(v, el);
  }

  function handlePaste(e: ClipboardEvent) {
    const text = e.clipboardData?.getData("text/plain");
    if (text == null) return;
    e.preventDefault();
    insertPlainText(multiline ? text : text.replace(/\s*\n\s*/g, " "));
  }

  function handleKey(e: KeyboardEvent) {
    if (!el) return;
    if (!multiline && e.key === "Enter") e.preventDefault();
    onkeydown?.(e, el);
  }
</script>

<svelte:element
  this={tag}
  bind:this={el}
  class="editable {cls}"
  class:empty
  role="textbox"
  tabindex="0"
  aria-multiline={multiline}
  aria-label={label}
  data-placeholder={placeholder}
  data-editable
  spellcheck="true"
  oninput={handleInput}
  onpaste={handlePaste}
  onkeydown={handleKey}
  onfocus={() => el && onfocus?.(el)}
  onblur={() => el && onblur?.(el)}
></svelte:element>

<style>
  .editable { outline: none; white-space: pre-wrap; overflow-wrap: anywhere; min-height: 1.4em; cursor: text; }
  .editable:focus-visible { outline: none; box-shadow: -3px 0 0 0 var(--focus); }
  .empty::before { content: attr(data-placeholder); color: var(--muted); opacity: 0.7; pointer-events: none; }
</style>
