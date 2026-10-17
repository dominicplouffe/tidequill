import type { Runtime } from "../core/runtime.ts";

/** The public-site handler (static files by Host). Installed by the edge module. */
export type EdgeHandler = (req: Request, rt: Runtime, opts: { siteId?: string; basePath?: string }) => Promise<Response> | Response;

let edge: EdgeHandler = () => new Response("Tidequill edge is not installed.", { status: 503 });

export function setEdgeHandler(handler: EdgeHandler) {
  edge = handler;
}

export function edgeHandler(): EdgeHandler {
  return edge;
}
