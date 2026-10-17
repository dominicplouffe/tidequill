/** Caret helpers for plain-text contenteditable elements. */

export function makeEditable(el: HTMLElement) {
  el.contentEditable = "plaintext-only";
  if (el.contentEditable !== "plaintext-only") el.contentEditable = "true";
}

/** Text of an editable as the user sees it. */
export function editableText(el: HTMLElement): string {
  const t = el.innerText.replace(/ /g, " ");
  return t.endsWith("\n") && !t.endsWith("\n\n") ? t.slice(0, -1) : t;
}

export function caretOffset(el: HTMLElement): number {
  const sel = getSelection();
  if (!sel || !sel.rangeCount) return 0;
  const range = sel.getRangeAt(0);
  if (!el.contains(range.endContainer)) return 0;
  const pre = range.cloneRange();
  pre.selectNodeContents(el);
  pre.setEnd(range.endContainer, range.endOffset);
  return pre.toString().length;
}

export function selectionOffsets(el: HTMLElement): [number, number] | null {
  const sel = getSelection();
  if (!sel || !sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  if (!el.contains(range.startContainer) || !el.contains(range.endContainer)) return null;
  const a = range.cloneRange();
  a.selectNodeContents(el);
  a.setEnd(range.startContainer, range.startOffset);
  const start = a.toString().length;
  return [start, start + range.toString().length];
}

function locate(el: HTMLElement, offset: number): [Node, number] {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let left = offset;
  let node: Node | null = walker.nextNode();
  let last: Node | null = null;
  while (node) {
    const len = node.textContent?.length ?? 0;
    if (left <= len) return [node, left];
    left -= len;
    last = node;
    node = walker.nextNode();
  }
  if (last) return [last, last.textContent?.length ?? 0];
  return [el, 0];
}

export function setCaret(el: HTMLElement, offset: number | "end") {
  el.focus({ preventScroll: false });
  const len = el.textContent?.length ?? 0;
  const [node, off] = locate(el, offset === "end" ? len : Math.min(offset, len));
  const range = document.createRange();
  range.setStart(node, off);
  range.collapse(true);
  const sel = getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}

export function selectRange(el: HTMLElement, start: number, end: number) {
  el.focus();
  const [sn, so] = locate(el, start);
  const [en, eo] = locate(el, end);
  const range = document.createRange();
  range.setStart(sn, so);
  range.setEnd(en, eo);
  const sel = getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}

/** A DOM Range over [start, end) of an element's text, for highlights. */
export function rangeFor(el: HTMLElement, start: number, end: number): Range {
  const [sn, so] = locate(el, start);
  const [en, eo] = locate(el, end);
  const range = document.createRange();
  range.setStart(sn, so);
  range.setEnd(en, eo);
  return range;
}

export function atStart(el: HTMLElement): boolean {
  const sel = getSelection();
  return !!sel && sel.isCollapsed && caretOffset(el) === 0;
}

export function insertPlainText(text: string) {
  // execCommand keeps the native undo stack; fall back to a range insert.
  if (!document.execCommand?.("insertText", false, text)) {
    const sel = getSelection();
    if (!sel?.rangeCount) return;
    const r = sel.getRangeAt(0);
    r.deleteContents();
    r.insertNode(document.createTextNode(text));
    r.collapse(false);
  }
}
