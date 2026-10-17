import { findEntry } from "../core/entries.ts";
import { onEntrySaved, onPublished } from "../core/hooks.ts";
import { registerJob, registerRecurring } from "../core/jobs.ts";
import type { Runtime } from "../core/runtime.ts";
import { linkCheckJob } from "./actions.ts";
import { linkOnPublish, rebuildLinks } from "./engine.ts";

export { checkExternalLinks } from "./actions.ts";
export { linkOnPublish, linkableEntries, orphans, rebuildLinks, suggestIncoming, suggestOutgoing } from "./engine.ts";
export { checkUrl, isPublicHttpUrl, setFetch } from "./http.ts";
export { findAnchor, related } from "./related.ts";

/** Link graph, internal linking on publish, and the daily external link check. */
export async function install(rt: Runtime) {
  onEntrySaved((ctx, entry) => rebuildLinks(ctx, entry));
  // Core's undo restores revisions without the save hooks; keep the graph in step anyway.
  rt.on((e) => {
    if (e.type !== "entry.changed") return;
    const entry = findEntry(rt.db, e.siteId, e.entryId, true);
    if (entry) rebuildLinks(rt.ctx({ siteId: e.siteId }), entry);
  });
  onPublished((ctx, entry) => linkOnPublish(ctx, entry));
  registerJob("links.check", (ctx) => linkCheckJob(ctx));
  registerRecurring("links.check", 86_400_000);
}
