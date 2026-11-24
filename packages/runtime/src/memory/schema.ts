/**
 * The memory store's schema, byte for byte the SQL fence in docs/memory.md
 * (MemoryStore.test.ts checks they match). Only additive changes, with named
 * columns everywhere (docs/memory.md "Maintaining it").
 *
 * @module memory/schema
 */
export const MEMORY_SCHEMA = `-- Every version of every note. Only the runtime's commit path writes here.
CREATE TABLE memory_version (
  vid       TEXT PRIMARY KEY, -- lowercase ULID; a note's next version always sorts after its head
  store     TEXT NOT NULL,    -- 'me' or 'team:<drive>'
  id        TEXT NOT NULL,    -- the note; all its versions share it
  path      TEXT NOT NULL CHECK (
              length(path) <= 200 AND path GLOB '*.md' AND path NOT GLOB '*..*'
              AND path NOT GLOB '*[^a-z0-9._/-]*'
              AND (store <> 'me' OR path GLOB 'user/*' OR path GLOB 'repos/*')),
  text      TEXT NOT NULL CHECK (
              length(text) <= 500 AND instr(text, char(10)) = 0 AND instr(text, char(13)) = 0), -- '' = forgotten
  added     TEXT NOT NULL CHECK (date(added) IS added),
  until     TEXT CHECK (until IS NULL OR date(until) IS until),
  source    TEXT NOT NULL CHECK (length(source) <= 300), -- the writer's claim: session, url, 'user', import
  meta      TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(meta) AND length(meta) <= 2000),
  authority TEXT NOT NULL CHECK (authority IN ('told', 'team', 'learned', 'draft')),
  tainted   INTEGER NOT NULL CHECK (tainted IN (0, 1)),
  by        TEXT NOT NULL,    -- who wrote this version: 'session:<id>', 'dream:<id>', 'user', 'drive:<name>@<commit>'
  at        TEXT NOT NULL,
  mac       TEXT              -- HMAC over the row with the account's memory key (verified on every computer)
);
CREATE INDEX memory_version_note ON memory_version(store, id, vid);

-- Erased notes. Synced, so a computer that missed the erase can't bring them back.
-- Erase also deletes every memory_version row of the note.
CREATE TABLE purged (store TEXT NOT NULL, id TEXT NOT NULL, at TEXT NOT NULL, mac TEXT, PRIMARY KEY (store, id));
CREATE TRIGGER memory_version_purged BEFORE INSERT ON memory_version
WHEN EXISTS (SELECT 1 FROM purged WHERE store = NEW.store AND id = NEW.id) BEGIN
  SELECT RAISE(IGNORE);
END;

-- Current version per note: the newest vid. Older versions arriving late from sync never win.
CREATE TABLE memory_head (store TEXT NOT NULL, id TEXT NOT NULL, vid TEXT NOT NULL, PRIMARY KEY (store, id));
CREATE TRIGGER memory_version_head AFTER INSERT ON memory_version
WHEN NEW.vid > coalesce((SELECT vid FROM memory_head WHERE store = NEW.store AND id = NEW.id), '') BEGIN
  INSERT INTO memory_head(store, id, vid) VALUES (NEW.store, NEW.id, NEW.vid)
  ON CONFLICT(store, id) DO UPDATE SET vid = excluded.vid;
END;

-- When a note reached a session, and how. 'query' counts only small results.
CREATE TABLE memory_use (
  store TEXT NOT NULL, id TEXT NOT NULL, session TEXT NOT NULL, at TEXT NOT NULL,
  how TEXT NOT NULL CHECK (how IN ('push', 'recall', 'query', 'acted'))
);
CREATE INDEX memory_use_note ON memory_use(store, id, at);

-- Retired 2026-10-17 with dreaming: nothing writes it, and the brief no longer counts sightings.
-- Kept so older runtimes still open this file; erasing a note still clears its rows.
CREATE TABLE memory_sighting (
  store TEXT NOT NULL, id TEXT NOT NULL, session TEXT NOT NULL, repo TEXT, at TEXT NOT NULL,
  how TEXT NOT NULL CHECK (how IN ('user', 'tool')),
  mac TEXT,                  -- sealed like versions; synced with them
  PRIMARY KEY (store, id, session)
);

-- Suggested changes to team memory. A person accepts them in a drive PR.
CREATE TABLE proposal (
  pid    TEXT PRIMARY KEY,
  store  TEXT NOT NULL CHECK (store GLOB 'team:*'),
  target TEXT,               -- the team note it changes; NULL for a new note
  path   TEXT NOT NULL CHECK (length(path) <= 200 AND path GLOB '*.md' AND path NOT GLOB '*..*'
                              AND path NOT GLOB '*[^a-z0-9._/-]*'),
  text   TEXT NOT NULL CHECK (length(text) <= 500 AND instr(text, char(10)) = 0 AND instr(text, char(13)) = 0),
  why    TEXT CHECK (length(why) <= 300 AND instr(why, char(10)) = 0),
  by     TEXT NOT NULL,
  at     TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'sent', 'merged', 'rejected'))
);

-- Dreams, retired 2026-10-17: nothing writes dream or dream_version.
-- Kept so older runtimes still open this file; erasing a note still clears its dream_version rows.
CREATE TABLE dream (
  id          TEXT PRIMARY KEY,
  phase       TEXT NOT NULL CHECK (phase IN ('session', 'daily')),
  inbox       TEXT NOT NULL CHECK (json_valid(inbox)), -- session ids it read
  prompt      TEXT NOT NULL,                           -- prompt version
  started     TEXT NOT NULL,
  lease_until TEXT NOT NULL,
  finished    TEXT,
  summary     TEXT,
  status      TEXT NOT NULL CHECK (status IN ('running', 'done', 'held', 'undone', 'failed'))
);
CREATE TABLE dream_version (
  dream TEXT NOT NULL REFERENCES dream(id),
  vid TEXT NOT NULL, store TEXT NOT NULL, id TEXT NOT NULL, path TEXT NOT NULL, text TEXT NOT NULL,
  added TEXT NOT NULL, until TEXT, source TEXT NOT NULL, meta TEXT NOT NULL, authority TEXT NOT NULL,
  tainted INTEGER NOT NULL, by TEXT NOT NULL, at TEXT NOT NULL,
  base_vid TEXT,             -- the head the dream read; promotion skips the note if the head has moved
  mac TEXT,
  PRIMARY KEY (dream, vid)
);
`;

/**
 * Runtime-only tables, never synced: the brief each session froze at its start
 * (docs/memory.md "The brief": resume and fork reuse its bytes) with the notes
 * its index lists, and the sessions that read outside content, so taint
 * outlives a restart.
 */
export const RUNTIME_SCHEMA = `CREATE TABLE IF NOT EXISTS session_brief (session TEXT PRIMARY KEY, text TEXT NOT NULL, idx TEXT NOT NULL, at TEXT NOT NULL, notes TEXT);
CREATE TABLE IF NOT EXISTS session_taint (session TEXT PRIMARY KEY, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);`;
