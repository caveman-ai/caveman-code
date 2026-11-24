// Test-only: the person's device log as Caveman Cloud keeps it (device_statements.go): POST and GET
// /api/v1/code/runtime/devices/statements for a laptop runtime acting for its enroller, statements bound to the
// token's organization and person, stored once by id and numbered. And Cloud as a malicious carrier, for the threats
// it must not be able to win (docs/): rows it makes up or replays (`inject`),
// rows it serves to some runtimes only (`withhold`), in another order (`reorder`), or takes and never keeps (`drop`);
// a Cloud that refuses a statement for good (`refuse`: a full log, or a check Cloud and the Mac disagree on); one
// without the log at all (`absent`: an older Cloud); and one that ignores the wait and carries the whole log again at
// once, numbered as before (`replay`); and a read Cloud answers late (`stall`: the answer it took when the read came,
// delivered only on `release`, as a Mac that slept with a read out gets it after it wakes).
import { statementId, verifyStatement } from "@caveman-app/session-protocol";

export interface TestDeviceRow {
  readonly seq: number;
  readonly id: string;
  readonly person: string;
  readonly statement: unknown;
  readonly from_runtime_id: string;
}

export interface DeviceLogState {
  readonly rows: Array<TestDeviceRow>;
  seq: number;
  /** Every put, as Cloud saw it (one entry per statement). */
  readonly puts: Array<{ runtime_id: string; id: string; dropped: boolean }>;
  /** Every read, by runtime (`held`: one that never answers, hold). */
  readonly reads: Array<{ runtime_id: string; after: number; wait_ms: number; held?: boolean; stalled?: boolean; absent?: true }>;
  /** A row Cloud serves to `runtimeId` or not (T5: a removal kept from one Mac). */
  withhold: ((row: TestDeviceRow, runtimeId: string) => boolean) | undefined;
  /** Rows served newest first (T4: reordering). */
  reorder: boolean;
  /** A statement Cloud says it took and never keeps (T6: approvals dropped). */
  drop: ((statement: unknown) => boolean) | undefined;
  /** A statement Cloud refuses, with what it answers (the whole put, as Cloud refuses it). */
  refuse: ((statement: unknown) => { readonly status: number; readonly code: string; readonly message: string } | undefined) | undefined;
  /** Reads by `runtimeId` started now never answer (a Mac asleep mid-read: its request hangs until it gives up). */
  hold: ((runtimeId: string) => boolean) | undefined;
  /**
   * Reads by `runtimeId` started now take their answer at once (what the log holds then, no wait) and deliver it only
   * at the next `release` (a read that went out before a sleep, answered while the Mac slept, read after it woke).
   */
  stall: ((runtimeId: string) => boolean) | undefined;
  /** Delivers every stalled read's answer, as Cloud took it. */
  release(): void;
  /** Bumped by `release`. */
  releases: number;
  /** Both routes answer this status (404: a Cloud without the device log); the read is still recorded, `absent`. */
  absent: number | undefined;
  /** Every read answers at once, whatever its wait, with the person's whole log and its last number (a page again). */
  replay: boolean;
  /** Cloud makes up a row for `person`, or replays one: anything at all, under any id. */
  inject(person: string, statement: unknown, id?: string): void;
}

export const deviceLogState = (): DeviceLogState => {
  const st: DeviceLogState = {
    rows: [],
    seq: 0,
    puts: [],
    reads: [],
    withhold: undefined,
    reorder: false,
    drop: undefined,
    refuse: undefined,
    hold: undefined,
    stall: undefined,
    releases: 0,
    release: () => void st.releases++,
    absent: undefined,
    replay: false,
    inject: (person, statement, id = `injected-${st.seq + 1}`) => void st.rows.push({ seq: ++st.seq, id, person, statement, from_runtime_id: "cloud" }),
  };
  return st;
};

