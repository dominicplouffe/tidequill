/** Inline markdown subset → safe HTML, for previews in the admin and the live overlay. */

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function safeHref(href: string): string {
  if (href.startsWith("tq:")) return "#";
  if (/^(https?:|mailto:|\/|#)/i.test(href)) return href;
  return "#";
}

export function inlineHtml(text: string): string {
  let s = escapeHtml(text);
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, a, h) => `<a href="${escapeHtml(safeHref(h.replace(/&amp;/g, "&")))}">${a}</a>`);
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>");
  s = s.replace(/\{\{\s*fact:([\w.-]+)\s*\}\}/g, '<span class="tq-fact" title="Tracked fact: $1">$1</span>');
  return s;
}

/** Plain text of inline markdown. */
export function plainInline(text: string): string {
  return text
    .replace(/\{\{\s*fact:([\w.-]+)\s*\}\}/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1");
}
