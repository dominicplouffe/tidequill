import { action } from "./api.ts";
import { toast, undoAction } from "./toast.svelte.ts";
import type { LookOption } from "./types.ts";

/** Applies a generated look: house design first (if any), then the tokens. One toast, one Undo for both. */
export async function applyLook(o: LookOption, opts: { quiet?: boolean } = {}) {
  const undo: string[] = [];
  let proposed = false;
  if (o.design) {
    const d = await action("look.set_design", { design: o.design });
    if (d.status === "applied" && d.undoable) undo.push(d.actionId);
    if (d.status === "proposed") proposed = true;
  }
  const t = await action("look.update_tokens", { ...o.tokens, reason: `Picked the “${o.name}” look` });
  if (t.status === "applied" && t.undoable) undo.push(t.actionId);
  if (t.status === "proposed") proposed = true;
  if (opts.quiet) return { undo, proposed };
  if (proposed) toast(`The “${o.name}” look is waiting on Today for approval.`, { tone: "agent" });
  else
    toast(`Applied the “${o.name}” look.`, {
      undo: undo.length
        ? async () => {
            for (const id of [...undo].reverse()) await undoAction(id);
          }
        : undefined,
    });
  return { undo, proposed };
}
