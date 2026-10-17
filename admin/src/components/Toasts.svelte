<script lang="ts">
  import { dismiss, pauseToast, runUndo, toasts } from "../lib/toast.svelte.ts";
</script>

<div class="toasts" role="region" aria-label="Notifications">
  <div aria-live="polite" aria-atomic="false" class="list">
    {#each toasts as t (t.id)}
      <div
        class="toast fade-in {t.tone}"
        role={t.tone === "error" ? "alert" : "status"}
        onmouseenter={() => pauseToast(t.id, true)}
        onmouseleave={() => pauseToast(t.id, false)}
        onfocusin={() => pauseToast(t.id, true)}
        onfocusout={() => pauseToast(t.id, false)}
      >
        {#if t.tone === "agent"}<span class="dot" aria-hidden="true"></span>{/if}
        <span class="msg">{t.message}</span>
        {#if t.undo}
          <button type="button" class="undo" onclick={() => runUndo(t.id)}>{t.undoLabel ?? "Undo"}</button>
        {/if}
        <button type="button" class="close" aria-label="Dismiss" onclick={() => dismiss(t.id)}>×</button>
        {#if t.undo}<span class="timer" style:animation-duration="{t.timeout}ms" class:paused={t.paused} aria-hidden="true"></span>{/if}
      </div>
    {/each}
  </div>
</div>

<style>
  .toasts { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); z-index: 100; width: min(520px, calc(100vw - 32px)); pointer-events: none; }
  .list { display: flex; flex-direction: column; gap: 8px; }
  .toast { pointer-events: auto; position: relative; overflow: hidden; display: flex; align-items: center; gap: 12px; padding: 12px 8px 12px 18px; background: var(--tide); color: #e3eff5; border-radius: 14px; box-shadow: 0 12px 32px rgba(12, 58, 85, 0.28); font-size: 15px; line-height: 1.4; }
  .toast.error { background: #5b1a12; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--gold); flex: none; }
  .msg { flex: 1; min-width: 0; }
  .undo { background: none; border: 0; color: var(--gold); font-weight: 700; min-height: 40px; padding: 0 10px; cursor: pointer; border-radius: 8px; }
  .undo:hover { background: rgba(255, 255, 255, 0.08); }
  .close { background: none; border: 0; color: #a6c7d8; width: 36px; height: 36px; font-size: 20px; cursor: pointer; border-radius: 8px; }
  .timer { position: absolute; left: 0; bottom: 0; height: 3px; width: 100%; background: var(--gold); transform-origin: left; animation: shrink linear forwards; opacity: 0.7; }
  .timer.paused { animation-play-state: paused; }
  @keyframes shrink { from { transform: scaleX(1); } to { transform: scaleX(0); } }
  @media (max-width: 719px) { .toasts { bottom: 96px; } }
</style>
