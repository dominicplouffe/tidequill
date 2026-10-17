<script lang="ts">
  import DiffView from "../components/DiffView.svelte";
  import SettingsList from "../components/SettingsList.svelte";
  import { action, errorMessage, read, tokens } from "../lib/api.ts";
  import { ago } from "../lib/format.ts";
  import { isOwner, refreshSites, session, signOut } from "../lib/session.svelte.ts";
  import { announce, toast, toastError } from "../lib/toast.svelte.ts";
  import type { DiffItem } from "../lib/types.ts";

  const owner = $derived(isOwner());
  const origin = location.origin;

  // ---------- About ----------
  let site = $state<any>(null);
  let siteName = $state("");
  let niche = $state("");
  async function loadSite() {
    try {
      site = await read("sites.get", {});
      siteName = site.name;
      niche = site.niche;
    } catch (err) {
      toastError(err);
    }
  }
  async function saveAbout(e: Event) {
    e.preventDefault();
    try {
      const res = await action("sites.update", { name: siteName.trim(), niche: niche.trim() });
      announce(res, { afterUndo: loadSite });
      await Promise.all([loadSite(), refreshSites()]);
    } catch (err) {
      toastError(err);
    }
  }

  // ---------- Members ----------
  let members = $state<any[]>([]);
  let inviteEmail = $state("");
  let inviteName = $state("");
  let inviteRole = $state<"owner" | "writer" | "reviewer">("writer");
  let inviteLink = $state<string | null>(null);
  let removing = $state<string | null>(null);
  async function loadMembers() {
    try {
      members = await read<any[]>("members.list", {});
    } catch (err) {
      toastError(err);
    }
  }
  async function invite(e: Event) {
    e.preventDefault();
    inviteLink = null;
    try {
      const r = await read<{ invitePath: string | null }>("members.invite", { email: inviteEmail.trim(), name: inviteName.trim() || undefined, role: inviteRole });
      inviteLink = r.invitePath ? `${origin}${r.invitePath}` : null;
      toast(r.invitePath ? "Invitation ready. Send them the link." : `${inviteEmail} already has an account and now has access.`);
      inviteEmail = "";
      inviteName = "";
      await loadMembers();
    } catch (err) {
      toastError(err);
    }
  }
  async function removeMember(userId: string) {
    try {
      await read("members.remove", { userId });
      removing = null;
      toast("Access removed.");
      await loadMembers();
    } catch (err) {
      toastError(err);
    }
  }

  // ---------- Domains ----------
  let domain = $state("");
  let confirmRemove = $state<{ hostname: string; summary: string; diff: DiffItem[]; token: string } | null>(null);
  async function addDomain(e: Event) {
    e.preventDefault();
    try {
      const res = await action("sites.add_domain", { hostname: domain.trim() });
      announce(res, { afterUndo: loadSite });
      domain = "";
      await Promise.all([loadSite(), refreshSites()]);
    } catch (err) {
      toastError(err);
    }
  }
  async function removeDomain(hostname: string, token?: string) {
    try {
      const res = await action("sites.remove_domain", { hostname }, token ? { confirm: token } : {});
      if (res.status === "needs_confirmation") {
        confirmRemove = { hostname, summary: res.summary, diff: res.diff, token: res.confirmToken };
        return;
      }
      confirmRemove = null;
      announce(res, { afterUndo: loadSite });
      await Promise.all([loadSite(), refreshSites()]);
    } catch (err) {
      toastError(err);
    }
  }

  // ---------- Tokens (MCP) ----------
  let tokenList = $state<any[]>([]);
  let tokenName = $state("Claude");
  let newToken = $state<string | null>(null);
  let tokenScope = $state<"site" | "all">("site");
  async function loadTokens() {
    try {
      tokenList = await tokens.list();
    } catch {
      tokenList = [];
    }
  }
  async function createToken(e: Event) {
    e.preventDefault();
    try {
      const r = await tokens.create(tokenName.trim() || "Token", tokenScope === "site" ? session.siteId : null, null);
      newToken = r.token;
      await loadTokens();
    } catch (err) {
      toastError(err);
    }
  }
  async function deleteToken(id: string) {
    try {
      await tokens.remove(id);
      toast("Token revoked. Anything using it stops working now.");
      await loadTokens();
    } catch (err) {
      toastError(err);
    }
  }
  const mcpSnippet = $derived(
    JSON.stringify({ mcpServers: { tidequill: { type: "http", url: `${origin}/mcp`, headers: { Authorization: `Bearer ${newToken ?? "<your token>"}` } } } }, null, 2),
  );

  async function copy(text: string, what = "Copied.") {
    try {
      await navigator.clipboard.writeText(text);
      toast(what);
    } catch {
      toast("Couldn't copy. Select the text and copy it yourself.", { tone: "error" });
    }
  }

  loadSite();
  loadMembers();
  loadTokens();
