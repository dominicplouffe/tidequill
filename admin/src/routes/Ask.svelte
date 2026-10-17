<script lang="ts">
  import { onDestroy, onMount, tick, untrack } from "svelte";
  import AskCard from "../components/AskCard.svelte";
  import type { ProposalLike } from "../components/ProposalCard.svelte";
  import { action, ask, conversation, errorMessage, pollRun, read } from "../lib/api.ts";
  import { money } from "../lib/format.ts";
  import { onNavigate, setQuery } from "../lib/router.svelte.ts";
  import { refreshSites, session } from "../lib/session.svelte.ts";
  import { listen, speechSupported, type Listener } from "../lib/speech.ts";
  import { deferred, toast, toastError, undoAction } from "../lib/toast.svelte.ts";
  import type { AskContext, AskMessage, Card, Proposal, RunStatus } from "../lib/types.ts";

  let { query }: { params?: Record<string, string>; query: URLSearchParams } = $props();
  // The query is read once on arrival; later asks come through onNavigate.
  const q0 = untrack(() => query);

  let conversationId = $state<string | null>(q0.get("c"));
  let messages = $state<AskMessage[]>([]);
  let text = $state(q0.get("send") ? "" : q0.get("q") ?? "");
  let sending = $state(false);
  let loading = $state(false);
  let decided = $state<Record<string, string>>({});
  let runs = $state<Record<string, RunStatus>>({});
  let listening = $state(false);
  let previewNonce = $state(0);
  let input: HTMLTextAreaElement | undefined = $state();
  let thread: HTMLElement | undefined = $state();
  let rec: Listener | null = null;
  const voiceMode = q0.get("voice") === "1";
  const canSpeak = speechSupported();
  const aborts = new Set<AbortController>();

  let context = $state<AskContext | null>(
    q0.get("entryId") || q0.get("path") || q0.get("blockId")
      ? { entryId: q0.get("entryId") ?? undefined, blockId: q0.get("blockId") ?? undefined, path: q0.get("path") ?? undefined, screen: q0.get("from") ?? undefined }
      : null,
  );
  let contextTitle = $state("");

  $effect(() => {
    const id = context?.entryId;
    if (!id) return;
    read<any>("posts.get", { id })
      .then((e) => (contextTitle = e?.title ?? ""))
      .catch(() => (contextTitle = ""));
  });

  // Start: load the conversation, then send the prefilled question if asked to.
  onMount(() => {
    (async () => {
      if (conversationId) {
        loading = true;
        try {
          const c = await conversation(conversationId);
          messages = c.messages;
          for (const m of messages) watchCards(m);
        } catch (err) {
          toastError(err);
          conversationId = null;
        } finally {
          loading = false;
        }
      }
      const q = q0.get("q");
      if (q && q0.get("send")) {
        setQuery({ q: null, send: null, voice: null });
        await send(q);
      } else {
        await tick();
        input?.focus();
      }
      scrollDown();
    })();
    // Asked again from the command bar or hold-to-ask while already here.
    return onNavigate((r) => {
      const q = r.query.get("q");
      if (r.name === "ask" && q && r.query.get("send")) {
        setQuery({ q: null, send: null, voice: null });
        send(q);
      }
    });
  });

  onDestroy(() => {
    for (const a of aborts) a.abort();
    rec?.abort();
  });

  async function scrollDown() {
    await tick();
    thread?.scrollTo({ top: thread.scrollHeight, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    if (!thread || thread.scrollHeight <= thread.clientHeight) window.scrollTo({ top: document.body.scrollHeight });
  }

  async function send(raw?: string) {
    const message = (raw ?? text).trim();
    if (!message || sending) return;
    text = "";
    sending = true;
    const temp: AskMessage = { id: `tmp-${Date.now()}`, role: "user", text: message, cards: [], createdAt: new Date().toISOString(), pending: true };
    messages.push(temp);
    scrollDown();
    try {
      const res = await ask(message, { conversationId: conversationId ?? undefined, context: context ?? undefined });
      const i = messages.findIndex((m) => m.id === temp.id);
      const fresh = res.messages ?? [];
      const hasEcho = fresh[0]?.role === "user";
      messages.splice(i, 1, ...(hasEcho ? fresh : [{ ...temp, pending: false }, ...fresh]));
      if (res.conversationId && res.conversationId !== conversationId) {
        conversationId = res.conversationId;
        setQuery({ c: res.conversationId });
      }
      for (const m of fresh) if (m.role === "assistant") watchCards(m);
      if (voiceMode && "speechSynthesis" in window) {
        const reply = fresh.filter((m) => m.role === "assistant").map((m) => m.text).join(" ");
        if (reply) speechSynthesis.speak(new SpeechSynthesisUtterance(reply));
      }
    } catch (err) {
      const i = messages.findIndex((m) => m.id === temp.id);
      if (i >= 0) messages[i] = { ...temp, pending: false };
      messages.push({ id: `err-${Date.now()}`, role: "assistant", text: "", cards: [{ type: "error", message: errorMessage(err) }], createdAt: new Date().toISOString() });
      text = message;
    } finally {
      sending = false;
      scrollDown();
      refreshSites();
    }
  }

  /** Polls every running job in a message; when one finishes, adds its proposals to the message. */
  function watchCards(m: AskMessage) {
    const runIds = new Set<string>();
    for (const c of m.cards) {
      if (c.type === "progress" && !["done", "failed"].includes(c.status)) runIds.add(c.runId);
      if (c.type === "plan" && c.runId && c.steps.some((s) => s.status === "pending" || s.status === "running")) runIds.add(c.runId);
    }
    for (const runId of runIds) {
      const ctrl = new AbortController();
      aborts.add(ctrl);
      pollRun(runId, (r) => (runs[runId] = r), ctrl.signal)
        .then(async (r) => {
          if (r.proposalIds?.length) await addProposals(m.id, r.proposalIds);
          previewNonce++;
        })
        .catch((err) => {
          if ((err as Error).name !== "AbortError") runs[runId] = { ...(runs[runId] ?? { id: runId, label: "", steps: [], costUsd: 0, proposalIds: [] }), status: "failed", error: errorMessage(err) } as RunStatus;
        })
        .finally(() => aborts.delete(ctrl));
    }
  }

  async function addProposals(messageId: string, ids: string[]) {
    const msg = messages.find((x) => x.id === messageId);
    if (!msg) return;
    const known = new Set(messages.flatMap((x) => x.cards).filter((c) => c.type === "proposal").map((c) => (c as any).proposalId));
    const results = await Promise.allSettled(ids.filter((id) => !known.has(id)).map((id) => read<Proposal>("proposals.get", { id })));
    for (const r of results) {
      if (r.status !== "fulfilled" || !r.value) continue;
      const p = r.value;
      msg.cards.push({ type: "proposal", proposalId: p.id, summary: p.summary, diff: p.diff, trustKind: p.trustKind, status: p.status, entry: p.entry ? { id: p.entry.id, title: p.entry.title, ready: p.entry.ready } : undefined });
    }
    scrollDown();
  }

  function ondecide(id: string, status: "approved" | "discarded") {
    decided[id] = status;
    if (status === "approved") previewNonce++;
  }
  function onrestore(id: string) {
    delete decided[id];
  }
  function onedit(p: ProposalLike) {
    text = `About “${p.summary}”: `;
    input?.focus();
  }

  function groupPending(groupId: string) {
    return messages
      .filter((m) => m.cards.some((c) => c.type === "plan" && c.groupId === groupId))
      .flatMap((m) => m.cards)
      .filter((c): c is Extract<Card, { type: "proposal" }> => c.type === "proposal" && (decided[c.proposalId] ?? c.status) === "pending");
  }

  async function approveAll(groupId: string) {
    const pendingIds = groupPending(groupId).map((c) => c.proposalId);
    for (const id of pendingIds) decided[id] = "approved";
    try {
      const r = await read<{ approved: number; results: any[] }>("proposals.approve_group", { groupId });
      const actionIds = (r.results ?? []).filter((x: any) => x?.status === "applied" && x.undoable).map((x: any) => x.actionId as string);
      const failed = (r.results ?? []).find((x: any) => x?.status === "failed");
      if (failed) {
        decided[failed.proposalId] = "pending";
        toast(failed.error ?? "One change couldn't be applied.", { tone: "error" });
      }
      // Sync with the server's view of the group.
      try {
        const list = await read<Proposal[]>("proposals.list", { groupId });
        for (const p of list) decided[p.id] = p.status;
      } catch {
        /* keep optimistic state */
      }
      toast(`Approved ${r.approved === 1 ? "1 change" : `${r.approved} changes`}.`, {
        undo: actionIds.length
          ? async () => {
              for (const id of [...actionIds].reverse()) await undoAction(id);
            }
          : undefined,
      });
      previewNonce++;
    } catch (err) {
      for (const id of pendingIds) delete decided[id];
      toastError(err);
    }
  }

  async function reviewOneByOne() {
    await tick();
    const first = thread?.querySelector<HTMLElement>("[data-proposal] button");
    first?.scrollIntoView({ block: "center", behavior: "smooth" });
    first?.focus({ preventScroll: true });
  }

  function discardAll(groupId: string) {
    const ids = groupPending(groupId).map((c) => c.proposalId);
    if (!ids.length) return;
    for (const id of ids) decided[id] = "discarded";
    deferred(
      `Discarded ${ids.length === 1 ? "the change" : `all ${ids.length} changes`} in this plan.`,
      async () => {
        for (const id of ids) await action("proposals.discard", { id }, { keepalive: true });
      },
      () => {
        for (const id of ids) delete decided[id];
      },
    );
  }

  function mic() {
    if (listening) {
      rec?.stop();
      return;
    }
    const before = text ? `${text.trim()} ` : "";
    rec = listen({
      onText: (t) => (text = before + t),
      onError: (msg) => toast(msg, { tone: "error" }),
      onEnd: () => {
        listening = false;
        input?.focus();
      },
    });
    listening = !!rec;
    if (!rec) toast("Voice input isn't available in this browser. Type instead.");
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  }

  function autosize() {
    if (!input) return;
    input.style.height = "auto";
    input.style.height = `${Math.min(200, input.scrollHeight)}px`;
  }

  const previewEntry = $derived.by(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      for (const c of [...messages[i]!.cards].reverse()) if (c.type === "proposal" && c.entry?.id) return c.entry.id;
    }
    return context?.entryId ?? null;
  });
  const previewSrc = $derived(previewEntry ? `/api/preview?entryId=${encodeURIComponent(previewEntry)}` : session.siteId ? `/live/${session.siteId}${context?.path ?? "/"}` : null);
  const planGroups = $derived(new Set(messages.flatMap((m) => m.cards).filter((c) => c.type === "plan" && c.groupId).map((c) => (c as any).groupId as string)));
