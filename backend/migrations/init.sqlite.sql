CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(6)))),
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  full_name     TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'analyst' CHECK (role IN ('admin','analyst','viewer')),
  avatar_url    TEXT,
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id         TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(6)))),
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id);

CREATE TABLE IF NOT EXISTS projects (
  id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(6)))),
  name        TEXT NOT NULL,
  description TEXT,
  owner_id    TEXT NOT NULL REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS scans (
  id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(6)))),
  project_id      TEXT REFERENCES projects(id) ON DELETE SET NULL,
  created_by      TEXT NOT NULL REFERENCES users(id),
  name            TEXT,
  urls            TEXT NOT NULL,
  navigated_urls  TEXT,
  state_label     TEXT NOT NULL DEFAULT 'default',
  scan_options    TEXT NOT NULL DEFAULT '{}',
  auth_config     TEXT,
  status          TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','completed','failed','cancelled')),
  progress        INTEGER NOT NULL DEFAULT 0 CHECK (progress >= 0 AND progress <= 100),
  started_at      TEXT,
  completed_at    TEXT,
  error_message   TEXT,
  total_issues    INTEGER NOT NULL DEFAULT 0,
  critical_count  INTEGER NOT NULL DEFAULT 0,
  serious_count   INTEGER NOT NULL DEFAULT 0,
  moderate_count  INTEGER NOT NULL DEFAULT 0,
  minor_count     INTEGER NOT NULL DEFAULT 0,
  score           REAL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_scans_project ON scans(project_id);
CREATE INDEX IF NOT EXISTS idx_scans_created_by ON scans(created_by);
CREATE INDEX IF NOT EXISTS idx_scans_status ON scans(status);
CREATE INDEX IF NOT EXISTS idx_scans_created_at ON scans(created_at DESC);

CREATE TABLE IF NOT EXISTS issues (
  id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(6)))),
  scan_id         TEXT NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  rule_id         TEXT NOT NULL,
  severity        TEXT NOT NULL CHECK (severity IN ('critical','serious','moderate','minor')),
  priority        INTEGER NOT NULL DEFAULT 3 CHECK (priority BETWEEN 1 AND 5),
  category        TEXT,
  message         TEXT NOT NULL,
  url             TEXT NOT NULL,
  selector        TEXT,
  selectors       TEXT,
  affected_elements TEXT,
  depths          TEXT,
  wcag_criteria   TEXT,
  act_rules       TEXT,
  tags            TEXT,
  help_url        TEXT,
  html_snippet    TEXT,
  fix_suggestion  TEXT,
  evidence_screenshot TEXT,
  evidence_explanation TEXT,
  ai_explanation  TEXT,
  ai_impact       TEXT,
  ai_fix_code     TEXT,
  component_id    TEXT,
  component_owner TEXT,
  source_hint     TEXT,
  state_label     TEXT,
  phase           TEXT,
  is_resolved     INTEGER NOT NULL DEFAULT 0,
  false_positive  INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_issues_scan ON issues(scan_id);
CREATE INDEX IF NOT EXISTS idx_issues_severity ON issues(severity);
CREATE INDEX IF NOT EXISTS idx_issues_rule ON issues(rule_id);
CREATE INDEX IF NOT EXISTS idx_issues_url ON issues(url);

CREATE TABLE IF NOT EXISTS test_cases (
  id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(6)))),
  scan_id     TEXT NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  issue_id    TEXT REFERENCES issues(id) ON DELETE SET NULL,
  name        TEXT NOT NULL,
  description TEXT,
  category    TEXT,
  wcag_ref    TEXT,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pass','fail','pending','skipped','manual')),
  steps       TEXT,
  result      TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_test_cases_scan ON test_cases(scan_id);

CREATE TABLE IF NOT EXISTS dom_snapshots (
  id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(6)))),
  scan_id     TEXT NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  url         TEXT NOT NULL,
  phase       TEXT,
  html        TEXT,
  a11y_tree   TEXT,
  screenshot  TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_dom_snapshots_scan ON dom_snapshots(scan_id);

CREATE TABLE IF NOT EXISTS audit_events (
  id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(6)))),
  actor_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
  action      TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id   TEXT,
  entity_name TEXT,
  metadata    TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_audit_events_actor ON audit_events(actor_id);
CREATE INDEX IF NOT EXISTS idx_audit_events_created_at ON audit_events(created_at DESC);

CREATE TABLE IF NOT EXISTS wcag_metadata (
  criterion   TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  level       TEXT,
  principle   TEXT,
  url         TEXT,
  source      TEXT,
  fetched_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS wcag_mapping_reviews (
  id             TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(6)))),
  rule_id        TEXT NOT NULL,
  current_wcag   TEXT NOT NULL,
  suggested_wcag TEXT,
  reason         TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','dismissed','resolved')),
  first_seen_at  TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at   TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at    TEXT,
  UNIQUE(rule_id, current_wcag, reason)
);

CREATE INDEX IF NOT EXISTS idx_wcag_mapping_reviews_status ON wcag_mapping_reviews(status);
CREATE INDEX IF NOT EXISTS idx_wcag_mapping_reviews_last_seen ON wcag_mapping_reviews(last_seen_at DESC);

CREATE TABLE IF NOT EXISTS wcag_rule_registry (
  rule_id             TEXT PRIMARY KEY,
  rule_name           TEXT NOT NULL,
  category            TEXT,
  default_wcag        TEXT NOT NULL DEFAULT '[]',
  approved_wcag       TEXT NOT NULL DEFAULT '[]',
  mapping_status      TEXT NOT NULL DEFAULT 'review_required' CHECK (mapping_status IN ('approved','review_required','rejected','obsolete','advisory')),
  review_status       TEXT NOT NULL DEFAULT 'pending' CHECK (review_status IN ('pending','approved','rejected','resolved')),
  source_module       TEXT,
  rationale           TEXT,
  last_reviewed_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  last_reviewed_at    TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS wcag_mapping_decisions (
  id               TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(6)))),
  rule_id          TEXT NOT NULL REFERENCES wcag_rule_registry(rule_id) ON DELETE CASCADE,
  previous_wcag    TEXT,
  decided_wcag     TEXT NOT NULL DEFAULT '[]',
  decision         TEXT NOT NULL CHECK (decision IN ('accepted','dismissed','resolved','registered','auto_review_required')),
  reason           TEXT,
  decided_by       TEXT REFERENCES users(id) ON DELETE SET NULL,
  decided_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_wcag_rule_registry_status ON wcag_rule_registry(mapping_status, review_status);
CREATE INDEX IF NOT EXISTS idx_wcag_rule_registry_updated ON wcag_rule_registry(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_wcag_mapping_decisions_rule ON wcag_mapping_decisions(rule_id);
CREATE INDEX IF NOT EXISTS idx_wcag_mapping_decisions_date ON wcag_mapping_decisions(decided_at DESC);
