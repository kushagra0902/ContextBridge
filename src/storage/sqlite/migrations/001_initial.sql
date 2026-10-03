CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  applied_at TEXT NOT NULL
) STRICT;

CREATE TABLE sources (
  source_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('codex_rollout', 'codex_history', 'codex_session_index')),
  normalized_path TEXT NOT NULL,
  format_version TEXT NOT NULL,
  device TEXT,
  inode TEXT,
  size INTEGER NOT NULL CHECK (size >= 0),
  modified_at_ms REAL NOT NULL CHECK (modified_at_ms >= 0),
  last_seen_at TEXT NOT NULL,
  record_json TEXT NOT NULL
) STRICT;

CREATE INDEX sources_path_idx ON sources(normalized_path);

CREATE TABLE source_cursors (
  source_id TEXT PRIMARY KEY REFERENCES sources(source_id) ON DELETE CASCADE,
  file_fingerprint TEXT NOT NULL,
  committed_byte_offset INTEGER NOT NULL CHECK (committed_byte_offset >= 0),
  last_complete_line_hash TEXT,
  committed_at TEXT NOT NULL
) STRICT;

CREATE TABLE projects (
  project_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  last_activity_at TEXT,
  record_json TEXT NOT NULL
) STRICT;

CREATE TABLE project_locations (
  normalized_path TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  last_seen_at TEXT NOT NULL
) STRICT;

CREATE INDEX project_locations_project_idx ON project_locations(project_id);

CREATE TABLE workstreams (
  workstream_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  branch TEXT,
  issue_id TEXT,
  last_activity_at TEXT,
  record_json TEXT NOT NULL
) STRICT;

CREATE INDEX workstreams_project_idx ON workstreams(project_id);

CREATE TABLE sessions (
  session_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  workstream_id TEXT REFERENCES workstreams(workstream_id) ON DELETE SET NULL,
  title TEXT,
  branch TEXT,
  head_commit TEXT,
  started_at TEXT,
  last_activity_at TEXT,
  record_json TEXT NOT NULL
) STRICT;

CREATE INDEX sessions_project_idx ON sessions(project_id);
CREATE INDEX sessions_workstream_idx ON sessions(workstream_id);

CREATE TABLE aliases (
  alias_key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  normalized_value TEXT NOT NULL,
  project_id TEXT NOT NULL,
  workstream_id TEXT,
  session_id TEXT,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL,
  record_json TEXT NOT NULL
) STRICT;

CREATE INDEX aliases_lookup_idx ON aliases(normalized_value);
CREATE INDEX aliases_scope_idx ON aliases(project_id, workstream_id, session_id);

CREATE TABLE explicit_mappings (
  selector_key TEXT PRIMARY KEY,
  selector_kind TEXT NOT NULL,
  selector_value TEXT NOT NULL,
  project_id TEXT NOT NULL,
  workstream_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  record_json TEXT NOT NULL
) STRICT;

CREATE INDEX explicit_mappings_session_idx
  ON explicit_mappings(selector_value)
  WHERE selector_kind = 'session';

CREATE TABLE exclusions (
  scope_key TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  workstream_id TEXT,
  session_id TEXT,
  reason TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('excluded', 'deletion_pending', 'deleted')),
  blocks_ingestion INTEGER NOT NULL CHECK (blocks_ingestion = 1),
  excluded_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  physical_deletion_completed_at TEXT,
  record_json TEXT NOT NULL,
  CHECK (
    (status = 'deleted' AND physical_deletion_completed_at IS NOT NULL) OR
    (status != 'deleted' AND physical_deletion_completed_at IS NULL)
  )
) STRICT;

CREATE INDEX exclusions_scope_idx
  ON exclusions(project_id, workstream_id, session_id, status);

CREATE TABLE events (
  event_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  kind TEXT NOT NULL CHECK (kind IN ('user_message', 'assistant_message', 'tool_call', 'tool_result')),
  observed_at TEXT,
  text TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  source_id TEXT NOT NULL REFERENCES sources(source_id) ON DELETE RESTRICT,
  source_ordinal INTEGER NOT NULL CHECK (source_ordinal >= 0),
  byte_start INTEGER,
  byte_end INTEGER,
  format_version TEXT NOT NULL,
  record_json TEXT NOT NULL,
  CHECK (byte_start IS NULL OR byte_start >= 0),
  CHECK (byte_end IS NULL OR byte_end >= byte_start)
) STRICT;

CREATE INDEX events_session_order_idx ON events(session_id, ordinal, event_id);
CREATE INDEX events_source_idx ON events(source_id, source_ordinal);

CREATE TABLE chunks (
  chunk_id TEXT PRIMARY KEY,
  project_id TEXT,
  workstream_id TEXT,
  session_id TEXT NOT NULL,
  display_text TEXT NOT NULL,
  embedding_text TEXT NOT NULL,
  token_count INTEGER NOT NULL CHECK (token_count >= 0),
  fingerprint TEXT NOT NULL,
  observed_from TEXT,
  observed_to TEXT,
  record_json TEXT NOT NULL
) STRICT;

CREATE INDEX chunks_scope_idx ON chunks(project_id, workstream_id, session_id);
CREATE INDEX chunks_fingerprint_idx ON chunks(fingerprint);

CREATE TABLE chunk_events (
  chunk_id TEXT NOT NULL REFERENCES chunks(chunk_id) ON DELETE CASCADE,
  event_id TEXT NOT NULL REFERENCES events(event_id) ON DELETE RESTRICT,
  position INTEGER NOT NULL CHECK (position >= 0),
  PRIMARY KEY (chunk_id, position),
  UNIQUE (chunk_id, event_id)
) WITHOUT ROWID, STRICT;

