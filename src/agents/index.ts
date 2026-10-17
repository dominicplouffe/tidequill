import { TqError } from "../core/errors.ts";
import { registerJob, registerRecurring } from "../core/jobs.ts";
import type { Runtime } from "../core/runtime.ts";
import { extendApi, requestCtx, requireAuth } from "../server/app.ts";
import { ask, askBody, conversation } from "./ask.ts";
import { command } from "./command.ts";
import { configureModels } from "./model.ts";
import { runWriteJob, WRITE_JOB } from "./pipeline.ts";
import { AUTOPILOT_EVERY_MS, AUTOPILOT_JOB, runAutopilot } from "./autopilot.ts";
import { findRun, runView } from "./runs.ts";

// Registering actions is a side effect of importing their modules.
import "./actions.ts";
import "./setup.ts";

export { modelFor, type ModelClient, type ModelRequest, type ModelResponse } from "./model.ts";

/**
 * The agents module: model adapter, editorial pipeline, Ask, the command bar,
 * onboarding setup, describe-the-look, voice learning, autopilot, budgets and
 * run history.
 */
export async function install(rt: Runtime) {
  configureModels(rt.config.models);

  registerJob(WRITE_JOB, runWriteJob);
  registerJob(AUTOPILOT_JOB, async (ctx) => {
    await runAutopilot(ctx);
  });
  registerRecurring(AUTOPILOT_JOB, AUTOPILOT_EVERY_MS, true);

  extendApi((app) => {
    app.post("/api/ask", async (c) => {
      const ctx = requestCtx(c);
      const parsed = askBody.safeParse(await c.req.json().catch(() => ({})));
      if (!parsed.success) throw new TqError("invalid", "Say something first: the message is empty or too long.");
      return c.json(await ask(ctx, parsed.data));
    });

    app.get("/api/ask/:conversationId", async (c) => {
      const ctx = requestCtx(c);
      return c.json(await conversation(ctx, c.req.param("conversationId")));
    });

    app.get("/api/runs/:runId", (c) => {
      requireAuth(c);
      const run = findRun(c.get("rt").db, c.req.param("runId"));
      if (!run) throw new TqError("not_found", "That job was not found.");
      // Checks the person has access to the run's site.
      const ctx = requestCtx(c, run.siteId);
      return c.json(runView(ctx.db, run));
    });

    app.post("/api/command", async (c) => {
      const ctx = requestCtx(c);
      const body = await c.req.json().catch(() => ({}));
      return c.json(command(ctx, String(body?.query ?? "").slice(0, 300)));
    });
  });
}
