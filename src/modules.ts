import type { Runtime } from "./core/runtime.ts";

/**
 * Feature modules. Each exports `install(rt)` which registers its actions,
 * hooks, jobs and routes. Order matters only where noted.
 */
export async function installModules(rt: Runtime) {
  const modules = [
    await import("./render/index.ts"), // renderer, look actions, build job
    await import("./edge/index.ts"), // static serving by Host, per-site MCP, analytics
    await import("./quality/index.ts"), // Ready light
    await import("./facts/index.ts"), // fact ledger, self-healing
    await import("./links/index.ts"), // link graph, internal linking, link checks
    await import("./media/index.ts"), // uploads, image variants, evidence capture
    await import("./agents/index.ts"), // model adapter, editorial team, Ask
    await import("./migrate/index.ts"), // WordPress import
    await import("./mcp/index.ts"), // admin MCP server
  ];
  for (const m of modules) await m.install(rt);
}
