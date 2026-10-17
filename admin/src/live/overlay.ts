/**
 * Live-site editing overlay. Loaded by GET /live/:siteId/<path> on the admin
 * host, which sets window.__TQ_LIVE__ and marks blocks with data-tq-block.
 * Everything we draw lives in a Shadow DOM so the page's own styles are untouched.
 */
import css from "./overlay.css?inline";
import { escapeHtml, inlineHtml } from "../lib/inline.ts";

interface LiveCfg {
  siteId: string;
  entryId: string | null;
  path: string;
  siteName: string;
  domain: string | null;
}
type Block = { id: string; type: string; text?: string; level?: number; items?: string[]; cite?: string; tone?: string; [k: string]: any };

const cfg: LiveCfg | undefined = (window as any).__TQ_LIVE__;
const TOAST_KEY = "tq.live.toast";
const LS = {
  get(k: string) {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k: string, v: string) {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* ignore */
    }
  },
};

// ---------- API ----------

async function api(method: string, path: string, body?: unknown): Promise<any> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: { accept: "application/json", ...(body instanceof FormData ? {} : body ? { "content-type": "application/json" } : {}), "x-tq-site": cfg!.siteId },
      body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error("Can't reach Tidequill right now. Nothing was changed.");
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const e = new Error(data?.error?.message ?? "Something went wrong. Nothing was changed.");
    (e as any).code = data?.error?.code ?? (res.status === 404 ? "not_found" : "failed");
    throw e;
  }
  return data;
}
const act = (name: string, input: unknown = {}, options: unknown = {}) => api("POST", `/api/actions/${name}`, { input, options });
const result = (r: any) => (r?.status === "done" || r?.status === "applied" ? r.result : r);

// ---------- DOM helpers ----------

function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, any> = {}, ...kids: (Node | string | null | false)[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else if (k === "html") el.innerHTML = v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const kid of kids) if (kid) el.append(kid);
  return el;
}

const LOGO =
  '<svg width="28" height="28" viewBox="0 0 30 30" aria-hidden="true"><rect width="30" height="30" rx="8" fill="#0E6E9E"/><path d="M21.5 5.5c-5.5 1.5-9 6.5-10.5 13.5l2.2.8c1.6-5.4 4.4-10.2 8.3-14.3z" fill="#F4D35E"/><path d="M5 23c2.5-1.8 4.5-1.8 7 0s4.5 1.8 7 0 4.5-1.8 6 0" stroke="#7DD3FC" stroke-width="1.8" fill="none" stroke-linecap="round"/></svg>';
const PLUS = '<svg width="16" height="16" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="8" fill="#F4D35E"/><path d="M6 10h8M10 6v8" stroke="#0C3A55" stroke-width="2"/></svg>';
const TYPE_LABEL: Record<string, string> = { paragraph: "Paragraph", heading: "Heading", list: "List", quote: "Quote", image: "Image", answer: "Direct answer", callout: "Note", faq: "FAQ", table: "Table", code: "Code", evidence: "Evidence", divider: "Divider" };
const EDITABLE = new Set(["paragraph", "heading", "answer", "quote", "callout", "list"]);

function blockMarkdown(b: Block, text: string): string {
  switch (b.type) {
    case "heading":
      return `${"#".repeat(b.level ?? 2)} ${text.replace(/\n+/g, " ")}`;
    case "answer":
      return `:::answer\n${text}\n:::`;
    case "callout":
      return `:::${b.tone ?? "note"}\n${text}\n:::`;
    case "quote":
      return [...text.split("\n").map((l) => `> ${l}`), ...(b.cite ? [`> — ${b.cite}`] : [])].join("\n");
    case "list":
      return text
        .split("\n")
        .filter((l) => l.trim())
        .map((l, i) => `${b.ordered ? `${i + 1}.` : "-"} ${l.trim()}`)
        .join("\n");
    default:
      return text;
  }
}
function blockText(b: Block): string {
  return b.type === "list" ? (b.items ?? []).join("\n") : b.text ?? "";
}

// ---------- State ----------