</script>

<div class="page settings">
  <div class="stack" style="gap: 6px">
    <h1 class="page-title">Settings</h1>
    <p class="muted">Every setting is a sentence. You can also just say it: ask Tidequill “show me my settings” or “set the budget to $60”.</p>
  </div>

  <div class="grid">
    <section class="card" aria-labelledby="s-h">
      <h2 id="s-h">How the site runs</h2>
      <SettingsList controls />
    </section>

    <div class="stack" style="gap: 24px">
      {#if site}
        <form class="card" aria-labelledby="about-h" onsubmit={saveAbout}>
          <h2 id="about-h">About this site</h2>
          <label class="field"><span>Name</span><input class="input" bind:value={siteName} disabled={!owner} /></label>
          <label class="field"><span>What it's about, in one sentence</span><textarea class="textarea serif" rows="2" bind:value={niche} disabled={!owner}></textarea></label>
          {#if owner && (siteName !== site.name || niche !== site.niche)}<div class="row"><button class="btn btn-dark" type="submit">Save</button></div>{/if}
        </form>

        <section class="card" id="domains" aria-labelledby="d-h">
          <h2 id="d-h">Domains</h2>
          <ul class="rows">
            {#each site.domains ?? [] as d (d)}
              <li>
                <span class="grow"><strong>{d}</strong>{#if d === site.primaryDomain} <span class="chip">Primary</span>{/if}</span>
                {#if owner}<button type="button" class="btn btn-sm btn-quiet" onclick={() => removeDomain(d)}>Remove</button>{/if}
              </li>
            {:else}
              <li class="muted">No domain yet. Preview the site at <a href="/_site/{site.id}/" target="_blank" rel="noreferrer">{origin}/_site/{site.id}/</a>.</li>
            {/each}
          </ul>
          {#if confirmRemove}
            <div class="confirm fade-in" role="alertdialog" aria-labelledby="confirm-h">
              <p id="confirm-h"><strong>{confirmRemove.summary}?</strong> Readers using {confirmRemove.hostname} won't reach the site any more. You can undo this for 10 seconds, or add it back later.</p>
              {#if confirmRemove.diff.length}<DiffView diff={confirmRemove.diff} compact />{/if}
              <div class="row">
                <button type="button" class="btn btn-dark" onclick={() => removeDomain(confirmRemove!.hostname, confirmRemove!.token)}>Remove {confirmRemove.hostname}</button>
                <button type="button" class="btn btn-quiet" onclick={() => (confirmRemove = null)}>Keep it</button>
              </div>
            </div>
          {/if}
          {#if owner}
            <form class="row" onsubmit={addDomain}>
              <label class="sr-only" for="domain">Domain</label>
              <input id="domain" class="input grow" placeholder="example.com" bind:value={domain} autocomplete="off" />
              <button class="btn" type="submit" disabled={!domain.trim()}>Add domain</button>
            </form>
            <p class="hint">Point the domain's DNS at this server; HTTPS is set up on the first visit.</p>
          {/if}
        </section>
      {/if}

      <section class="card" aria-labelledby="m-h">
        <h2 id="m-h">Who has access</h2>
        <ul class="rows">
          {#each members as m (m.id)}
            <li>
              <span class="grow col"><strong>{m.name}</strong><span class="small muted">{m.email} · {m.role === "owner" ? "Owner" : m.role === "writer" ? "Writer" : "Reviewer"}{m.active ? "" : " · invited"}</span></span>
              {#if owner && m.id !== session.user?.id}
                {#if removing === m.id}
                  <button type="button" class="btn btn-sm btn-dark" onclick={() => removeMember(m.id)}>Remove access</button>
                  <button type="button" class="btn btn-sm btn-quiet" onclick={() => (removing = null)}>Cancel</button>
                {:else}
                  <button type="button" class="btn btn-sm btn-quiet" onclick={() => (removing = m.id)}>Remove</button>
                {/if}
              {/if}
            </li>
          {/each}
        </ul>
        {#if owner}
          <form class="invite" onsubmit={invite}>
            <h3>Invite someone</h3>
            <div class="row">
              <label class="sr-only" for="inv-email">Email</label>
              <input id="inv-email" class="input grow" type="email" placeholder="Email" bind:value={inviteEmail} required />
              <label class="sr-only" for="inv-name">Name</label>
              <input id="inv-name" class="input grow" placeholder="Name (optional)" bind:value={inviteName} />
            </div>
            <div class="row">
              <label class="sr-only" for="inv-role">Role</label>
              <select id="inv-role" class="select" style="width: auto" bind:value={inviteRole}>
                <option value="writer">Writer: writes and edits</option>
                <option value="reviewer">Reviewer: reads and approves</option>
                <option value="owner">Owner: everything</option>
              </select>
              <button class="btn" type="submit">Invite</button>
            </div>
          </form>
          {#if inviteLink}
            <div class="linkbox fade-in">
              <span class="small muted">Send them this link. It works once.</span>
              <code>{inviteLink}</code>
              <button type="button" class="btn btn-sm" onclick={() => copy(inviteLink!, "Invitation link copied.")}>Copy link</button>
            </div>
          {/if}
        {/if}
      </section>

      <section class="card" aria-labelledby="t-h">
        <h2 id="t-h">Connect an AI assistant (MCP)</h2>
        <p class="muted small">Let Claude or another assistant use Tidequill with the same actions, approvals and undo you have. Tokens act as you.</p>
        <ul class="rows">
          {#each tokenList as t (t.id)}
            <li>
              <span class="grow col"><strong>{t.name}</strong><span class="small muted">{t.site_id ? "This site" : "All your sites"} · created {ago(t.created_at)}{t.last_used_at ? ` · used ${ago(t.last_used_at)}` : " · never used"}</span></span>
              <button type="button" class="btn btn-sm btn-quiet" onclick={() => deleteToken(t.id)}>Revoke</button>
            </li>
          {/each}
        </ul>
        <form class="row" onsubmit={createToken}>
          <label class="sr-only" for="tok-name">Token name</label>
          <input id="tok-name" class="input grow" bind:value={tokenName} placeholder="What it's for, e.g. Claude Desktop" />
          <label class="sr-only" for="tok-scope">Scope</label>
          <select id="tok-scope" class="select" style="width: auto" bind:value={tokenScope}><option value="site">This site</option><option value="all">All my sites</option></select>
          <button class="btn" type="submit">Create token</button>
        </form>
        {#if newToken}
          <div class="linkbox fade-in">
            <span class="small muted">Copy it now; it won't be shown again.</span>
            <code>{newToken}</code>
            <button type="button" class="btn btn-sm" onclick={() => copy(newToken!, "Token copied.")}>Copy token</button>
          </div>
        {/if}
        <div class="linkbox">
          <span class="small muted">MCP config</span>
          <pre>{mcpSnippet}</pre>
          <button type="button" class="btn btn-sm" onclick={() => copy(mcpSnippet, "MCP config copied.")}>Copy config</button>
        </div>
      </section>

      <div class="row"><a class="btn btn-quiet" href="/authors">Authors and voices</a><button type="button" class="btn btn-quiet" onclick={signOut}>Sign out</button></div>
    </div>
  </div>
</div>

<style>
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(360px, 1fr)); gap: 24px; align-items: start; }
  .rows { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
  .rows li { display: flex; align-items: center; gap: 8px; padding: 10px 0; border-bottom: 1px solid var(--border-soft); flex-wrap: wrap; }
  .rows li:last-child { border-bottom: 0; }
  .grow { flex: 1; min-width: 160px; }
  .col { display: flex; flex-direction: column; gap: 2px; }
  .invite { display: flex; flex-direction: column; gap: 10px; }
  h3 { font-size: 15px; }
  .linkbox { display: flex; flex-direction: column; gap: 8px; background: var(--surface-2); border: 1px solid var(--border); border-radius: 10px; padding: 12px; align-items: flex-start; }
  .linkbox code, .linkbox pre { font-family: ui-monospace, Menlo, monospace; font-size: 13px; overflow-wrap: anywhere; white-space: pre-wrap; margin: 0; user-select: all; }
  .confirm { background: var(--warn-bg); border-radius: 10px; padding: 14px; display: flex; flex-direction: column; gap: 10px; }
  @media (max-width: 719px) { .grid { grid-template-columns: minmax(0, 1fr); } }
</style>
