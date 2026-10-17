<script lang="ts">
  import { navigate } from "../lib/router.svelte.ts";
  import { listen, speechSupported, type Listener } from "../lib/speech.ts";
  import { toast } from "../lib/toast.svelte.ts";

  /** Phone: hold to speak to Tidequill; release to send. Tap opens Ask. */
  let listening = $state(false);
  let transcript = $state("");
  let rec: Listener | null = null;
  let pressedAt = 0;
  const supported = speechSupported();

  function start(e: Event) {
    e.preventDefault();
    if (!supported || listening) return;
    pressedAt = Date.now();
    transcript = "";
    rec = listen({
      onText: (t) => (transcript = t),
      onError: (m) => toast(m, { tone: "error" }),
      onEnd: (finalText) => {
        listening = false;
        const text = (finalText || transcript).trim();
        if (text) navigate(`/ask?q=${encodeURIComponent(text)}&send=1&voice=1`);
      },
    });
    listening = !!rec;
    navigator.vibrate?.(10);
  }

  function stop() {
    if (!listening) return;
    const held = Date.now() - pressedAt;
    rec?.stop();
    if (held < 350) {
      rec?.abort();
      listening = false;
      navigate("/ask");
    }
  }

  function click() {
    if (!supported) navigate("/ask");
  }

  function key(e: KeyboardEvent, down: boolean) {
    if (e.key !== " " && e.key !== "Enter") return;
    if (!supported) return;
    e.preventDefault();
    if (down && !e.repeat) start(e);
    if (!down) stop();
  }
</script>

{#if listening}
  <div class="bubble fade-in" role="status" aria-live="polite">{transcript || "Listening…"}</div>
{/if}
<button
  type="button"
  class="hold"
  class:listening
  aria-label={supported ? "Hold to ask Tidequill" : "Ask Tidequill"}
  onpointerdown={start}
  onpointerup={stop}
  onpointercancel={stop}
  onpointerleave={stop}
  oncontextmenu={(e) => e.preventDefault()}
  onclick={click}
  onkeydown={(e) => key(e, true)}
  onkeyup={(e) => key(e, false)}
>
  <svg width="22" height="22" viewBox="0 0 18 18" aria-hidden="true"><rect x="6" y="2" width="6" height="10" rx="3" stroke="currentColor" stroke-width="1.7" fill="none" /><path d="M3.5 9a5.5 5.5 0 0011 0M9 14.5V17" stroke="currentColor" stroke-width="1.7" fill="none" /></svg>
</button>

<style>
  .hold { position: fixed; right: 18px; bottom: calc(84px + env(safe-area-inset-bottom)); z-index: 50; width: 60px; height: 60px; border-radius: 50%; border: 0; background: var(--gold); color: var(--on-gold); box-shadow: 0 10px 24px rgba(12, 58, 85, 0.3); display: flex; align-items: center; justify-content: center; cursor: pointer; touch-action: none; user-select: none; -webkit-user-select: none; transition: transform var(--t) var(--ease); }
  .listening { transform: scale(1.15); box-shadow: 0 0 0 10px rgba(244, 211, 94, 0.35), 0 10px 24px rgba(12, 58, 85, 0.3); }
  .bubble { position: fixed; right: 16px; left: 16px; bottom: calc(160px + env(safe-area-inset-bottom)); z-index: 50; background: var(--tide); color: #fff; border-radius: 16px; padding: 14px 16px; font-size: 16px; box-shadow: var(--shadow-pop); }
</style>
