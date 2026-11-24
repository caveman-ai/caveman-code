// The memory SQL sandbox (docs/memory.md "The SQL copy"): a child process the
// runtime can SIGKILL, holding only per-session in-memory copies of what each
// session may see. It never opens the store file and never holds the account
// key. Every statement runs under an authorizer, in a transaction that is
// always rolled back: the parent commits validated changes itself.
// Plain JS beside the runtime (copied next to the bundle by scripts/bundle.ts).
// Needs node:sqlite's setAuthorizer (Node >= 24.15).
import { DatabaseSync, constants as C } from "node:sqlite";
import { Worker } from "node:worker_threads";

const COPY_COLUMNS = ["id", "path", "text", "authority", "added", "until", "source", "meta"];
const NAMES = ["memories", "memory_history", "unverified", "proposals"];
const FOOTER = "Output capped; page with LIMIT and OFFSET.";
const canonical = (value) =>
  JSON.stringify(value, (_key, v) => (v && !Array.isArray(v) && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v));
const fail = (reason) => {
  throw new Error(reason);
};

/** What a statement may grow this process by; once statements have grown it by as much in all, it is replaced. */
const MEMORY_LIMIT = 64 * 1024 * 1024;
/** What the process writes to stderr as it kills itself over the limit (MemorySandbox.ts OVER_LIMIT). */
const OVER_LIMIT = "memory sandbox: over its memory limit";
// node:sqlite's SQLite keeps no heap statistics (SQLITE_DEFAULT_MEMSTATUS=0), so `PRAGMA hard_heap_limit` is never
// enforced, and no JS runs inside sqlite3_step to stop it. A thread beside it watches the process instead: while a
// statement runs, `ceiling` holds the most resident memory it may reach (KiB); past it, the thread kills the process.
// It says so first: the parent sees no signal on Windows, and the same SIGKILL from an out-of-memory killer.
const ceiling = new Int32Array(new SharedArrayBuffer(4));
new Worker(
  `const { workerData: ceiling } = require("node:worker_threads");
  const { writeSync } = require("node:fs");
  for (;;) {
    Atomics.wait(ceiling, 0, 0);
    const kib = Atomics.load(ceiling, 0);
    if (kib !== 0 && process.memoryUsage.rss() / 1024 > kib && Atomics.load(ceiling, 0) === kib) {
      writeSync(2, ${JSON.stringify(`${OVER_LIMIT}\n`)});
      process.kill(process.pid, "SIGKILL");
    }
    Atomics.wait(ceiling, 0, kib, 5);
  }`,
  { eval: true, workerData: ceiling },
).unref();
const watch = (kib) => {
  Atomics.store(ceiling, 0, kib);
  Atomics.notify(ceiling, 0);
};
/** What statements have grown this process by: memory SQLite frees stays resident, for the next statement to reuse. */
let grown = 0;