CREATE TABLE memories (
  memory_id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  project_id TEXT,
  workstream_id TEXT,
  session_id TEXT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  observed_from TEXT,
  observed_to TEXT,
  derived_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  record_json TEXT NOT NULL
) STRICT;

CREATE INDEX memories_scope_idx ON memories(project_id, workstream_id, session_id);
CREATE INDEX memories_type_status_idx ON memories(type, status);

CREATE TABLE memory_evidence (
  memory_id TEXT NOT NULL REFERENCES memories(memory_id) ON DELETE CASCADE,
  evidence_kind TEXT NOT NULL CHECK (evidence_kind IN ('event', 'chunk')),
  evidence_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  PRIMARY KEY (memory_id, position),
  UNIQUE (memory_id, evidence_kind, evidence_id)
) WITHOUT ROWID, STRICT;

CREATE TABLE search_content (
  rowid INTEGER PRIMARY KEY,
  entity_kind TEXT NOT NULL CHECK (entity_kind IN ('chunk', 'memory')),
  entity_id TEXT NOT NULL,
  project_id TEXT,
  workstream_id TEXT,
  session_id TEXT,
  hit_type TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL,
  fingerprint TEXT,
  observed_at TEXT,
  UNIQUE (entity_kind, entity_id)
) STRICT;

CREATE INDEX search_content_scope_idx
  ON search_content(project_id, workstream_id, session_id, hit_type);

CREATE VIRTUAL TABLE search_fts USING fts5(
  title,
  body,
  content = 'search_content',
  content_rowid = 'rowid',
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER search_content_ai AFTER INSERT ON search_content BEGIN
  INSERT INTO search_fts(rowid, title, body)
  VALUES (new.rowid, new.title, new.body);
END;

CREATE TRIGGER search_content_ad AFTER DELETE ON search_content BEGIN
  INSERT INTO search_fts(search_fts, rowid, title, body)
  VALUES ('delete', old.rowid, old.title, old.body);
END;

CREATE TRIGGER search_content_au AFTER UPDATE ON search_content BEGIN
  INSERT INTO search_fts(search_fts, rowid, title, body)
  VALUES ('delete', old.rowid, old.title, old.body);
  INSERT INTO search_fts(rowid, title, body)
  VALUES (new.rowid, new.title, new.body);
END;

CREATE TABLE exact_terms (
  entity_kind TEXT NOT NULL CHECK (entity_kind IN ('chunk', 'memory')),
  entity_id TEXT NOT NULL,
  term_kind TEXT NOT NULL,
  term TEXT NOT NULL,
  normalized_term TEXT NOT NULL,
  PRIMARY KEY (entity_kind, entity_id, term_kind, normalized_term)
) WITHOUT ROWID, STRICT;

CREATE INDEX exact_terms_lookup_idx ON exact_terms(normalized_term, term_kind);

CREATE TABLE jobs (
  job_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  state TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  run_after TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE embedding_spaces (
  space_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  model_id TEXT NOT NULL,
  model_revision TEXT NOT NULL,
  dimension INTEGER NOT NULL CHECK (dimension > 0),
  distance_metric TEXT NOT NULL,
  normalization TEXT NOT NULL,
  tokenizer_version TEXT NOT NULL,
  preprocessing_version TEXT NOT NULL,
  redaction_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('building', 'active', 'retiring', 'retired', 'failed')),
  created_at TEXT NOT NULL,
  record_json TEXT NOT NULL
) STRICT;

CREATE UNIQUE INDEX embedding_spaces_one_active_idx
  ON embedding_spaces(status)
  WHERE status = 'active';

CREATE TABLE embedding_desires (
  entity_kind TEXT NOT NULL CHECK (entity_kind IN ('chunk', 'memory')),
  entity_id TEXT NOT NULL,
  space_id TEXT NOT NULL REFERENCES embedding_spaces(space_id) ON DELETE CASCADE,
  desired_fingerprint TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('upsert', 'delete')),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (entity_kind, entity_id, space_id)
) WITHOUT ROWID, STRICT;

CREATE TABLE embedding_jobs (
  job_id TEXT PRIMARY KEY,
  entity_kind TEXT NOT NULL CHECK (entity_kind IN ('chunk', 'memory')),
  entity_id TEXT NOT NULL,
  memory_type TEXT,
  space_id TEXT NOT NULL REFERENCES embedding_spaces(space_id) ON DELETE CASCADE,
  desired_fingerprint TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('upsert', 'delete')),
  state TEXT NOT NULL CHECK (state IN ('pending', 'processing', 'retry', 'ready', 'failed', 'cancelled')),
  attempts INTEGER NOT NULL CHECK (attempts >= 0),
  retry_at TEXT,
  error_code TEXT,
  lease_owner TEXT,
  lease_expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  record_json TEXT NOT NULL,
  UNIQUE (entity_kind, entity_id, space_id, desired_fingerprint, operation)
) STRICT;

CREATE INDEX embedding_jobs_claim_idx
  ON embedding_jobs(state, retry_at, created_at);
CREATE INDEX embedding_jobs_lease_idx
  ON embedding_jobs(state, lease_expires_at);

CREATE TABLE embedding_records (
  entity_kind TEXT NOT NULL CHECK (entity_kind IN ('chunk', 'memory')),
  entity_id TEXT NOT NULL,
  memory_type TEXT,
  space_id TEXT NOT NULL REFERENCES embedding_spaces(space_id) ON DELETE CASCADE,
  fingerprint TEXT NOT NULL,
  vector_id TEXT NOT NULL UNIQUE,
  indexed_at TEXT NOT NULL,
  PRIMARY KEY (entity_kind, entity_id, space_id)
) WITHOUT ROWID, STRICT;

CREATE INDEX embedding_records_space_idx ON embedding_records(space_id, indexed_at);

