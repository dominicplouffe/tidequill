/** An error whose message is safe and useful to show a person: what happened and what to do. */
export class TqError extends Error {
  constructor(
    public code: "not_found" | "forbidden" | "invalid" | "conflict" | "needs_confirmation" | "unauthorized" | "budget" | "failed",
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
  get status(): number {
    return { not_found: 404, forbidden: 403, invalid: 400, conflict: 409, needs_confirmation: 409, unauthorized: 401, budget: 402, failed: 500 }[this.code];
  }
}

export const notFound = (what: string) => new TqError("not_found", `${what} was not found.`);
export const forbidden = (msg = "You don't have permission to do that on this site.") => new TqError("forbidden", msg);
export const invalid = (msg: string, details?: unknown) => new TqError("invalid", msg, details);
