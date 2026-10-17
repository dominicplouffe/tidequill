<script lang="ts">
  let { size = 30, label = false }: { size?: number; label?: boolean } = $props();
</script>

<span class="logo">
  <svg width={size} height={size} viewBox="0 0 30 30" aria-hidden="true">
    <rect width="30" height="30" rx="8" fill="#0E6E9E" />
    <path d="M21.5 5.5c-5.5 1.5-9 6.5-10.5 13.5l2.2.8c1.6-5.4 4.4-10.2 8.3-14.3z" fill="#F4D35E" />
    <path d="M5 23c2.5-1.8 4.5-1.8 7 0s4.5 1.8 7 0 4.5-1.8 6 0" stroke="#7DD3FC" stroke-width="1.8" fill="none" stroke-linecap="round" />
  </svg>
  {#if label}<span class="word">Tidequill</span>{/if}
</span>

<style>
  .logo { display: inline-flex; align-items: center; gap: 10px; }
  .word { font-size: 19px; font-weight: 700; letter-spacing: -0.01em; color: #fff; }
</style>