</script>

<div class="ask">
  <section class="conversation" aria-label="Conversation">
    <div class="thread" bind:this={thread} aria-live="polite" aria-busy={sending}>
      {#if loading}
        <div class="skeleton" style="height: 120px"></div>
      {:else if !messages.length}
        <div class="intro">
          <h1 class="page-title">Ask Tidequill</h1>
          <p class="muted">Say what you want done. You'll see a plan and every change before anything goes live.</p>
          <div class="row">
            {#each ["Write a post about…", "Make the site feel warmer", "What needs fixing on my site?", "Show me my settings"] as ex (ex)}
              <button type="button" class="btn btn-sm" onclick={() => (ex.endsWith("…") ? ((text = ex.replace("…", " ")), input?.focus()) : send(ex))}>{ex}</button>
            {/each}
          </div>
        </div>
      {/if}

      {#each messages as m (m.id)}
        {#if m.role === "user"}
          <div class="bubble fade-in" class:pending={m.pending}>{m.text}</div>
        {:else}
          <div class="assistant fade-in">
            {#if m.text}<p class="say">{m.text}</p>{/if}
            {#each m.cards as c, i (i)}
              <AskCard card={c} {decided} {runs} {ondecide} {onrestore} {onedit} />
            {/each}
            {#each m.cards.filter((c) => c.type === "plan" && c.groupId) as plan (plan)}
              {@const gid = (plan as any).groupId as string}
              {#if planGroups.has(gid) && groupPending(gid).length > 0}
                <div class="row plan-actions">
                  <button type="button" class="btn btn-primary btn-lg" onclick={() => approveAll(gid)}>Approve all</button>
                  {#if groupPending(gid).length > 1}<button type="button" class="btn btn-lg" onclick={reviewOneByOne}>Review one by one</button>{/if}
                  <button type="button" class="btn btn-quiet btn-lg" onclick={() => discardAll(gid)}>Discard</button>
                </div>
              {/if}
            {/each}
          </div>
        {/if}
      {/each}
      {#if sending}
        <div class="thinking" role="status"><span class="dot"></span><span class="dot"></span><span class="dot"></span><span class="sr-only">Tidequill is working on it</span></div>
      {/if}
    </div>

    <form class="composer" onsubmit={(e) => { e.preventDefault(); send(); }}>
      {#if context}
        <div class="context">
          <span class="chip">About: {contextTitle || context.path || "this page"}{context.blockId ? ", this section" : ""}</span>
          <button type="button" class="linkish small" onclick={() => (context = null)}>Clear</button>
        </div>
      {/if}
      <div class="box">
        <label class="sr-only" for="ask-input">Message</label>
        <textarea id="ask-input" rows="1" bind:this={input} bind:value={text} oninput={autosize} onkeydown={onKey} placeholder={messages.length ? "Reply, or ask for something else" : "Ask anything"}></textarea>
        {#if canSpeak}
          <button type="button" class="icon" class:on={listening} aria-pressed={listening} aria-label={listening ? "Stop listening" : "Speak instead"} onclick={mic}>
            <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><rect x="6" y="2" width="6" height="10" rx="3" stroke="currentColor" stroke-width="1.6" fill="none" /><path d="M3.5 9a5.5 5.5 0 0011 0M9 14.5V17" stroke="currentColor" stroke-width="1.6" fill="none" /></svg>
          </button>
        {/if}
        <button type="submit" class="icon send" aria-label="Send" disabled={sending || !text.trim()}>
          <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><path d="M9 15V3M4 8l5-5 5 5" stroke="currentColor" stroke-width="1.8" fill="none" /></svg>
        </button>
      </div>
    </form>
  </section>

  <aside class="preview" aria-label="Preview">
    <div class="ph"><h2>Preview with changes</h2><span class="small muted">Not live</span></div>
    {#if previewSrc}
      {#key `${previewSrc}#${previewNonce}`}
        <iframe title="Preview of your site" src={previewSrc} loading="lazy"></iframe>
      {/key}
    {/if}
    {#if Object.values(runs).some((r) => r.costUsd)}
      <p class="small muted">Spent on this so far: {money(Object.values(runs).reduce((n, r) => n + (r.costUsd || 0), 0))}</p>
    {/if}
  </aside>
</div>

<style>
  .ask { display: grid; grid-template-columns: minmax(0, 3fr) minmax(0, 2fr); min-height: 100vh; min-height: 100dvh; }
  .conversation { display: flex; flex-direction: column; min-width: 0; height: 100vh; height: 100dvh; position: sticky; top: 0; }
  .thread { flex: 1; overflow-y: auto; padding: 36px 40px 16px; display: flex; flex-direction: column; gap: 22px; }
  .intro { display: flex; flex-direction: column; gap: 12px; max-width: 640px; }
  .bubble { align-self: flex-end; max-width: min(620px, 90%); background: var(--tide); color: #fff; border-radius: 18px 18px 4px 18px; padding: 14px 18px; font-size: 16px; line-height: 1.5; white-space: pre-wrap; }
  .bubble.pending { opacity: 0.7; }
  .assistant { display: flex; flex-direction: column; gap: 16px; max-width: 760px; }
  .say { font-size: 16px; line-height: 1.55; white-space: pre-wrap; }
  .plan-actions { gap: 10px; }
  .thinking { display: flex; gap: 6px; padding: 8px 0; }
  .thinking .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--gold); animation: blink 1.2s infinite ease-in-out; }
  .thinking .dot:nth-child(2) { animation-delay: 0.15s; }
  .thinking .dot:nth-child(3) { animation-delay: 0.3s; }
  @keyframes blink { 50% { opacity: 0.25; } }
  .composer { padding: 12px 40px 28px; display: flex; flex-direction: column; gap: 8px; }
  .context { display: flex; align-items: center; gap: 8px; }
  .box { display: flex; align-items: flex-end; gap: 8px; min-height: 58px; padding: 7px 8px 7px 20px; border-radius: 16px; background: var(--surface); border: 1px solid var(--border); }
  .box:focus-within { outline: 3px solid var(--focus); outline-offset: 0; border-color: transparent; }
  textarea { flex: 1; min-width: 0; border: 0; outline: none; resize: none; font-size: 16px; line-height: 1.5; padding: 9px 0; background: transparent; color: var(--text); max-height: 200px; }
  .icon { width: 44px; height: 44px; border-radius: 12px; border: 0; background: var(--sunken); color: var(--text); display: flex; align-items: center; justify-content: center; cursor: pointer; flex: none; }
  .icon.on { background: var(--gold); color: var(--on-gold); }
  .send { background: var(--tide); color: #fff; }
  .send:disabled { opacity: 0.5; cursor: default; }
  .preview { background: var(--sunken); padding: 36px 32px; display: flex; flex-direction: column; gap: 14px; height: 100vh; height: 100dvh; position: sticky; top: 0; }
  .ph { display: flex; justify-content: space-between; align-items: center; }
  .ph h2 { font-size: 15px; font-weight: 700; }
  iframe { flex: 1; width: 100%; border: 1px solid var(--border); border-radius: 14px; background: #fff; }
  @media (max-width: 1099px) {
    .ask { grid-template-columns: minmax(0, 1fr); }
    .preview { display: none; }
  }
  @media (max-width: 719px) {
    .conversation { height: calc(100dvh - 60px - 70px); position: static; }
    .thread { padding: 20px 16px 12px; }
    .composer { padding: 8px 12px 12px; }
  }
</style>
