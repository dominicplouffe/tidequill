<script lang="ts">
  import { onDestroy, untrack } from "svelte";
  import { ApiError, errorMessage, read, uploadEvidence, type EvidenceInput } from "../lib/api.ts";
  import { enqueue, flush, onQueueChange } from "../lib/offline.ts";
  import { session } from "../lib/session.svelte.ts";
  import { listen, speechSupported, type Listener } from "../lib/speech.ts";
  import { toast, toastError } from "../lib/toast.svelte.ts";
  import type { Author } from "../lib/types.ts";

  /**
   * Experience capture, phone first: snap, speak, done. Captures are stored as
   * evidence linked to an author and topic. Offline captures queue and retry.
   */
  let { query }: { params?: any; query: URLSearchParams } = $props();

  let authors = $state<Author[]>([]);
  let authorId = $state(untrack(() => query.get("author")) ?? "");
  let topic = $state(untrack(() => query.get("topic")) ?? "");
  let nudge = $state<{ text: string; topic?: string; authorId?: string } | null>(null);
  let mode = $state<"none" | "photo" | "voice" | "note">("none");
  let text = $state("");
  let photo = $state<File | null>(null);
  let photoUrl = $state<string | null>(null);
  let queuedCount = $state(0);
  let sending = $state(false);
  let photoInput: HTMLInputElement | undefined = $state();

  // Voice note
  let recording = $state(false);
  let seconds = $state(0);
  let audio = $state<Blob | null>(null);
  let audioUrl = $state<string | null>(null);
  let recorder: MediaRecorder | null = null;
  let stream: MediaStream | null = null;
  let chunks: BlobPart[] = [];
  let transcriber: Listener | null = null;
  let tickTimer: ReturnType<typeof setInterval> | undefined;
  const canRecord = typeof MediaRecorder !== "undefined" && !!navigator.mediaDevices?.getUserMedia;
  const canTranscribe = speechSupported();

  const off = onQueueChange((n) => (queuedCount = n));
  onDestroy(() => {
    off();
    stopRecording();
    if (photoUrl) URL.revokeObjectURL(photoUrl);
    if (audioUrl) URL.revokeObjectURL(audioUrl);
  });

  (async () => {
    try {
      authors = (await read<Author[]>("authors.list", {})).filter((a) => !a.isPersona);
      const mine = authors.find((a) => a.userId === session.user?.id);
      if (!authorId) authorId = mine?.id ?? authors[0]?.id ?? "";
    } catch {
      authors = [];
    }
    try {
      // evidence.nudge → [{ authorId, authorName, entryId, title, kind, ask }]
      const list = await read<any>("evidence.nudge", {});
      const items: any[] = Array.isArray(list) ? list : list ? [list] : [];
      const n = items.find((x) => x.authorId === authorId) ?? items[0];
      const t = n?.ask ?? n?.text ?? n?.message;
      if (t) nudge = { text: t, topic: n.title ?? n.topic ?? undefined, authorId: n.authorId };
    } catch {
      nudge = null;
    }
  })();

  function choosePhoto() {
    mode = "photo";
    photoInput?.click();
  }

  function onPhoto(e: Event) {
    const f = (e.currentTarget as HTMLInputElement).files?.[0] ?? null;
    if (!f) return;
    if (photoUrl) URL.revokeObjectURL(photoUrl);
    photo = f;
    photoUrl = URL.createObjectURL(f);
    mode = "photo";
  }

  async function startRecording() {
    mode = "voice";
    audio = null;
    text = "";
    if (!canRecord) {
      if (canTranscribe) startTranscript();
      else toast("This browser can't record audio. Type a quick note instead.", { tone: "error" });
      return;
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      toast("Microphone access is blocked. Allow it in your browser settings, or type a note.", { tone: "error" });
      return;
    }
    chunks = [];
    recorder = new MediaRecorder(stream);
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    recorder.onstop = () => {
      audio = new Blob(chunks, { type: recorder?.mimeType || "audio/webm" });
      if (audioUrl) URL.revokeObjectURL(audioUrl);
      audioUrl = URL.createObjectURL(audio);
      stream?.getTracks().forEach((t) => t.stop());
      stream = null;
    };
    recorder.start();
    recording = true;
    seconds = 0;
    tickTimer = setInterval(() => seconds++, 1000);
    if (canTranscribe) startTranscript();
  }

  function startTranscript() {
    const before = text ? `${text} ` : "";
    transcriber = listen({ onText: (t) => (text = before + t), onError: () => {} });
    if (!canRecord) recording = !!transcriber;
  }

  function stopRecording() {
    clearInterval(tickTimer);
    transcriber?.stop();
    transcriber = null;
    if (recorder && recorder.state !== "inactive") recorder.stop();
    recorder = null;
    recording = false;
  }

  function reset() {
    mode = "none";
    text = "";
    photo = null;
    audio = null;
    if (photoUrl) URL.revokeObjectURL(photoUrl);
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    photoUrl = null;
    audioUrl = null;
  }

  async function send() {
    const ev: EvidenceInput = {
      kind: mode === "photo" ? "photo" : mode === "voice" ? "voice" : "note",
      text: text.trim() || undefined,
      authorId: authorId || undefined,
      topic: topic.trim() || undefined,
      file: mode === "photo" ? photo : mode === "voice" ? audio : null,
      filename: mode === "photo" ? photo?.name : mode === "voice" ? `voice-note.${audio?.type.includes("mp4") ? "m4a" : "webm"}` : undefined,
    };
    if (!ev.file && !ev.text) return toastError(new Error("Add a photo, a voice note or a few words first."));
    sending = true;
    const site = session.siteId;
    try {
      if (!navigator.onLine) throw new ApiError("offline", "offline");
      await uploadEvidence(ev, site);
      toast(ev.kind === "photo" ? "Photo saved. The team can use it in drafts." : ev.kind === "voice" ? "Voice note saved, in your own words." : "Note saved.", { tone: "agent" });
      reset();
    } catch (err) {
      if (err instanceof ApiError && err.offline) {
        await enqueue({ ...ev, siteId: site });
        toast("You're offline. Saved on this phone; it uploads when you're back online.");
        reset();
      } else toast(errorMessage(err), { tone: "error" });
    } finally {
      sending = false;
    }
  }

  function useNudge() {
    if (!nudge) return;
    if (nudge.topic) topic = nudge.topic;
    if (nudge.authorId) authorId = nudge.authorId;
    choosePhoto();
  }

  const mm = $derived(`${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`);
