import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUser } from "../src/auth/auth.ts";
import { boot } from "../src/boot.ts";
import { loadConfig } from "../src/config.ts";
import { openDb } from "../src/core/db.ts";
import { invoke } from "../src/core/registry.ts";
import type { Runtime } from "../src/core/runtime.ts";
import type { AgentRole, Ctx, Role } from "../src/core/types.ts";

let booted: Runtime | null = null;

/**
 * A fresh install per call: in-memory database, temp data dir, an owner and
 * one site ("Walnut & Wire"). Actions are registered once per process, so the
 * runtime is reused but the database is new.
 */
export async function testSite(opts: { niche?: string; domain?: string } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "tq-test-"));
  const config = { ...loadConfig({ TQ_DATA_DIR: dataDir, TQ_MODEL_PROVIDER: "offline" }), dbPath: ":memory:" };
  const db = openDb(":memory:");
  let rt: Runtime;
  if (!booted) {
    booted = await boot(config, db);
    rt = booted;
  } else {
    const { Runtime } = await import("../src/core/runtime.ts");
    rt = new Runtime(config, db);
    // Reuse the event listeners modules installed on the first runtime.
    for (const l of (booted as any).listeners) rt.on(l);
  }
  const owner = await createUser(db, "owner@example.com", "Dana Owner", "correct horse battery");
  const human = (role: Role = "owner", siteId: string | null = null): Ctx => rt.ctx({ actor: { kind: "human", userId: owner.id, name: owner.name }, siteId, role });
  const created = await invoke(human("owner", null), "sites.create", {
    name: "Walnut & Wire",
    niche: opts.niche ?? "Honest guides to TV stands and media furniture for small living rooms, written by people who build and test them.",
    domain: opts.domain ?? "walnutandwire.test",
  });
  const siteId = (created as any).result.id as string;
  const as = (role: Role = "owner") => human(role, siteId);
  const agent = (role: AgentRole = "writer", runId?: string): Ctx => rt.ctx({ actor: { kind: "agent", role, onBehalfOf: owner.id, runId }, siteId, role: "owner", runId });
  const system = (): Ctx => rt.ctx({ siteId });
  return { rt, db, dataDir, owner, siteId, as, agent, system, invoke };
}