const state = {
  blocks: new Map<string, Block>(),
  ready: null as any,
  author: null as string | null,
  title: "",
  waiting: 0,
  askMeFirst: false,
  trust: [] as any[],
  conversationId: null as string | null,
  hover: null as HTMLElement | null,
  selected: null as HTMLElement | null,
  editing: null as { el: HTMLElement; html: string; block: Block | null; field?: string } | null,
};

// ---------- Mount ----------

function mount() {
  if (!cfg || document.getElementById("tq-live-root")) return;

  // Fonts must be declared in the document (not the shadow root); unique family names avoid clashes.
  const fonts = document.createElement("style");
  fonts.textContent = [400, 600, 700].map((w) => `@font-face{font-family:"TQ Hanken";font-weight:${w};font-display:swap;src:url(/fonts/hanken-grotesk-latin-${w}-normal.woff2) format("woff2")}`).join("");
  document.head.append(fonts);

  const host = h("div", { id: "tq-live-root" });
  host.style.cssText = "all:initial;position:fixed;inset:0;z-index:2147483646;pointer-events:none;";
  document.body.append(host);
  const root = host.attachShadow({ mode: "open" });
  root.append(h("style", {}, css));

  // Outline that follows the hovered/selected block.
  const outline = h("div", { class: "tq outline", "aria-hidden": "true" }, h("span", { class: "tag" }, "Section"));
  // Toolbar
  const input = h("input", { type: "text", placeholder: "Click anything, or say what to change", "aria-label": "Tell Tidequill what to change", autocomplete: "off" });
  const waiting = h("a", { class: "waiting", href: "/today", target: "_top", hidden: true }, "");
  const amf = h("button", { type: "button", role: "switch", "aria-checked": "false", class: "switch" }, h("span", {}, "Ask me first"), h("span", { class: "track", "aria-hidden": "true" }, h("span", { class: "thumb" })));
  const collapse = h("button", { type: "button", class: "icon", "aria-label": "Hide the toolbar", title: "Hide" }, "–");
  const form = h("form", { class: "ask", role: "search" }, h("span", { html: PLUS }), input);
  const bar = h(
    "div",
    { class: "tq toolbar", role: "toolbar", "aria-label": "Tidequill" },
    h("a", { class: "brand", href: "/today", target: "_top", "aria-label": "Tidequill, Today", html: LOGO }),
    h("span", { class: "domain" }, cfg.domain ?? cfg.siteName),
    form,
    waiting,
    amf,
    collapse,
  );
  const reopen = h("button", { type: "button", class: "reopen", "aria-label": "Show the Tidequill toolbar", html: LOGO, hidden: true });
  const replies = h("div", { class: "tq replies", role: "log", "aria-live": "polite", hidden: true });
  const pop = h("div", { class: "tq pop", role: "dialog", "aria-label": "Edit this section", hidden: true });
  const fixed = h("div", { class: "tq fixed", role: "status", hidden: true });
  const trust = h("section", { class: "tq trust", "aria-label": "Trust earned so far", hidden: true });
  const toasts = h("div", { class: "tq toasts", "aria-live": "polite" });
  const file = h("input", { type: "file", accept: "image/*", class: "hidden", tabindex: "-1", "aria-hidden": "true" });
  root.append(outline, bar, reopen, replies, pop, fixed, trust, toasts, file);

  // ----- Toasts -----
  function toast(message: string, undo?: () => Promise<unknown>, ms = undo ? 10_000 : 5000) {
    const t = h("div", { class: "toast", role: "status" }, h("span", {}, message));
    if (undo) {
      t.append(
        h("button", {
          type: "button",
          onclick: async () => {
            t.remove();
            try {
              await undo();
            } catch (e) {
              toast((e as Error).message);
            }
          },
        }, "Undo"),
      );
    }
    toasts.append(t);
    setTimeout(() => t.remove(), ms);
  }
  const undoAndReload = (actionId: string) => async () => {
    await act("history.undo", { actionId });
    sessionStorage.setItem(TOAST_KEY, JSON.stringify({ message: "Undone." }));
    location.reload();
  };
  function reloadWith(message: string, actionId?: string | null) {
    sessionStorage.setItem(TOAST_KEY, JSON.stringify({ message, actionId }));
    location.reload();
  }
  function announce(r: any, fallback: string, reload = true) {
    if (r?.status === "applied") {
      if (reload) reloadWith(r.summary || fallback, r.undoable ? r.actionId : null);
      else toast(r.summary || fallback, r.undoable ? undoAndReload(r.actionId) : undefined);
    } else if (r?.status === "proposed") {
      toast(`${r.summary || fallback}. It's waiting on Today for approval.`);
      refreshToday();
    } else toast(fallback);
  }
  try {
    const pending = JSON.parse(sessionStorage.getItem(TOAST_KEY) ?? "null");
    sessionStorage.removeItem(TOAST_KEY);
    if (pending?.message) toast(pending.message, pending.actionId ? undoAndReload(pending.actionId) : undefined);
  } catch {
    /* ignore */
  }

  // ----- Toolbar behaviour -----
  function setCollapsed(c: boolean) {
    bar.hidden = c;
    reopen.hidden = !c;
    if (c) {
      replies.hidden = true;
      closePop();
    }
    LS.set("tq.live.collapsed", c ? "1" : "");
  }
  collapse.addEventListener("click", () => {
    setCollapsed(true);
    reopen.focus();
  });
  reopen.addEventListener("click", () => {
    setCollapsed(false);
    input.focus();
  });
  if (LS.get("tq.live.collapsed")) setCollapsed(true);

  amf.addEventListener("click", async () => {
    const on = !state.askMeFirst;
    setAmf(on);
    try {
      await act("autonomy.ask_me_first", { on });
      toast(on ? "Ask me first is on. Tidequill asks before every change." : "Ask me first is off.", async () => {
        await act("autonomy.ask_me_first", { on: !on });
        setAmf(!on);
      });
    } catch (e) {
      setAmf(!on);
      toast((e as Error).message);
    }
  });
  function setAmf(on: boolean) {
    state.askMeFirst = on;
    amf.setAttribute("aria-checked", String(on));
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const msg = input.value.trim();
    if (!msg) return;
    input.value = "";
    ask(msg, state.selected?.dataset.tqBlock);
  });

  // ----- Ask -----
  async function ask(message: string, blockId?: string) {
    replies.hidden = false;
    replies.replaceChildren(closeBtn(() => (replies.hidden = true)), h("p", { class: "me" }, message), h("p", { class: "thinking" }, "Working on it…"));
    try {
      const r = await api("POST", "/api/ask", { conversationId: state.conversationId ?? undefined, message, context: { entryId: cfg!.entryId ?? undefined, path: cfg!.path, blockId, screen: "live" } });
      state.conversationId = r.conversationId ?? state.conversationId;
      replies.querySelector(".thinking")?.remove();
      for (const m of r.messages ?? []) if (m.role === "assistant") renderMessage(m);
      replies.append(h("a", { class: "more", href: `/ask?c=${encodeURIComponent(state.conversationId ?? "")}`, target: "_top" }, "Continue in Ask →"));
    } catch (e) {
      replies.querySelector(".thinking")?.remove();
      replies.append(h("p", { class: "error" }, (e as Error).message));
    }
  }
  function closeBtn(fn: () => void) {
    return h("button", { type: "button", class: "close", "aria-label": "Close", onclick: fn }, "×");
  }

  function renderMessage(m: any) {
    if (m.text) replies.append(h("p", {}, m.text));
    for (const c of m.cards ?? []) {
      if (c.type === "proposal") {
        const card = h("div", { class: "card" }, h("strong", {}, c.summary));
        const row = h("div", { class: "row" });
        const approve = h("button", { type: "button", class: "primary" }, "Approve");
        const discard = h("button", { type: "button" }, "Discard");
        approve.addEventListener("click", async () => {
          row.replaceChildren(h("span", { class: "muted" }, "Approving…"));
          try {
            const r = result(await act("proposals.approve", { id: c.proposalId }));
            reloadWith(`Approved: ${c.summary}`, r?.undoable ? r.actionId : null);
          } catch (e) {
            row.replaceChildren(h("span", { class: "error" }, (e as Error).message));
          }
        });
        discard.addEventListener("click", async () => {
          row.replaceChildren(h("span", { class: "muted" }, "Discarded"));
          try {
            await act("proposals.discard", { id: c.proposalId });
            refreshToday();
          } catch (e) {
            row.replaceChildren(h("span", { class: "error" }, (e as Error).message));
          }
        });
        row.append(approve, discard);
        if (c.diff?.length) row.append(h("a", { href: `/ask?c=${encodeURIComponent(state.conversationId ?? "")}`, target: "_top" }, "See diff"));
        card.append(row);
        replies.append(card);
      } else if (c.type === "applied") {
        const card = h("div", { class: "card" }, h("span", { class: "gold" }, c.auto ? "Done on its own" : "Done"), h("span", {}, c.summary));
        if (c.undoable) card.append(h("button", { type: "button", onclick: undoAndReload(c.actionId) }, "Undo"));
        replies.append(card);
        sessionStorage.setItem(TOAST_KEY, JSON.stringify({ message: c.summary, actionId: c.undoable ? c.actionId : null }));
        setTimeout(() => location.reload(), 1200);
      } else if (c.type === "navigate") {
        replies.append(h("a", { class: "more", href: c.to, target: "_top" }, `${c.label} →`));
      } else if (c.type === "error") {
        replies.append(h("p", { class: "error" }, c.message));
      } else if (c.type === "progress") {
        const p = h("p", { class: "muted" }, `${c.label}…`);
        replies.append(p);
        pollRun(c.runId, p);
      } else {
        replies.append(h("a", { class: "more", href: `/ask?c=${encodeURIComponent(state.conversationId ?? "")}`, target: "_top" }, "Open in Ask to see this →"));
      }
    }
  }

  async function pollRun(runId: string, el: HTMLElement) {
    for (let i = 0; i < 120; i++) {
      try {
        const r = await api("GET", `/api/runs/${encodeURIComponent(runId)}`);
        el.textContent = `${r.label}: ${r.status === "done" ? "done" : r.status === "failed" ? "didn't finish" : "working…"}`;
        if (r.status === "done" || r.status === "failed" || r.status === "paused") {
          refreshToday();
          if (r.proposalIds?.length) el.append(" ", h("a", { href: "/today", target: "_top" }, "Review on Today"));
          return;
        }
      } catch {
        return;
      }
      await new Promise((res) => setTimeout(res, 2000));
    }
  }

  // ----- Blocks: hover, select, edit -----
  const blocksSel = "[data-tq-block], [data-tq-field]";
  const findBlock = (t: EventTarget | null) => (t instanceof Element ? (t.closest(blocksSel) as HTMLElement | null) : null);
  const labelFor = (el: HTMLElement) => (el.dataset.tqField === "title" ? "Title" : TYPE_LABEL[el.dataset.tqType ?? ""] ?? "Section");

  for (const el of document.querySelectorAll<HTMLElement>(blocksSel)) {
    if (!el.hasAttribute("tabindex")) el.tabIndex = 0;
    if (!el.hasAttribute("aria-label")) el.setAttribute("aria-roledescription", "editable section");
  }

  function place() {
    const el = state.editing?.el ?? state.selected ?? state.hover;
    if (!el || bar.hidden) {
      outline.style.display = "none";
      return;
    }
    const r = el.getBoundingClientRect();
    outline.style.display = "block";
    outline.style.transform = `translate(${r.left - 8}px, ${r.top - 8}px)`;
    outline.style.width = `${r.width + 16}px`;
    outline.style.height = `${r.height + 16}px`;
    outline.classList.toggle("editing", !!state.editing);
    (outline.firstChild as HTMLElement).textContent = state.editing ? "Editing, click outside to save" : labelFor(el);
    if (!pop.hidden && state.selected) placePop(state.selected);
  }
  let raf = 0;
  const schedule = () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(place);
  };
  addEventListener("scroll", schedule, { passive: true, capture: true });
  addEventListener("resize", schedule);

  document.addEventListener("mouseover", (e) => {
    const b = findBlock(e.target);
    if (b !== state.hover) {
      state.hover = b;
      schedule();
    }
  });
  document.addEventListener("focusin", (e) => {
    const b = findBlock(e.target);
    if (b && !state.editing) {
      state.hover = b;
      schedule();
    }
  });
  document.addEventListener("click", (e) => {
    if (bar.hidden || e.composedPath().includes(host)) return;
    const b = findBlock(e.target);
    if (state.editing) return;
    if (!b) return closePop();
    if ((e.metaKey || e.ctrlKey) && (e.target as Element).closest("a")) return; // let links open
    e.preventDefault();
    openPop(b);
  });
  document.addEventListener("dblclick", (e) => {
    if (bar.hidden || e.composedPath().includes(host)) return;
    const b = findBlock(e.target);
    if (b) {
      e.preventDefault();
      startEdit(b);
    }
  });
  document.addEventListener("keydown", (e) => {
    const b = findBlock(e.target);
    if (state.editing) {
      if (e.key === "Escape") {
        e.preventDefault();
        cancelEdit();
      } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        state.editing.el.blur();
      } else if (e.key === "Enter" && !e.shiftKey && (state.editing.block?.type === "heading" || state.editing.field === "title")) {
        e.preventDefault();
        state.editing.el.blur();
      }
      return;
    }
    if (b && e.target === b) {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        openPop(b, true);
      } else if (e.key === "F2" || (e.key === "Enter" && e.shiftKey)) {
        e.preventDefault();
        startEdit(b);
      }
    }
    if (e.key === "Escape" && !pop.hidden) {
      const sel = state.selected;
      closePop();
      sel?.focus();
    }
  });

  // ----- Popover -----
  function placePop(el: HTMLElement) {
    const r = el.getBoundingClientRect();
    const w = 280;
    const right = r.right + 24 + w < innerWidth;
    const left = right ? r.right + 24 : Math.max(12, Math.min(innerWidth - w - 12, r.left));
    const top = right ? Math.max(84, Math.min(innerHeight - 260, r.top)) : Math.min(innerHeight - 250, r.bottom + 16);
    pop.style.transform = `translate(${left}px, ${Math.max(12, top)}px)`;
  }

  function openPop(el: HTMLElement, viaKeyboard = false) {
    state.selected = el;
    const blockId = el.dataset.tqBlock;
    const findings = (state.ready?.findings ?? []).filter((f: any) => f.blockId === blockId && f.severity !== "info");
    const light = findings.length ? "amber" : state.ready?.light ?? "none";
    const word = findings.length ? `${findings.length} ${findings.length === 1 ? "fix" : "fixes"}` : light === "green" ? "Ready" : light === "none" ? "" : state.ready?.headline ?? "";
    const tell = h("input", { type: "text", placeholder: "Or tell me what to change", "aria-label": "Tell Tidequill what to change in this section" });
    const tellForm = h("form", { class: "tell" }, tell);
    tellForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const msg = tell.value.trim();
      if (!msg) return;
      closePop();
      ask(msg, blockId);
    });
    const buttons = h("div", { class: "row" });
    const canEdit = !!cfg!.entryId && !!blockId;
    if (canEdit) {
      if (state.author) buttons.append(h("button", { type: "button", onclick: () => rewrite(blockId!, `Rewrite as ${state.author}`) }, `Rewrite as ${state.author}`));
      else buttons.append(h("button", { type: "button", onclick: () => rewrite(blockId!, "Rewrite this section") }, "Rewrite"));
      buttons.append(h("button", { type: "button", onclick: () => rewrite(blockId!, "Make it shorter") }, "Shorter"));
      buttons.append(h("button", { type: "button", onclick: () => pickPhoto(blockId!) }, "Add a photo"));
    }
    if (el.dataset.tqField === "title" || (blockId && EDITABLE.has(el.dataset.tqType ?? state.blocks.get(blockId)?.type ?? ""))) {
      buttons.append(h("button", { type: "button", onclick: () => startEdit(el) }, "Edit text"));
    }
    pop.replaceChildren(
      h("div", { class: "ph" }, h("strong", {}, el.dataset.tqField === "title" ? "The title" : "This section"), word ? h("span", { class: `ready ${light}` }, h("span", { class: "dot" }), word) : null, closeBtn(closePop)),
      ...(findings.length ? [h("p", { class: "finding" }, findings[0].message)] : []),
      buttons,
      tellForm,
      h("p", { class: "muted" }, "Or double-click the text and type. Every change can be undone."),
    );
    pop.hidden = false;
    placePop(el);
    schedule();
    if (viaKeyboard) (pop.querySelector("button:not(.close)") as HTMLElement | null)?.focus();
  }
  function closePop() {
    pop.hidden = true;
    state.selected = null;
    schedule();
  }

  async function rewrite(blockId: string, instruction: string) {
    closePop();
    toast("Rewriting this section…");
    try {
      const r = await act("posts.rewrite_block", { id: cfg!.entryId, blockId, instruction });
      announce(r, "Rewrote the section");
    } catch (e) {
      toast((e as Error).message);
    }
  }

  let photoFor: string | null = null;
  function pickPhoto(blockId: string) {
    photoFor = blockId;
    closePop();
    file.click();
  }
  file.addEventListener("change", async () => {
    const f = file.files?.[0];
    file.value = "";
    const blockId = photoFor;
    if (!f || !blockId) return;
    toast("Uploading the photo…");
    try {
      // The photo becomes first-hand evidence, placed right after this section.
      const fd = new FormData();
      fd.append("file", f, f.name);
      fd.append("kind", "photo");
      if (state.title) fd.append("topic", state.title.slice(0, 200));
      const up = await api("POST", "/api/evidence", fd);
      const ev = up?.evidence;
      if (!ev?.id) return announce(up, "The photo is waiting for approval");
      announce(await act("evidence.attach", { entryId: cfg!.entryId, evidenceId: ev.id, afterBlockId: blockId }), "Added the photo");
    } catch (e) {
      toast((e as Error).message);
    }
  });

  // ----- Inline editing -----
  function startEdit(el: HTMLElement) {
    if (state.editing) return;
    const isTitle = el.dataset.tqField === "title";
    const blockId = el.dataset.tqBlock;
    const block = blockId ? state.blocks.get(blockId) ?? null : null;
    if (!cfg!.entryId || (!isTitle && (!block || !EDITABLE.has(block.type)))) {
      toast(block ? "This kind of section changes by asking. Tell me what to change." : "This part of the page changes by asking.");
      openPop(el);
      return;
    }
    closePop();
    const html = el.innerHTML;
    state.editing = { el, html, block, field: isTitle ? "title" : undefined };
    el.textContent = isTitle ? (el.textContent ?? "").trim() : blockText(block!);
    el.contentEditable = "plaintext-only";
    if (el.contentEditable !== "plaintext-only") el.contentEditable = "true";
    el.style.whiteSpace = "pre-wrap";
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    getSelection()?.removeAllRanges();
    getSelection()?.addRange(range);
    el.addEventListener("blur", saveEdit, { once: true });
    el.addEventListener("paste", onPaste);
    schedule();
  }
  function onPaste(e: ClipboardEvent) {
    const t = e.clipboardData?.getData("text/plain");
    if (t == null) return;
    e.preventDefault();
    document.execCommand("insertText", false, t);
  }
  function endEdit(): { el: HTMLElement; html: string; block: Block | null; field?: string } | null {
    const ed = state.editing;
    if (!ed) return null;
    state.editing = null;
    ed.el.removeAttribute("contenteditable");
    ed.el.style.whiteSpace = "";
    ed.el.removeEventListener("paste", onPaste);
    schedule();
    return ed;
  }
  function cancelEdit() {
    const ed = state.editing;
    if (!ed) return;
    ed.el.removeEventListener("blur", saveEdit);
    endEdit();
    ed.el.innerHTML = ed.html;
    ed.el.focus();
  }
  async function saveEdit() {
    const ed = endEdit();
    if (!ed) return;
    const text = ed.el.innerText.replace(/ /g, " ").replace(/\n$/, "");
    const before = ed.field === "title" ? (new DOMParser().parseFromString(ed.html, "text/html").body.textContent ?? "").trim() : blockText(ed.block!);
    if (text.trim() === before.trim()) {
      ed.el.innerHTML = ed.html;
      return;
    }
    const simple = ed.field === "title" || ed.block?.type === "paragraph" || ed.block?.type === "heading";
    ed.el.innerHTML = simple ? inlineHtml(text) : escapeHtml(text).replace(/\n/g, "<br>");
    try {
      const r =
        ed.field === "title"
          ? await act("posts.update", { id: cfg!.entryId, title: text.trim() })
          : await act("posts.update_block", { id: cfg!.entryId, blockId: ed.block!.id, markdown: blockMarkdown(ed.block!, text) });
      if (simple && r?.status === "applied") {
        if (ed.block) ed.block.type === "list" ? (ed.block.items = text.split("\n")) : (ed.block.text = text);
        toast("Saved.", r.undoable ? undoAndReload(r.actionId) : undefined);
      } else announce(r, "Saved", !simple);
    } catch (e) {
      ed.el.innerHTML = ed.html;
      toast((e as Error).message);
    }
  }

  // ----- Data -----
  async function loadEntry() {
    if (!cfg!.entryId) return;
    try {
      const e = result(await act("posts.get", { id: cfg!.entryId, includeBlocks: true }));
      for (const b of e?.blocks ?? []) state.blocks.set(b.id, b);
      state.ready = e?.ready ?? null;
      state.author = e?.authors?.[0]?.name?.split(" ")[0] ?? null;
      state.title = e?.title ?? "";
    } catch {
      /* read-only page (e.g. a category listing) */
    }
  }

  async function refreshToday() {
    try {
      const t = result(await act("today.get", {}));
      state.waiting = t.pending?.length ?? 0;
      waiting.hidden = !state.waiting;
      waiting.textContent = `${state.waiting} waiting`;
      setAmf(!!t.askMeFirst);
      renderTrust(t.trust ?? []);
      renderFixed(t.doneOnItsOwn ?? []);
    } catch {
      /* not allowed or offline: keep the toolbar minimal */
    }
  }

  function renderFixed(done: any[]) {
    const latest = done.find((d) => d.auto && d.status === "applied" && Date.now() - Date.parse(d.createdAt) < 3 * 86_400_000);
    if (!latest || LS.get("tq.live.fixed") === latest.id) {
      fixed.hidden = true;
      return;
    }
    fixed.replaceChildren(
      h("span", { class: "gold" }, h("span", { class: "dot" }), "Fixed on its own"),
      h("span", {}, latest.summary),
      h(
        "div",
        { class: "row" },
        latest.undoable ? h("button", { type: "button", class: "link", onclick: undoAndReload(latest.id) }, "Undo") : null,
        h("button", { type: "button", class: "link muted", onclick: () => ((fixed.hidden = true), LS.set("tq.live.fixed", latest.id)) }, "Dismiss"),
      ),
    );
    fixed.hidden = false;
  }

  function renderTrust(items: any[]) {
    if (!items.length || LS.get("tq.live.trust") === "hidden") {
      trust.hidden = true;
      return;
    }
    const rows = items.slice(0, 5).map((t) => {
      const line = t.earned ? "Handles on its own" : t.threshold ? `Asks first, ${Math.min(t.clean, t.threshold)} of ${t.threshold}` : "Always asks";
      const row = h("div", { class: "trow" }, h("span", {}, t.label), h("span", { class: t.earned ? "earned" : "muted" }, line));
      if (!t.earned && t.threshold && t.clean > 0) {
        const bar = h("div", { class: "bar", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": String(t.threshold), "aria-valuenow": String(t.clean), "aria-label": t.label }, h("span"));
        (bar.firstChild as HTMLElement).style.width = `${Math.min(100, (t.clean / t.threshold) * 100)}%`;
        return h("div", {}, row, bar);
      }
      return row;
    });
    trust.replaceChildren(h("div", { class: "ph" }, h("strong", {}, "Trust earned so far"), closeBtn(() => ((trust.hidden = true), LS.set("tq.live.trust", "hidden")))), ...rows);
    trust.hidden = false;
  }

  loadEntry();
  refreshToday();
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
else mount();
