import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { authFromToken, createToken } from "../src/auth/auth.ts";
import { describeActions } from "../src/core/registry.ts";
import { createMcpServer } from "../src/mcp/server.ts";
import { createApi } from "../src/server/app.ts";
import { testSite } from "./helpers.ts";

async function setup() {
  const t = await testSite();
  const token = createToken(t.db, t.owner.id, "Claude Desktop", null, null);
  const api = createApi(t.rt);
  let n = 0;
  const rpc = async (method: string, params: unknown = {}, auth: string | null = token) => {
    const res = await api.fetch(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(auth ? { authorization: `Bearer ${auth}` } : {}) },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++n, method, params }),
      }),
    );
    return { status: res.status, headers: res.headers, body: (await res.json()) as any };
  };
  const call = async (name: string, args: Record<string, unknown> = {}) => (await rpc("tools/call", { name, arguments: args })).body.result;
  return { ...t, token, api, rpc, call };
}

describe("admin MCP server over HTTP", () => {
  test("requires a personal access token", async () => {
    const t = await setup();
    const none = await t.rpc("tools/list", {}, null);
    expect(none.status).toBe(401);
    expect(none.headers.get("www-authenticate")).toStartWith("Bearer");
    const bad = await t.rpc("tools/list", {}, "tq_not_a_real_token");
    expect(bad.status).toBe(401);
    expect(bad.headers.get("www-authenticate")).toContain('error="invalid_token"');
    const get = await t.api.fetch(new Request("http://localhost/mcp", { headers: { authorization: `Bearer ${t.token}` } }));
    expect(get.status).toBe(405);
  });

  test("initializes and lists every action as a tool", async () => {
    const t = await setup();
    const init = await t.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    expect(init.body.result.serverInfo.name).toBe("tidequill");
    expect(init.body.result.capabilities.tools).toBeDefined();

    const { body } = await t.rpc("tools/list");
    const tools = body.result.tools as any[];
    expect(tools.length).toBe(describeActions().length);
    const create = tools.find((x) => x.name === "posts_create");
    expect(create).toBeDefined();
    expect(create.inputSchema.properties.title).toBeDefined();
    expect(create.inputSchema.properties.site).toBeDefined();
    expect(create.description).toContain("nothing changes until a person approves");
    const del = tools.find((x) => x.name === "posts_delete");
    expect(del.annotations.destructiveHint).toBe(true);
    expect(del.inputSchema.properties._confirm).toBeDefined();
    expect(tools.find((x) => x.name === "sites_list").inputSchema.properties.site).toBeUndefined();
    expect(tools.find((x) => x.name === "media_set_alt")).toBeDefined();
    expect(tools.find((x) => x.name === "migrate_wordpress")).toBeDefined();
  });

  test("drafts apply, edits to live posts become proposals, deletes need a dry run", async () => {
    const t = await setup();
    const draft = await t.call("posts_create", { title: "Walnut stands compared", markdown: "First paragraph." });
    expect(draft.isError).toBeUndefined();
    expect(draft.structuredContent.status).toBe("applied");
    const entryId = draft.structuredContent.result.id;
    const row = t.db.query<any, [string]>("SELECT actor FROM revisions WHERE entry_id = ?").get(entryId);
    expect(JSON.parse(row.actor)).toEqual({ kind: "agent", role: "editor", onBehalfOf: t.owner.id });

    await t.invoke(t.as(), "posts.publish", { id: entryId, override: "test" });
    const edit = await t.call("posts_update", { id: entryId, markdown: "A better first paragraph.", reason: "Clearer opening" });
    expect(edit.structuredContent.status).toBe("proposed");
    expect(edit.content[0].text).toContain("Nothing changes until a person approves it");
    const proposal = t.db.query<any, [string]>("SELECT * FROM proposals WHERE id = ?").get(edit.structuredContent.proposalId);
    expect(proposal.status).toBe("pending");
    expect(JSON.parse(proposal.actor)).toMatchObject({ kind: "agent", onBehalfOf: t.owner.id });
    const live: any = await t.invoke(t.as(), "posts.get", { id: entryId });
    expect(live.result.markdown).toBe("First paragraph.\n");

    // Destructive: first call is a dry run with a confirm token; with the token it is proposed, never applied.
    const first = await t.call("posts_delete", { id: entryId });
    expect(first.structuredContent.status).toBe("dry_run");
    expect(first.content[0].text).toContain("Nothing was changed");
    const token = first.structuredContent.confirmToken;
    expect(token).toBeTruthy();
    const wrong = await t.call("posts_delete", { id: entryId, _confirm: "1.nope" });
    expect(wrong.isError).toBe(true);
    const second = await t.call("posts_delete", { id: entryId, _confirm: token });
    expect(second.structuredContent.status).toBe("proposed");

    // People-only decisions are refused.
    const approve = await t.call("proposals_approve", { id: edit.structuredContent.proposalId });
    expect(approve.isError).toBe(true);
    expect(approve.content[0].text).toContain("Only a person");

    // Dry runs change nothing.
    const dry = await t.call("brain_add", { kind: "fact", text: "Walnut darkens with sunlight.", _dryRun: true });
    expect(dry.structuredContent.status).toBe("dry_run");
    expect(t.db.query("SELECT COUNT(*) AS n FROM brain WHERE site_id = ?").get(t.siteId)).toEqual({ n: 0 });
  });

  test("site comes from the token, the site argument, or the only site", async () => {
    const t = await setup();
    await t.invoke(t.rt.ctx({ actor: { kind: "human", userId: t.owner.id }, siteId: null, role: null }), "sites.create", { name: "Second Site", domain: "second.test" });
    const ambiguous = await t.call("posts_list", {});
    expect(ambiguous.isError).toBe(true);
    expect(ambiguous.content[0].text).toContain("Say which site");
    const byDomain = await t.call("posts_list", { site: "walnutandwire.test" });
    expect(byDomain.structuredContent.status).toBe("done");

    const scoped = createToken(t.db, t.owner.id, "scoped", t.siteId, "reviewer");
    const res = await t.rpc("tools/call", { name: "posts_create", arguments: { title: "Nope" } }, scoped);
    expect(res.body.result.isError).toBe(true);
    const other = await t.rpc("tools/call", { name: "posts_list", arguments: { site: "second.test" } }, scoped);
    expect(other.body.result.content[0].text).toContain("can't reach");
  });

  test("resources and prompts", async () => {
    const t = await setup();
    const draft: any = await t.invoke(t.as(), "posts.create", { title: "Oak stand review", markdown: "It is solid." });
    const list = await t.rpc("resources/list");
    const uris = list.body.result.resources.map((r: any) => r.uri);
    expect(uris).toContain(`tq://${t.siteId}/settings`);
    expect(uris).toContain(`tq://${t.siteId}/posts/${draft.result.id}`);
    const read = await t.rpc("resources/read", { uri: `tq://${t.siteId}/posts/${draft.result.id}` });
    const text = read.body.result.contents[0].text;
    expect(text).toContain('title: "Oak stand review"');
    expect(text).toContain("It is solid.");
    const settings = await t.rpc("resources/read", { uri: `tq://${t.siteId}/settings` });
    expect(JSON.parse(settings.body.result.contents[0].text).sentences.length).toBeGreaterThan(3);

    const prompts = await t.rpc("prompts/list");
    expect(prompts.body.result.prompts.map((p: any) => p.name)).toEqual(["write_post_as_author", "refresh_decaying_post", "launch_new_site"]);
    const p = await t.rpc("prompts/get", { name: "write_post_as_author", arguments: { author: "Fred", topic: "oak stands" } });
    expect(p.body.result.messages[0].content.text).toContain("posts_create");
  });
});

describe("admin MCP server with the SDK client", () => {
  test("a real MCP client can list and call tools", async () => {
    const t = await testSite();
    const token = createToken(t.db, t.owner.id, "sdk", t.siteId, null);
    const server = createMcpServer(t.rt, authFromToken(t.db, token)!);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await client.connect(b);
    const { tools } = await client.listTools();
    expect(tools.some((x) => x.name === "posts_create")).toBe(true);
    const res: any = await client.callTool({ name: "posts_create", arguments: { title: "From a real client" } });
    expect(res.structuredContent.status).toBe("applied");
    await client.close();
  });
});