/** Lex strings and comments together: a comment holding quotes cannot name ids. */
function namedIds(sql, params) {
  const names = new Set(params.filter((p) => typeof p === "string"));
  for (const match of sql.matchAll(/--[^\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|`[^`]*`|\[[^\]]*\]/g))
    if (match[0].startsWith("'")) names.add(match[0].slice(1, -1).replaceAll("''", "'"));
  return names;
}

const sessions = new Map();
const formatter = new DatabaseSync(":memory:", { limits: { length: 65536 } });

function rebuild(message) {
  sessions.get(message.session)?.db.close();
  const copy = new DatabaseSync(":memory:", { limits: { length: 65536 } });
  copy.exec("PRAGMA temp_store=MEMORY");
  // Older SQLite returns NULL for an oversized printf; fail the same way everywhere.
  for (const name of ["printf", "format"])
    copy.function(name, { varargs: true }, (...args) => {
      const result = formatter.prepare(`SELECT printf(${args.map(() => "?").join(",")}) value`).get(...args).value;
      if (result === null && args[0] != null) fail("formatted value too large or invalid");
      return result;
    });
  for (const table of NAMES) {
    const fields = table === "proposals" ? ["pid", "store", "target", "path", "text", "why"] : [...COPY_COLUMNS, ...(table === "memory_history" ? ["at", "by"] : [])];
    copy.exec(
      `CREATE TABLE ${table} (${fields
        .map((k) => `${k} TEXT${(k === "id" && table === "memories") || k === "pid" ? " NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(5))))" : ""}`)
        .join(",")})`,
    );
    const stmt = copy.prepare(`INSERT INTO ${table} (${fields.join(",")}) VALUES (${fields.map(() => "?").join(",")})`);
    for (const row of message.tables[table]) stmt.run(...fields.map((k) => row[k] ?? null));
  }
  const state = { db: copy, revision: message.revision };
  sessions.set(message.session, state);
  return state;
}

const stateRows = (copy) => Object.fromEntries(["memories", "proposals"].map((t) => [t, copy.prepare(`SELECT * FROM ${t}`).all()]));

process.on("message", (message) => {
  if (message.forget) {
    sessions.get(message.forget)?.db.close();
    sessions.delete(message.forget);
    return;
  }
  let tainted = false;
  let state;
  let inTransaction = false;
  try {
    state = sessions.get(message.session);
    if (!state || state.revision !== message.revision) state = rebuild(message);
    const copy = state.db;
    const before = stateRows(copy);
    copy.exec("BEGIN");
    inTransaction = true;
    copy.setAuthorizer((action, a, b, database) => {
      if (action === C.SQLITE_READ && a === "unverified") {
        tainted = true;
        process.send({ tainted: message.session });
      }
      if ([C.SQLITE_SELECT, C.SQLITE_FUNCTION, C.SQLITE_RECURSIVE].includes(action)) return C.SQLITE_OK;
      if (action === C.SQLITE_READ && (NAMES.includes(a) || (database === null && b === ""))) return C.SQLITE_OK;
      if (action === C.SQLITE_PRAGMA && a === "data_version" && b === null) return C.SQLITE_OK;
      if (
        message.writable &&
        ((a === "memories" && [C.SQLITE_INSERT, C.SQLITE_UPDATE, C.SQLITE_DELETE].includes(action)) || (a === "proposals" && action === C.SQLITE_INSERT))
      )
        return C.SQLITE_OK;
      return C.SQLITE_DENY;
    });
    const rows = [];
    let capped = false;
    const cap = message.codeMode ? 1048576 : 16384;
    const start = process.memoryUsage.rss();
    try {
      watch(Math.ceil((start + MEMORY_LIMIT) / 1024));
      const stmt = copy.prepare(message.sql);
      const trim = (s) => s.trim().replace(/;$/, "").trim();
      if (trim(stmt.sourceSQL) !== trim(message.sql)) fail("one statement only");
      process.send({ started: message.session });
      for (const row of stmt.iterate(...message.params)) {
        const item = Object.fromEntries(
          Object.entries(row).map(([k, v]) => [k, v instanceof Uint8Array ? Buffer.from(v).toString("hex").slice(0, 300) : typeof v === "string" ? v.slice(0, 300) : v]),
        );
        if (rows.length === 100 || Buffer.byteLength(JSON.stringify({ rows: [...rows, item], footer: FOOTER })) > cap) {
          capped = true;
          continue;
        }
        rows.push(item);
      }
    } finally {
      watch(0);
      grown += Math.max(0, process.memoryUsage.rss() - start);
      copy.setAuthorizer(null);
    }
    const after = stateRows(copy);
    const changes = [];
    for (const table of ["memories", "proposals"]) {
      const field = table === "memories" ? "id" : "pid";
      const a = new Map(before[table].map((r) => [r[field], r]));
      const b = new Map(after[table].map((r) => [r[field], r]));
      for (const key of new Set([...a.keys(), ...b.keys()]))
        if (canonical(a.get(key)) !== canonical(b.get(key))) changes.push({ table, before: a.get(key), after: b.get(key) });
    }
    const named = namedIds(message.sql, message.params);
    if (changes.length > 3 && changes.some((c) => !named.has((c.after ?? c.before)[c.table === "memories" ? "id" : "pid"])))
      fail("more than 3 notes requires naming every changed id");
    // Always discard the copy's mutations. Only the parent's validated commits survive.
    copy.exec("ROLLBACK");
    inTransaction = false;
    process.send({ rows, changes, tainted, footer: capped ? FOOTER : "", retire: grown > MEMORY_LIMIT });
  } catch (error) {
    if (state) {
      state.db.setAuthorizer(null);
      if (inTransaction) state.db.exec("ROLLBACK");
    }
    process.send({ error: error.message, tainted, retire: grown > MEMORY_LIMIT });
  }
});

process.on("disconnect", () => {
  for (const state of sessions.values()) state.db.close();
  formatter.close();
  process.exit(0);
});
