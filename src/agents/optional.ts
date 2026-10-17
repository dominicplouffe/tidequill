import { getAction, invoke, type InvokeOptions, type InvokeResult } from "../core/registry.ts";
import type { Ctx } from "../core/types.ts";

/**
 * Some actions the agents use are built by other modules (look.update_tokens
 * by render, facts.* by facts, quality.score by quality). They may not be
 * installed, and their exact input shapes are theirs to decide, so agents
 * check they exist and pick the first input shape the schema accepts.
 */

export function hasAction(name: string): boolean {
  try {
    getAction(name);
    return true;
  } catch {
    return false;
  }
}

/** The first candidate input the action's schema accepts with all its keys, or null (also null when the action isn't installed). */
export function fitInput(name: string, candidates: unknown[]): unknown | null {
  if (!hasAction(name)) return null;
  const def = getAction(name);
  for (const c of candidates) {
    const parsed = def.input.safeParse(c);
    // Zod drops unknown keys, so a shape only fits if every key we meant survives parsing.
    if (parsed.success && (typeof c !== "object" || c === null || Object.keys(c).every((k) => parsed.data && typeof parsed.data === "object" && k in (parsed.data as object)))) return c;
  }
  return null;
}

/** Invokes an optional action with the first input shape it accepts. Returns null when it isn't available. */
export async function invokeOptional(ctx: Ctx, name: string, candidates: unknown[], opts?: InvokeOptions): Promise<InvokeResult | null> {
  const input = fitInput(name, candidates);
  if (input === null) return null;
  return invoke(ctx, name, input, opts);
}
