/**
 * Shapes from docs/ARCHITECTURE.md and src/core. Kept as plain copies so the
 * admin builds on its own; if the server contract changes, change it here.
 */

export interface DiffItem {
  label: string;
  before?: string | null;
  after?: string | null;
  format?: "text" | "markdown" | "color" | "font" | "url" | "number";
}

export type InvokeResult<R = unknown> =
  | { status: "done"; result: R }
  | { status: "applied"; actionId: string; summary: string; result: R; auto: boolean; undoable: boolean }
  | { status: "proposed"; proposalId: string; summary: string; diff: DiffItem[] }
  | { status: "dry_run"; summary: string; diff: DiffItem[]; payload: any; confirmToken?: string }
  | { status: "needs_confirmation"; summary: string; diff: DiffItem[]; confirmToken: string };

export interface InvokeOptions {
  dryRun?: boolean;
  propose?: boolean;
  confirm?: string;
  groupId?: string;
}

export interface Finding {
  area: "human" | "seo" | "aeo" | "voice" | "check";
  message: string;
  severity: "info" | "warn" | "error";
  blockId?: string;
  quote?: string;
  suggestion?: string;
  code: string;
}

export interface Readiness {
  ready: boolean;
  light: "green" | "amber" | "red";
  scores: { human: number; seo: number; aeo: number; voice: number | null };
  minimums: { human: number; seo: number; aeo: number };
  headline: string;
  findings: Finding[];
  checks: { name: string; passed: boolean; message: string; blocking: boolean }[];
}

export interface Health {
  visitsThisWeek: number;
  visitsChangePct: number | null;
  aiVisitsThisWeek: number;
  aiByAssistant: { name: string; visits: number }[];
  medianLoadMs: number | null;
  topPages: { path: string; visits: number }[];
}

export interface TrustState {
  kind: string;
  label: string;
  clean: number;
  threshold: number | null;
  earned: boolean;
  earnedAt: string | null;
  justEarned?: boolean;
  justLost?: boolean;
}

export interface DesignTokens {
  colors: { background: string; surface: string; text: string; muted: string; accent: string; accentText: string; border: string; link: string };
  fonts: { heading: FontId; body: FontId };
  type: { baseSize: number; scale: number; lineHeight: number };
  layout: { width: number; radius: number };
}
export type FontId = "newsreader" | "hanken" | "system-sans" | "system-serif" | "mono";

export interface ProposalEntry {
  id: string;
  title: string;
  type?: "post" | "page";
  status?: string;
  path?: string;
  publishAt?: string | null;
  authors?: string[];
  words?: number;
  sources?: number;
  excerpt?: string;
  ready?: Readiness | null;
}

/** A proposal as today.get / proposals.list return it. */
export interface Proposal {
  id: string;
  siteId: string;
  actionName: string;
  input: any;
  summary: string;
  detail: string;
  diff: DiffItem[];
  trustKind: string;
  risk: string;
  actor: any;
  status: "pending" | "approved" | "discarded" | "superseded";
  groupId: string | null;
  entryId: string | null;
  runId: string | null;
  createdAt: string;
  costUsd: number;
  entry: ProposalEntry | null;
}

export interface ActionRow {
  id: string;
  name: string;
  summary: string;
  status: string;
  auto: boolean;
  risk: string;
  trustKind: string;
  by: string;
  undoable: boolean;
  costUsd: number;
  createdAt: string;
  undoneAt: string | null;
  proposalId: string | null;
  runId: string | null;
}

export interface TodayData {
  site: { id: string; name: string; domain: string | null };
  pending: Proposal[];
  doneOnItsOwn: ActionRow[];
  trust: TrustState[];
  askMeFirst: boolean;
  spend: { thisMonthUsd: number; budgetUsd: number };
  health: Health | null;
}

export interface User {
  id: string;
  email: string;
  name: string;
}

