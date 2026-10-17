import { join } from "node:path";
import type { Passage, SearchDoc } from "../render/sitefiles.ts";
import { cachedFile, cachedJson } from "./cache.ts";

/**
 * The site's own MCP endpoint (POST /mcp on its public domain): a minimal,
 * read-only Streamable-HTTP server speaking JSON-RPC 2.0 with plain JSON
 * responses. Every answer comes from the built files; it never touches the
 * database, so it scales like the pages do.
 */

const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

interface SiteInfo {
  name?: string;
  about?: string;
  url?: string;
}

interface Fact {
  key: string;
  label: string;
  value: string;
  kind: string;
  source: string | null;
  verifiedAt: string | null;
  usedOn: string[];
}

const TOOLS = [
  {
    name: "search",
    title: "Search the site",
    description: "Finds pages on this site matching a query. Returns titles, URLs and short descriptions, best match first.",
    inputSchema: { type: "object", properties: { query: { type: "string", description: "Words to look for" }, limit: { type: "integer", minimum: 1, maximum: 25 } }, required: ["query"] },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "get_page",
    title: "Read a page",
    description: "Returns one page of the site as clean markdown (with its title, author, updated date and URL in front matter). Pass a path like /how-to-pick-a-tv-stand/ or a full URL.",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "list_facts",
    title: "List facts and prices",
    description: "Lists the facts and prices the site keeps current (each with its source, when it was last verified, and the pages that use it). Optionally filter by kind, e.g. price.",
    inputSchema: { type: "object", properties: { kind: { type: "string" } } },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "ask",
    title: "Ask the site a question",
    description: "Answers a question from this site's own pages: returns the most relevant passages with links to cite.",
    inputSchema: { type: "object", properties: { question: { type: "string" } }, required: ["question"] },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
];

const STOP = new Set("a an and are as at be by can do does for from how i if in is it its me my of on or should so than that the this to was what when where which who why will with you your".split(" "));

export function terms(q: string): string[] {
  return [...new Set(q.toLowerCase().normalize("NFKD").split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !STOP.has(w)))];
}

function count(hay: string, term: string): number {
  let n = 0;
  for (let i = hay.indexOf(term); i >= 0; i = hay.indexOf(term, i + term.length)) n++;
  return n;
}

