<script lang="ts">
  /** An accessible switch (button role="switch"). */
  let {
    checked = false,
    label,
    hideLabel = false,
    disabled = false,
    dark = false,
    onchange,
  }: { checked?: boolean; label: string; hideLabel?: boolean; disabled?: boolean; dark?: boolean; onchange?: (v: boolean) => void } = $props();
</script>

<button type="button" role="switch" aria-checked={checked} class="switch" class:dark {disabled} onclick={() => onchange?.(!checked)}>
  <span class:sr-only={hideLabel} class="label">{label}</span>
  <span class="track" aria-hidden="true"><span class="thumb"></span></span>
</button>

<style>
  .switch { display: inline-flex; align-items: center; gap: 10px; min-height: 44px; padding: 0 4px; background: none; border: 0; cursor: pointer; color: inherit; font-size: 14px; font-weight: 600; }
  .switch:disabled { opacity: 0.5; cursor: not-allowed; }
  .dark { color: #c4dde9; }
  .track { position: relative; width: 40px; height: 24px; border-radius: 12px; background: var(--border); transition: background var(--t) var(--ease); flex: none; }
  .dark .track { background: #2c6e8f; }
  .thumb { position: absolute; left: 3px; top: 3px; width: 18px; height: 18px; border-radius: 50%; background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,.2); transition: transform var(--t) var(--ease); }
  [aria-checked="true"] .track { background: var(--gold); }
  [aria-checked="true"] .thumb { transform: translateX(16px); background: var(--on-gold); }
</style>