export interface SiteSummary {
  id: string;
  name: string;
  domain: string | null;
  role: "owner" | "writer" | "reviewer";
  niche?: string;
  waiting?: number;
  published?: number;
}

export interface AskContext {
  entryId?: string;
  blockId?: string;
  path?: string;
  screen?: string;
}

export type Card =
  | { type: "plan"; title: string; steps: { text: string; status: "pending" | "running" | "done" | "failed" }[]; costUsd: number; minutes: number; runId?: string; groupId?: string }
  | { type: "proposal"; proposalId: string; summary: string; diff: DiffItem[]; trustKind: string; status: string; entry?: { id: string; title: string; ready?: Readiness | null } }
  | { type: "applied"; actionId: string; summary: string; undoable: boolean; auto: boolean }
  | { type: "settings"; sentences: { key: string; sentence: string; say: string }[] }
  | { type: "results"; title: string; items: { title: string; subtitle?: string; href?: string; kind: string }[] }
  | { type: "progress"; runId: string; label: string; status: string }
  | { type: "looks"; options: LookOption[] }
  | { type: "navigate"; to: string; label: string }
  | { type: "error"; message: string };

export interface LookOption {
  name: string;
  description: string;
  tokens: DesignTokens;
  /** House design, if the option names one (harbor, workshop, studio). */
  design?: string;
}

export interface AskMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  cards: Card[];
  createdAt: string;
  /** Client-only: still being sent. */
  pending?: boolean;
}

export interface RunStatus {
  id: string;
  status: "queued" | "running" | "done" | "failed" | "paused";
  label: string;
  steps: { role: string; label: string; status: string; model?: string; costUsd?: number }[];
  costUsd: number;
  proposalIds: string[];
  error?: string;
}

export interface CommandResult {
  doIt: { label: string; hint: string; ask: string }[];
  goTo: { label: string; kind: string; href: string }[];
}

export interface Voice {
  sentenceLength: { value: number; label: string; avgWords?: number };
  formality: { value: number; label: string };
  humor: { value: number; label: string };
  depth: { value: number; label: string };
  person: string;
  vocabulary: string;
  structure: string;
  habits: string[];
  banned: string[];
  samples: string[];
  learnedFrom: string;
  spelling: string;
  version: number;
}

export interface Author {
  id: string;
  slug: string;
  name: string;
  bio: string;
  expertise: string[];
  credentials: string;
  userId: string | null;
  isPersona: boolean;
  requiresApproval: boolean;
  voice: Voice;
  photoMediaId: string | null;
  initials: string;
  posts?: number;
  evidence?: { items: number; photos: number };
}

export type Block =
  | { id: string; type: "paragraph"; text: string }
  | { id: string; type: "heading"; level: 2 | 3 | 4; text: string }
  | { id: string; type: "list"; ordered: boolean; items: string[] }
  | { id: string; type: "quote"; text: string; cite?: string }
  | { id: string; type: "image"; src: string; alt: string; caption?: string }
  | { id: string; type: "answer"; text: string }
  | { id: string; type: "callout"; tone: "note" | "tip" | "disclosure" | "warning"; text: string }
  | { id: string; type: "faq"; items: { q: string; a: string }[] }
  | { id: string; type: "table"; header: string[]; rows: string[][] }
  | { id: string; type: "code"; lang: string; text: string }
  | { id: string; type: "evidence"; evidenceId: string; kind: string; text: string; media?: string }
  | { id: string; type: "divider" };

export interface EntryFull {
  id: string;
  type: "post" | "page";
  slug: string;
  path: string;
  title: string;
  description: string;
  status: "draft" | "scheduled" | "published" | "unpublished";
  authors: { id: string; name: string; slug: string }[];
  categoryId: string | null;
  publishAt: string | null;
  publishedAt: string | null;
  updatedAt: string | null;
  modifiedAt: string | null;
  words: number;
  markdown: string;
  blocks?: Block[];
  tags: string[];
  heroMediaId: string | null;
  ready: Readiness | null;
}
