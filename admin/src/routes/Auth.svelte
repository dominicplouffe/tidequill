<script lang="ts">
  import Logo from "../components/Logo.svelte";
  import { auth, errorMessage } from "../lib/api.ts";
  import { navigate } from "../lib/router.svelte.ts";
  import { boot, session } from "../lib/session.svelte.ts";

  let { mode, token }: { mode: "setup" | "signin" | "invite"; token?: string } = $props();

  let email = $state("");
  let name = $state("");
  let password = $state("");
  let error = $state("");
  let busy = $state(false);

  const title = $derived(mode === "setup" ? "Create your account" : mode === "invite" ? "Join your team" : "Sign in");
  const lead = $derived(
    mode === "setup" ? "You're the first person here, so you'll be the owner. It takes a few seconds." : mode === "invite" ? "Pick a password and you're in." : "Welcome back.",
  );

  async function submit(e: Event) {
    e.preventDefault();
    error = "";
    busy = true;
    try {
      if (mode === "setup") await auth.setup(email.trim(), name.trim(), password);
      else if (mode === "invite") await auth.acceptInvite(token ?? "", password, name.trim() || undefined);
      else await auth.login(email.trim(), password);
      session.ready = false;
      await boot();
      navigate(session.sites.length ? "/today" : "/onboarding", { replace: true });
    } catch (err) {
      error = errorMessage(err);
    } finally {
      busy = false;
    }
  }
</script>

<div class="wrap">
  <div class="brand"><Logo label /></div>
  <form class="panel fade-in" onsubmit={submit} aria-labelledby="auth-title">
    <div class="stack" style="gap: 8px">
      <h1 id="auth-title" class="serif">{title}</h1>
      <p class="muted">{lead}</p>
    </div>
    {#if mode !== "signin"}
      <label class="field"><span>Your name</span><input class="input" bind:value={name} autocomplete="name" required={mode === "setup"} /></label>
    {/if}
    {#if mode !== "invite"}
      <label class="field"><span>Email</span><input class="input" type="email" bind:value={email} autocomplete="email" required /></label>
    {/if}
    <label class="field">
      <span>Password</span>
      <input class="input" type="password" bind:value={password} autocomplete={mode === "signin" ? "current-password" : "new-password"} required minlength={mode === "signin" ? undefined : 8} />
      {#if mode !== "signin"}<span class="hint">At least 8 characters.</span>{/if}
    </label>
    {#if error}<p class="error-box" role="alert">{error}</p>{/if}
    <button class="btn btn-primary btn-lg" type="submit" disabled={busy}>{busy ? "One moment…" : mode === "setup" ? "Create account" : mode === "invite" ? "Join" : "Sign in"}</button>
  </form>
</div>

<style>
  .wrap { min-height: 100vh; min-height: 100dvh; background: var(--tide); display: flex; flex-direction: column; align-items: center; gap: 32px; padding: 48px 16px; }
  .brand { width: 100%; max-width: 440px; }
  .panel { width: 100%; max-width: 440px; background: var(--surface); border-radius: 24px; padding: 40px; display: flex; flex-direction: column; gap: 20px; }
  h1 { font-size: 40px; font-weight: 500; letter-spacing: -0.015em; }
  @media (max-width: 480px) { .panel { padding: 28px 20px; } h1 { font-size: 32px; } }
</style>
