import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { authFromToken } from "../auth/auth.ts";
import { TqError } from "../core/errors.ts";
import type { Runtime } from "../core/runtime.ts";
import { extendApi } from "../server/app.ts";
import { createMcpServer } from "./server.ts";

export { createMcpServer, callTool, mcpTools, toolName, resolveSite, readResource, listResources, getPrompt, PROMPTS } from "./server.ts";

/**
 * Admin MCP endpoint: Streamable HTTP at POST /mcp on the admin host, in
 * stateless mode (one server and transport per request, JSON responses).
 * Auth is a personal access token: `Authorization: Bearer tq_...`.
 */

const unauthorized = (message: string, invalidToken: boolean) =>
  new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message }, id: null }), {
    status: 401,
    headers: {
      "content-type": "application/json",
      "www-authenticate": `Bearer realm="Tidequill"${invalidToken ? ', error="invalid_token", error_description="The token is unknown or was revoked"' : ""}`,
    },
  });

let installed = false;

export async function install(_rt: Runtime) {
  if (installed) return;
  installed = true;
  extendApi((app, rt) => {
    app.all("/mcp", async (c) => {
      const header = c.req.header("authorization") ?? "";
      const secret = header.match(/^Bearer\s+(\S+)$/i)?.[1];
      const auth = secret ? authFromToken(rt.db, secret) : null;
      if (!auth) {
        return unauthorized(
          secret ? "That access token isn't valid. Create a new one in Tidequill (or run: tq token create --name my-assistant)." : "Sign in with a Tidequill personal access token: Authorization: Bearer <token>.",
          !!secret,
        );
      }
      if (c.req.method !== "POST") {
        // Stateless server: no standalone event stream and no sessions to end.
        return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Send MCP requests with POST." }, id: null }), {
          status: 405,
          headers: { allow: "POST", "content-type": "application/json" },
        });
      }
      const server = createMcpServer(rt, auth, { defaultSite: c.req.query("site") ?? c.req.header("x-tq-site") ?? null });
      const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      await server.connect(transport);
      try {
        return await transport.handleRequest(c.req.raw);
      } finally {
        void server.close().catch(() => {});
      }
    });
  });
}

/** stdio mode for `tq mcp`: one session for one token. Logs go to stderr so stdout stays protocol-only. */
export async function runStdio(rt: Runtime, token: string, site?: string | null) {
  const auth = authFromToken(rt.db, token);
  if (!auth) throw new TqError("unauthorized", "That access token isn't valid. Create one with: tq token create --name my-assistant");
  const server = createMcpServer(rt, auth, { defaultSite: site ?? null });
  const closed = new Promise<void>((resolve) => {
    server.onclose = () => resolve();
  });
  await server.connect(new StdioServerTransport());
  // The client hanging up (end of input) ends the session.
  process.stdin.once("end", () => void server.close());
  return closed;
}