/** One request on the log's routes, when it is one: answered, or false. */
export async function deviceLogRoutes(
  st: DeviceLogState,
  input: {
    readonly method: string;
    readonly url: URL;
    readonly body: Record<string, unknown>;
    /** The calling runtime, when its token holds. */
    readonly runtimeId: string | undefined;
    /** Its enroller, and whether its computer is a Mac's. */
    readonly person: string | undefined;
    readonly laptop: boolean;
    readonly organizationId: string;
    readonly closed: () => boolean;
  },
  reply: (status: number, body: unknown) => void,
): Promise<boolean> {
  if (input.url.pathname !== "/api/v1/code/runtime/devices/statements") return false;
  const refuse = (status: number, code: string, message = code) => (reply(status, { error: { code, message } }), true);
  if (input.runtimeId === undefined) return refuse(401, "cave_unauthorized");
  // AsEnroller: a Cloud computer's runtime acts for no one.
  if (!input.laptop || input.person === undefined) return refuse(403, "cave_forbidden", "This runtime acts for no member who may run Caveman Code.");
  const person = input.person;
  const runtimeId = input.runtimeId;
  if (st.absent !== undefined) {
    if (input.method === "GET") st.reads.push({ runtime_id: runtimeId, after: Number(input.url.searchParams.get("after") ?? 0), wait_ms: 0, absent: true });
    return refuse(st.absent, "cave_not_found", "Not found.");
  }
  if (input.method === "POST") {
    const statements = input.body.statements;
    if (!Array.isArray(statements) || statements.length === 0 || statements.length > 16) return refuse(400, "cave_bad_request", "statements holds 1 to 16 statements.");
    const out: Array<{ id: string; seq: number }> = [];
    // All of a put or none of it, as Cloud's transaction.
    for (const raw of statements) {
      const s = await verifyStatement(raw);
      if (!s) return refuse(400, "cave_bad_request", "A statement is not well formed or not signed.");
      if (s.organization_id !== input.organizationId || s.user_id !== person) return refuse(403, "cave_forbidden", "A statement names another person or organization.");
      const no = st.refuse?.(raw);
      if (no) return refuse(no.status, no.code, no.message);
    }
    for (const raw of statements) {
      const id = await statementId((await verifyStatement(raw))!);
      const dropped = st.drop?.(raw) === true;
      st.puts.push({ runtime_id: runtimeId, id, dropped });
      const known = st.rows.find((r) => r.id === id);
      if (known) out.push({ id, seq: known.seq });
      else if (dropped) out.push({ id, seq: st.seq });
      else {
        const row = { seq: ++st.seq, id, person, statement: raw, from_runtime_id: runtimeId };
        st.rows.push(row);
        out.push({ id, seq: row.seq });
      }
    }
    reply(200, { statements: out });
    return true;
  }
  if (input.method !== "GET") return refuse(405, "cave_method_not_allowed");
  const after = Number(input.url.searchParams.get("after") ?? 0);
  const wait = Math.min(Number(input.url.searchParams.get("wait_ms") ?? 0), 25_000);
  if (!Number.isInteger(after) || after < 0 || !Number.isFinite(wait) || wait < 0) return refuse(400, "cave_bad_request");
  if (st.hold?.(runtimeId)) {
    st.reads.push({ runtime_id: runtimeId, after, wait_ms: wait, held: true });
    while (!input.closed()) await new Promise((resolve) => setTimeout(resolve, 20));
    return true;
  }
  const mine = () => st.rows.filter((r) => r.person === person && r.seq > after);
  const page = () => mine().filter((r) => !st.withhold?.(r, runtimeId));
  const answer = () => {
    // A withheld row still moves the number on: that Mac never asks for it again.
    const all = mine();
    const rows = page();
    return { statements: (st.reorder ? [...rows].reverse() : rows).map((r) => ({ id: r.id, seq: r.seq, statement: r.statement })), seq: all.length > 0 ? Math.max(...all.map((r) => r.seq)) : after };
  };
  if (st.stall?.(runtimeId)) {
    st.reads.push({ runtime_id: runtimeId, after, wait_ms: wait, stalled: true });
    const taken = answer();
    const generation = st.releases;
    while (st.releases === generation && !input.closed()) await new Promise((resolve) => setTimeout(resolve, 20));
    if (!input.closed()) reply(200, taken);
    return true;
  }
  st.reads.push({ runtime_id: runtimeId, after, wait_ms: wait });
  if (st.replay) {
    const rows = st.rows.filter((r) => r.person === person);
    reply(200, { statements: rows.map((r) => ({ id: r.id, seq: r.seq, statement: r.statement })), seq: rows.length > 0 ? Math.max(...rows.map((r) => r.seq)) : 0 });
    return true;
  }
  const deadline = Date.now() + wait;
  while (page().length === 0 && Date.now() < deadline && !input.closed()) await new Promise((resolve) => setTimeout(resolve, 20));
  reply(200, answer());
  return true;
}