</script>

<div class="page capture">
  <h1 class="page-title">Capture</h1>
  <p class="muted">What you saw, measured or did. Snap it, say it, done. The team writes around it, in your words.</p>

  {#if nudge}
    <div class="card nudge" role="note">
      <span class="dot" aria-hidden="true"></span>
      <p>{nudge.text}</p>
      <button type="button" class="btn btn-sm" onclick={useNudge}>Snap it</button>
    </div>
  {/if}

  {#if queuedCount}
    <p class="queue small" role="status">{queuedCount === 1 ? "1 capture" : `${queuedCount} captures`} waiting to upload. <button class="linkish" onclick={() => flush()}>Try now</button></p>
  {/if}

  <input type="file" accept="image/*" capture="environment" class="sr-only" tabindex="-1" aria-hidden="true" bind:this={photoInput} onchange={onPhoto} />

  {#if mode === "none"}
    <div class="big">
      <button type="button" class="tile" onclick={choosePhoto}>
        <svg width="36" height="36" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h3l2-2h6l2 2h3v12H4z" stroke="currentColor" stroke-width="1.7" fill="none" stroke-linejoin="round" /><circle cx="12" cy="13" r="3.5" stroke="currentColor" stroke-width="1.7" fill="none" /></svg>
        <span class="tl">Photo</span><span class="ts">Snap what you see</span>
      </button>
      <button type="button" class="tile" onclick={startRecording}>
        <svg width="36" height="36" viewBox="0 0 18 18" aria-hidden="true"><rect x="6" y="2" width="6" height="10" rx="3" stroke="currentColor" stroke-width="1.4" fill="none" /><path d="M3.5 9a5.5 5.5 0 0011 0M9 14.5V17" stroke="currentColor" stroke-width="1.4" fill="none" /></svg>
        <span class="tl">Voice note</span><span class="ts">Say it like you'd tell a friend</span>
      </button>
      <button type="button" class="tile" onclick={() => (mode = "note")}>
        <svg width="36" height="36" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4h14v16H5zM8 9h8M8 13h8M8 17h5" stroke="currentColor" stroke-width="1.7" fill="none" /></svg>
        <span class="tl">Quick note</span><span class="ts">“The drawer sticks in humid weather”</span>
      </button>
    </div>
  {:else}
    <form class="card compose fade-in" onsubmit={(e) => { e.preventDefault(); send(); }}>
      {#if mode === "photo"}
        {#if photoUrl}<img src={photoUrl} alt="What you just took" class="preview" />{:else}<button type="button" class="btn" onclick={() => photoInput?.click()}>Take or pick a photo</button>{/if}
        <label class="field"><span>What does it show? <span class="muted">(optional)</span></span><textarea class="textarea" rows="2" bind:value={text} placeholder="e.g. 72-inch walnut stand under a 77-inch TV, 3 inches spare each side"></textarea></label>
      {:else if mode === "voice"}
        <div class="rec">
          {#if recording}
            <span class="pulse" aria-hidden="true"></span><span class="time" role="timer" aria-label="Recording time">{mm}</span>
            <button type="button" class="btn btn-dark" onclick={stopRecording}>Stop</button>
          {:else if audioUrl}
            <audio controls src={audioUrl}></audio>
            <button type="button" class="btn btn-sm btn-quiet" onclick={startRecording}>Record again</button>
          {:else}
            <button type="button" class="btn btn-dark" onclick={startRecording}>Start recording</button>
          {/if}
        </div>
        <label class="field"><span>Transcript {canTranscribe ? "" : "(type what you said, if you like)"}</span><textarea class="textarea serif" rows="4" bind:value={text} placeholder={canTranscribe ? "Your words appear here as you speak" : "Optional"}></textarea></label>
      {:else}
        <label class="field"><span>Quick note</span><textarea class="textarea serif" rows="4" bind:value={text} placeholder="What did you notice?"></textarea></label>
      {/if}

      <div class="meta">
        {#if authors.length}
          <label class="field"><span>Whose experience?</span>
            <select class="select" bind:value={authorId}>{#each authors as a (a.id)}<option value={a.id}>{a.name}</option>{/each}</select>
          </label>
        {/if}
        <label class="field"><span>Topic or product <span class="muted">(optional)</span></span><input class="input" bind:value={topic} placeholder="e.g. Oak & Co. stand" /></label>
      </div>

      <div class="row">
        <button type="submit" class="btn btn-primary btn-lg" disabled={sending || recording}>{sending ? "Saving…" : "Save"}</button>
        <button type="button" class="btn btn-quiet" onclick={() => { stopRecording(); reset(); }}>Cancel</button>
      </div>
    </form>
  {/if}
</div>

<style>
  .capture { max-width: 720px; }
  .nudge { flex-direction: row; align-items: center; gap: 12px; border-color: var(--gold); }
  .nudge p { flex: 1; }
  .dot { width: 10px; height: 10px; border-radius: 50%; background: var(--gold); flex: none; }
  .queue { background: var(--sunken); padding: 10px 14px; border-radius: 10px; }
  .big { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; }
  .tile { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; min-height: 150px; padding: 22px; border-radius: 18px; border: 1px solid var(--border); background: var(--surface); color: var(--text); cursor: pointer; text-align: left; transition: border-color var(--t) var(--ease), transform var(--t) var(--ease); }
  .tile:hover { border-color: var(--muted); }
  .tile:active { transform: scale(0.98); }
  .tile svg { color: var(--ocean); }
  .tl { font-size: 20px; font-weight: 700; }
  .ts { font-size: 14px; color: var(--muted); }
  .preview { width: 100%; max-height: 360px; object-fit: cover; border-radius: 12px; }
  .rec { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; min-height: 56px; }
  .pulse { width: 14px; height: 14px; border-radius: 50%; background: var(--light-red); animation: pulse 1.2s ease-in-out infinite; }
  @keyframes pulse { 50% { opacity: 0.3; } }
  .time { font-size: 22px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .meta { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; }
  @media (max-width: 719px) { .big { grid-template-columns: minmax(0, 1fr); } .tile { min-height: 96px; flex-direction: row; align-items: center; flex-wrap: wrap; } .ts { flex-basis: 100%; } }
</style>
