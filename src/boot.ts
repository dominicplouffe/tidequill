import { loadConfig, type Config } from "./config.ts";
import { publishDue } from "./core/actions/posts.ts";
import type { Db } from "./core/db.ts";
import { Runtime } from "./core/runtime.ts";

// Registering actions is a side effect of importing their modules.
import "./core/actions/posts.ts";
import "./core/actions/site.ts";
import "./core/actions/history.ts";
import { installModules } from "./modules.ts";

/** Creates the runtime with every module installed. Does not start timers or the HTTP server. */
export async function boot(config: Config = loadConfig(), db?: Db): Promise<Runtime> {
  const rt = new Runtime(config, db);
  await installModules(rt);
  return rt;
}

/** Starts the job worker and the per-minute scheduler. */
export function startBackground(rt: Runtime) {
  rt.start(async () => {
    await publishDue(rt.ctx());
  });
}
