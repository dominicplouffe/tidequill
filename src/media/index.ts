import { registerJob, registerRecurring } from "../core/jobs.ts";
import type { Runtime } from "../core/runtime.ts";
import { extendApi } from "../server/app.ts";
import { ALT_JOB, altTextJob } from "./alt.ts";
import { purgeDeletedMedia } from "./actions.ts";
import { evidenceRoutes } from "./evidence.ts";
import { mediaRoutes } from "./routes.ts";

// Actions register on import: media.* and evidence.*.
import "./actions.ts";
import "./evidence.ts";

export { ingest, actorUserId } from "./ingest.ts";
export { offlineAltText, writeAltText } from "./alt.ts";
export { extractFacts } from "./facts.ts";
export { getEvidence, subjectOf, transcribe } from "./evidence.ts";
export { findMedia, getMedia, mediaUsage, searchMedia, processFile, ensureMediaTables, type Media, type Variant } from "./store.ts";
export { setFetch } from "./net.ts";

let installed = false;

/** Uploads and image variants, alt text, evidence capture. */
export async function install(_rt: Runtime) {
  if (installed) return;
  installed = true;
  registerJob(ALT_JOB, altTextJob);
  registerJob("media.purge", (ctx) => {
    purgeDeletedMedia(ctx);
  });
  registerRecurring("media.purge", 86_400_000, false);
  extendApi((app, rt) => {
    mediaRoutes(app, rt);
    evidenceRoutes(app, rt);
  });
}