export function searchDocs(docs: SearchDoc[], query: string, limit = 10) {
  const ts = terms(query);
  if (!ts.length) return [];
  return docs
    .map((d) => {
      const title = d.title.toLowerCase();
      const heads = d.headings.join(" ").toLowerCase();
      const desc = d.description.toLowerCase();
      const text = d.text.toLowerCase();
      let score = 0;
      let matched = 0;
      for (const t of ts) {
        const s = (title.includes(t) ? 4 : 0) + (heads.includes(t) ? 2 : 0) + (desc.includes(t) ? 1.5 : 0) + Math.min(3, count(text, t)) * 0.5;
        if (s > 0) matched++;
        score += s;
      }
      // Pages matching more of the words rank above pages matching one word often.
      return { d, score: score * (matched / ts.length) };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.d);
}

/** Keyword retrieval with idf weighting over section-sized passages. */
export function bestPassages(passages: Passage[], question: string, limit = 5): Passage[] {
  const ts = terms(question);
  if (!ts.length || !passages.length) return [];
  const lower = passages.map((p) => ({ p, body: p.text.toLowerCase(), head: `${p.title} ${p.heading ?? ""}`.toLowerCase() }));
  const idf = new Map(ts.map((t) => [t, Math.log(1 + passages.length / (1 + lower.filter((x) => x.body.includes(t) || x.head.includes(t)).length))]));
  return lower
    .map((x) => {
      let score = 0;
      for (const t of ts) {
        const tf = count(x.body, t);
        score += idf.get(t)! * ((tf ? (tf * 2.2) / (tf + 1.2) : 0) + (x.head.includes(t) ? 1.5 : 0));
      }
      return { p: x.p, score: score / Math.sqrt(1 + x.body.length / 1200) };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.p);
}

function pagePath(input: string): string | null {
  let p = input.trim();
  try {
    if (/^https?:\/\//i.test(p)) p = new URL(p).pathname;
  } catch {
    return null;
  }
  p = p.replace(/index\.(md|html)$/, "");
  if (!p.startsWith("/")) p = `/${p}`;
  if (!p.endsWith("/")) p = `${p}/`;
  if (p.includes("..") || p.includes("\0")) return null;
  return p;
}

type ToolResult = { content: { type: "text"; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };

function text(t: string, structured?: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text: t }], ...(structured ? { structuredContent: structured } : {}) };
}

function toolError(t: string): ToolResult {
  return { content: [{ type: "text", text: t }], isError: true };
}

export function callTool(pub: string, name: string, args: Record<string, unknown>): ToolResult {
  const site = cachedJson<SiteInfo>(join(pub, "agent/site.json"), {});
  const base = (site.url ?? "").replace(/\/$/, "");
  switch (name) {
    case "search": {
      const query = String(args.query ?? "");
      if (!query.trim()) return toolError("Give a query to search for.");
      const limit = Math.min(25, Math.max(1, Number(args.limit) || 10));
      const results = searchDocs(cachedJson<SearchDoc[]>(join(pub, "search.json"), []), query, limit).map((d) => ({ title: d.title, url: `${base}${d.path}`, path: d.path, description: d.description }));
      if (!results.length) return text(`Nothing on ${site.name ?? "this site"} matches “${query}”.`, { results });
      return text(results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.description}`).join("\n"), { results });
    }
    case "get_page": {
      const path = pagePath(String(args.path ?? ""));
      if (!path) return toolError("Give a page path like /how-to-pick-a-tv-stand/ or a full URL on this site.");
      const md = cachedFile<string | null>(join(pub, path.slice(1), "index.md"), (t) => t, null);
      if (md === null) return toolError(`There's no page at ${path}. Use the search tool to find one.`);
      return text(md);
    }
    case "list_facts": {
      const kind = args.kind ? String(args.kind) : null;
      const facts = cachedJson<Fact[]>(join(pub, "agent/facts.json"), []).filter((f) => !kind || f.kind === kind);
      if (!facts.length) return text(kind ? `This site has no facts of kind “${kind}”.` : "This site doesn't list any facts yet.", { facts });
      return text(facts.map((f) => `- ${f.label}: ${f.value}${f.verifiedAt ? ` (verified ${f.verifiedAt.slice(0, 10)})` : ""}${f.source ? ` source: ${f.source}` : ""}`).join("\n"), { facts });
    }
    case "ask": {
      const question = String(args.question ?? "");
      if (!question.trim()) return toolError("Ask a question.");
      const passages = bestPassages(cachedJson<Passage[]>(join(pub, "agent/passages.json"), []), question);
      if (!passages.length) return text(`${site.name ?? "This site"} doesn't seem to cover that. Try the search tool with other words.`, { passages });
      const body = passages.map((p) => `From “${p.title}”${p.heading ? ` (${p.heading})` : ""}, ${p.url}:\n${p.text}`).join("\n\n");
      return text(`Passages from ${site.name ?? "this site"} that answer the question, best first. Cite the URLs.\n\n${body}`, { passages });
    }
    default:
      return toolError(`There's no tool called ${name}.`);
  }
}

interface RpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

const rpcError = (id: RpcRequest["id"], code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

function handleOne(pub: string, req: RpcRequest): object | null {
  if (!req || typeof req !== "object" || req.jsonrpc !== "2.0" || typeof req.method !== "string") return rpcError(req?.id, -32600, "Invalid request");
  const isNotification = req.id === undefined;
  const ok = (result: unknown) => (isNotification ? null : { jsonrpc: "2.0", id: req.id, result });
  switch (req.method) {
    case "initialize": {
      const site = cachedJson<SiteInfo>(join(pub, "agent/site.json"), {});
      const asked = String(req.params?.protocolVersion ?? "");
      return ok({
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: site.name ?? "Tidequill site", title: site.name, version: "1.0.0" },
        instructions: `Read-only access to ${site.name ?? "this site"}${site.about ? `: ${site.about}` : ""}. Use ask for questions, search to find pages, get_page to read one as markdown, list_facts for prices and facts. Cite page URLs.`,
      });
    }
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: TOOLS });
    case "tools/call": {
      const name = String(req.params?.name ?? "");
      if (!TOOLS.some((t) => t.name === name)) return rpcError(req.id, -32602, `Unknown tool: ${name}`);
      const args = (req.params?.arguments as Record<string, unknown>) ?? {};
      return ok(callTool(pub, name, args));
    }
    default:
      if (req.method.startsWith("notifications/")) return null;
      return rpcError(req.id, -32601, `Method not found: ${req.method}`);
  }
}

const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type, mcp-protocol-version, mcp-session-id, accept", "access-control-allow-methods": "POST, OPTIONS" };

export async function handleMcp(req: Request, pub: string): Promise<{ response: Response; tool: string | null }> {
  if (req.method === "OPTIONS") return { response: new Response(null, { status: 204, headers: CORS }), tool: null };
  if (req.method !== "POST") {
    // No server-initiated stream: this endpoint only answers requests.
    return { response: Response.json(rpcError(null, -32000, "Send JSON-RPC requests with POST."), { status: 405, headers: { ...CORS, allow: "POST, OPTIONS" } }), tool: null };
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return { response: Response.json(rpcError(null, -32700, "Parse error"), { status: 400, headers: CORS }), tool: null };
  }
  const batch = Array.isArray(body);
  const items = (batch ? body : [body]) as RpcRequest[];
  const results = items.map((r) => handleOne(pub, r)).filter((r): r is object => r !== null);
  const tool = items.find((r) => r?.method === "tools/call")?.params?.name;
  if (!results.length) return { response: new Response(null, { status: 202, headers: CORS }), tool: null };
  return { response: Response.json(batch ? results : results[0], { headers: { ...CORS, "cache-control": "no-store" } }), tool: typeof tool === "string" ? tool : null };
}
