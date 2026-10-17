// SQL migrations. Applied in order; each runs once and is recorded in `meta`.
// Rules from the spec: every content row carries site_id, deletes are soft,
// and `actions` and `revisions` are append-only (rows are never rewritten
// except for status bookkeeping on actions).

export const migrations: string[] = [
  /* 001: everything v1 needs */ `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  site_id TEXT,
  role TEXT,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);

CREATE TABLE sites (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  niche TEXT NOT NULL DEFAULT '',
  locale TEXT NOT NULL DEFAULT 'en-US',
  design TEXT NOT NULL DEFAULT 'harbor',
  tokens TEXT NOT NULL DEFAULT '{}',
  settings TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE domains (
  hostname TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id),
  is_primary INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX domains_site ON domains(site_id);

CREATE TABLE memberships (
  user_id TEXT NOT NULL REFERENCES users(id),
  site_id TEXT NOT NULL REFERENCES sites(id),
  role TEXT NOT NULL,
  PRIMARY KEY (user_id, site_id)
);

CREATE TABLE authors (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id),
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  bio TEXT NOT NULL DEFAULT '',
  expertise TEXT NOT NULL DEFAULT '[]',
  credentials TEXT NOT NULL DEFAULT '',
  user_id TEXT,
  is_persona INTEGER NOT NULL DEFAULT 0,
  requires_approval INTEGER NOT NULL DEFAULT 1,
  voice TEXT NOT NULL DEFAULT '{}',
  photo_media_id TEXT,
  created_at TEXT NOT NULL,
  deleted_at TEXT,
  UNIQUE (site_id, slug)
);

CREATE TABLE categories (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id),
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT,
  UNIQUE (site_id, slug)
);

CREATE TABLE entries (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id),
  type TEXT NOT NULL,
  slug TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL,
  author_ids TEXT NOT NULL DEFAULT '[]',
  category_id TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  hero_media_id TEXT,
  publish_at TEXT,
  published_at TEXT,
  updated_at TEXT,
  created_at TEXT NOT NULL,
  modified_at TEXT NOT NULL,
  deleted_at TEXT,
  current_revision_id TEXT,
  UNIQUE (site_id, type, slug)
);
CREATE INDEX entries_site_status ON entries(site_id, status);

CREATE TABLE revisions (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  snapshot TEXT NOT NULL,
  actor TEXT NOT NULL,
  action_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX revisions_entry ON revisions(entry_id, created_at);

CREATE TABLE media (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id),
  file_key TEXT NOT NULL,
  mime TEXT NOT NULL,
  width INTEGER,
  height INTEGER,
  bytes INTEGER NOT NULL DEFAULT 0,
  alt TEXT NOT NULL DEFAULT '',
  caption TEXT NOT NULL DEFAULT '',
  focal TEXT,
  variants TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE evidence (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id),
  author_id TEXT,
  kind TEXT NOT NULL,
  topic TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL DEFAULT '',
  media_id TEXT,
  extracted TEXT NOT NULL DEFAULT '{}',
  captured_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE facts (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id),
  key TEXT NOT NULL,
  label TEXT NOT NULL,
  value TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'fact',
  source_url TEXT,
  verified_at TEXT,
  check_every_days INTEGER NOT NULL DEFAULT 365,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  UNIQUE (site_id, key)
);

CREATE TABLE fact_usages (
  fact_id TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  PRIMARY KEY (fact_id, entry_id)
);

CREATE TABLE links (
  site_id TEXT NOT NULL,
  from_entry_id TEXT NOT NULL,
  block_id TEXT NOT NULL,
  to_entry_id TEXT,
  url TEXT,
  anchor TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'unchecked',
  checked_at TEXT
);
CREATE INDEX links_from ON links(from_entry_id);
CREATE INDEX links_to ON links(to_entry_id);

CREATE TABLE brain (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id),
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  source TEXT,
  verified_at TEXT,
  created_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE redirects (
  site_id TEXT NOT NULL,
  from_path TEXT NOT NULL,
  to_path TEXT NOT NULL,
  code INTEGER NOT NULL DEFAULT 301,
  created_at TEXT NOT NULL,
  PRIMARY KEY (site_id, from_path)
);

CREATE TABLE actions (
  id TEXT PRIMARY KEY,
  site_id TEXT,
  name TEXT NOT NULL,
  input TEXT NOT NULL,
  actor TEXT NOT NULL,
  status TEXT NOT NULL,
  risk TEXT NOT NULL,
  trust_kind TEXT,
  summary TEXT NOT NULL DEFAULT '',
  undo TEXT,
  result TEXT,
  proposal_id TEXT,
  run_id TEXT,
  auto INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  undone_at TEXT
);
CREATE INDEX actions_site_time ON actions(site_id, created_at);

CREATE TABLE proposals (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  action_name TEXT NOT NULL,
  input TEXT NOT NULL,
  payload TEXT NOT NULL,
  summary TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  diff TEXT NOT NULL DEFAULT '[]',
  trust_kind TEXT,
  risk TEXT NOT NULL,
  actor TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  group_id TEXT,
  entry_id TEXT,
  run_id TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT,
  decided_by TEXT,
  edited INTEGER NOT NULL DEFAULT 0,
  reason TEXT,
  cost_usd REAL NOT NULL DEFAULT 0,
  action_id TEXT
);
CREATE INDEX proposals_site_status ON proposals(site_id, status);

CREATE TABLE trust (
  site_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  clean INTEGER NOT NULL DEFAULT 0,
  earned_at TEXT,
  PRIMARY KEY (site_id, kind)
);

CREATE TABLE snapshots (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  label TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE agent_runs (
  id TEXT PRIMARY KEY,
  site_id TEXT,
  requester TEXT NOT NULL,
  request TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT '[]',
  steps TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL,
  cost_usd REAL NOT NULL DEFAULT 0,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  site_id TEXT,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX messages_conv ON messages(conversation_id, created_at);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  site_id TEXT,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'queued',
  run_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX jobs_due ON jobs(status, run_at);
`,
];
