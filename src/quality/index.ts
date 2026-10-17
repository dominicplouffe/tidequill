import { z } from "zod";
import { getEntry } from "../core/entries.ts";
import { invalid } from "../core/errors.ts";
import { setReadinessCheck } from "../core/hooks.ts";
import { defineAction } from "../core/registry.ts";
import type { Runtime } from "../core/runtime.ts";
import { buildFix } from "./fix.ts";
import { applyPatch, preparePatch, undoPatch } from "./patch.ts";
import { computeReadiness, readinessFor } from "./readiness.ts";

export { scoreAeo } from "./aeo.ts";
export { scoreHuman } from "./human.ts";
export { applyPatch, diffBlocks, preparePatch, undoPatch, type EntryPatch } from "./patch.ts";
export { computeReadiness, factValues, readinessFor, setRenderChecksForTests } from "./readiness.ts";
export { finalize, scoreEntry, type ScoreInput, type Scored } from "./score.ts";
export { scoreSeo } from "./seo.ts";
export { analyze } from "./text.ts";
export { scoreVoice } from "./voice.ts";

defineAction({
  name: "quality.score",
  title: "Is it ready?",
  description: "The Ready light for a draft or post: Human, SEO and answer-ready scores against the site's minimums, voice match, publish checks, and each fix in one sentence.",
  permission: "read",
  risk: "read",
  input: z.object({ id: z.string() }),
  run(ctx, input) {
    return computeReadiness(ctx, getEntry(ctx.db, ctx.siteId!, input.id));
  },
});

defineAction({
  name: "quality.fix",
  title: "Fix it",
  description:
    "Applies one Ready-light fix by its code (and blockId when the finding names one): cut a stock phrase, add a direct answer, add an FAQ, add a meta description, fix headings or alt text, add internal links, remove a broken link. Shows the change first on live posts.",
  permission: "write",
  risk: "reversible",
  trust: "refresh",
  input: z.object({ id: z.string(), code: z.string(), blockId: z.string().optional(), quote: z.string().optional() }),
  async prepare(ctx, input) {
    const entry = getEntry(ctx.db, ctx.siteId!, input.id);
    const ready = await computeReadiness(ctx, entry, { renderChecks: false });
    const finding = ready.findings.find((f) => f.code === input.code && (!input.blockId || f.blockId === input.blockId) && (!input.quote || f.quote === input.quote));
    if (!finding) throw invalid("That fix no longer applies; the post has changed since. Check the Ready light again.");
    const plan = buildFix(ctx, entry, finding);
    return preparePatch(entry, plan.body, { summary: plan.summary, detail: finding.message, liveTrust: plan.liveTrust, fields: plan.fields });
  },
  apply: applyPatch,
  undo: undoPatch,
});

/** The Ready light: one green/amber/red light per draft, with the details a tap away. */
export async function install(_rt: Runtime) {
  setReadinessCheck(readinessFor);
}
