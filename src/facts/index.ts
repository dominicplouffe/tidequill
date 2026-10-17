import { findEntry } from "../core/entries.ts";
import { onEntrySaved } from "../core/hooks.ts";
import { registerJob, registerRecurring } from "../core/jobs.ts";
import type { Runtime } from "../core/runtime.ts";
import { reverifyJob } from "./actions.ts";
import { syncFactUsages } from "./ledger.ts";

export { reverifyJob, verifyFact, type VerifyResult } from "./actions.ts";
export { changeSummary, factMap, factPages, findFact, getFact, listFacts, syncFactUsages, verifyText, type Fact, type FactKind } from "./ledger.ts";

/** Fact ledger: usage tracking on every save and re-verification every 6 hours. */
export async function install(rt: Runtime) {
  onEntrySaved((ctx, entry) => syncFactUsages(ctx, entry));
  // Core's undo restores revisions without the save hooks; keep usages in step anyway.
  rt.on((e) => {
    if (e.type !== "entry.changed") return;
    const entry = findEntry(rt.db, e.siteId, e.entryId, true);
    if (entry) syncFactUsages(rt.ctx({ siteId: e.siteId }), entry);
  });
  registerJob("facts.reverify", (ctx) => reverifyJob(ctx));
  registerRecurring("facts.reverify", 6 * 3_600_000);
}
