// The Session Protocol's chief.* methods on the Chiefs (chief/Chief.ts). Capture never waits on
// a model: the note is on the board when the call returns; its Chief hears it after.
import type { Result } from "@caveman-app/session-protocol";
import * as Effect from "effect/Effect";

import { type Handler, ProtocolError } from "../session-protocol/handlers.ts";
import * as Board from "./Board.ts";
import { type Chief, ChiefError } from "./Chief.ts";
import { inProjects, toWireProfile } from "./profiles.ts";
import { VoiceRefused, type Voice } from "./voice/Call.ts";

type ChiefMethod =
  | "chief.get"
  | "chief.list"
  | "chief.create"
  | "chief.update"
  | "chief.remove"
  | "chief.capture"
  | "chief.attach"
  | "chief.manage"
  | "chief.items.list"
  | "chief.items.update"
  | "chief.items.remove"
  | "chief.items.reorder"
  | "chief.change_sets.list"
  | "chief.start"
  | "chief.voice.start"
  | "chief.voice.signal"
  | "chief.voice.update"
  | "chief.voice.end"
  | "chief.voice.key"
  | "chief.view.get"
  | "chief.view.dismiss";

const refused = (error: unknown) =>
  error instanceof ProtocolError
    ? error
    : new ProtocolError({
        reason: error instanceof ChiefError && error.reason !== undefined ? error.reason : /^No item/.test((error as Error).message) ? "not_found" : "invalid_state",
        message: (error as Error).message,
      });

export const makeChiefHandlers = (
  chief: Chief,
  /** Whether that Chief has something to run on now. */
  canThink: (chiefId: string | undefined) => Effect.Effect<boolean>,
  /** What a Chief's model picker offers (chief.get); its pick is its profile's. */
  picker: Effect.Effect<Pick<Result<"chief.get">, "picker">>,
  /** The runtime's owner (local, or their own Cloud account through the relay): the Chief is theirs alone. */
  allowed: (principal: string | undefined) => boolean,
  /** Calls (voice/Call.ts); absent, chief.voice.* answer unsupported. */
  voice?: Voice,
): { readonly [M in ChiefMethod]: Handler<M> } => {
  const now = () => new Date().toISOString();
  const wire = (items: ReadonlyArray<Board.Item>) => items.map(Board.toWire);
  const item = (id: string) => chief.board.get(id).pipe(Effect.flatMap((found) => (found ? Effect.succeed(found) : Effect.fail(new ProtocolError({ reason: "not_found", message: `No item ${id}` })))));
  /** An item whose Chief is still there: a removed Chief's items are never edited or started again (nothing would hear them). */
  const liveItem = (id: string) =>
    item(id).pipe(
      Effect.flatMap((found) =>
        (found.chief_id === undefined ? Effect.succeed(undefined) : chief.byId(found.chief_id)).pipe(
          Effect.flatMap((owner) =>
            owner !== undefined ? Effect.succeed(found) : Effect.fail(new ProtocolError({ reason: "invalid_state", message: `${id}'s Chief was removed: its items can't be changed or started` })),
          ),
        ),
      ),
    );
  /** A call method on the voice, its refusals as protocol errors. */
  const calls = <A, R>(run: (voice: Voice) => Effect.Effect<A, unknown, R>) =>
    voice === undefined
      ? Effect.fail(new ProtocolError({ reason: "unsupported", message: "calls are off on this runtime" }))
      : run(voice).pipe(
          Effect.mapError((error) =>
            error instanceof VoiceRefused ? new ProtocolError({ reason: error.reason, message: error.message }) : error instanceof ProtocolError ? error : new ProtocolError({ reason: "internal", message: error instanceof Error ? error.message : String(error) }),
          ),
        );
  const handlers: { readonly [M in ChiefMethod]: Handler<M> } = {
    "chief.get": (p) =>
      Effect.gen(function* () {
        // `chief_id`'s; else one that works in `project_id`; else the one with the latest activity (the first made if none).
        const me = yield* chief.resolve({ chiefId: p.chief_id, projectId: p.project_id });
        // Opening a Chief is when a key added since shows: notes that waited for one go now.
        yield* chief.catchUp;
        return {
          workspace: me.record.workspace,
          chief: toWireProfile(me.profile),
          availability: (yield* canThink(me.profile.id)) ? ("ready" as const) : ("no_key" as const),
          board: yield* chief.board.board,
          ...(yield* picker),
          model: me.profile.model,
          ...(voice === undefined ? {} : { voice: yield* voice.status }),
        };
      }).pipe(Effect.mapError(refused)),
    "chief.list": () => chief.list.pipe(Effect.map((chiefs) => ({ chiefs: [...chiefs] })), Effect.mapError(refused)),
    "chief.create": (p) =>
      chief
        .create({
          // An older client's one project reads as a list of it.
          projectIds: p.project_ids ?? (p.project_id === undefined ? undefined : [p.project_id]),
          name: p.name,
          avatar: p.avatar,
          role: p.role,
          soul: p.soul,
        })
        .pipe(
          Effect.map((profile) => ({ chief: profile })),
          Effect.mapError(refused),
        ),
    "chief.update": (p) =>
      chief
        .update(p.chief_id, {
          ...(p.name === undefined ? {} : { name: p.name }),
          ...(p.avatar === undefined ? {} : { avatar: p.avatar }),
          ...(p.model === undefined ? {} : { model: p.model }),
          ...(p.access === undefined ? {} : { access: p.access }),
          ...(p.project_ids === undefined ? {} : { project_ids: p.project_ids }),
          ...(p.role === undefined ? {} : { role: p.role }),
          ...(p.soul === undefined ? {} : { soul: p.soul }),
          ...(p.autonomy === undefined ? {} : { autonomy: p.autonomy }),
          ...(p.updates === undefined ? {} : { updates: p.updates }),
        })
        .pipe(
          Effect.map((profile) => ({ chief: profile })),
          Effect.mapError(refused),
        ),
    "chief.remove": (p) => chief.remove(p.chief_id).pipe(Effect.as({}), Effect.mapError(refused)),
    // Without a key or credits a Chief only captures (catch-up sends it later); `queue` makes no model call.
    "chief.capture": (p) =>
      chief.capture({ chiefId: p.chief_id, projectId: p.project_id, text: p.text, source: p.source ?? "composer", mode: p.mode, ...(p.attachments ? { attachments: p.attachments } : {}), ...(p.showing ? { showing: { workspaceId: p.showing.workspace_id } } : {}) }).pipe(
        Effect.map((added) => ({ item: Board.toWire(added) })),
        Effect.mapError(refused),
      ),
    "chief.attach": (p) =>
      chief.attach({ chiefId: p.chief_id, workspaceId: p.workspace_id }).pipe(
        Effect.map((item) => ({ item: Board.toWire(item) })),
        Effect.mapError(refused),
      ),
    "chief.manage": (p) =>
      chief.manage({ topic: p.topic, chiefId: p.chief_id, handOver: p.hand_over ?? [] }).pipe(Effect.mapError(refused)),
    "chief.items.list": () => chief.board.items.pipe(Effect.map((items) => ({ items: wire(items) }))),
    "chief.items.update": (p) =>
      Effect.gen(function* () {
        yield* liveItem(p.item_id);
        // The scheduler compares UTC ISO strings. Wire dates are strings, so validate and
        // canonicalize here just as the Chief's schedule tool does, before writing anything.
        let notBefore = p.not_before;
        if (typeof notBefore === "string") {
          const at = Date.parse(notBefore);
          if (!Number.isFinite(at)) return yield* Effect.fail(new ProtocolError({ reason: "invalid_state", message: `${notBefore} is not a date and time.` }));
          notBefore = new Date(at).toISOString();
        }
        let before: Board.Item | undefined;
        const next = yield* chief.board.update<Board.Item | "running" | "elsewhere" | undefined>("person:edit", (items) =>
          Effect.gen(function* () {
            const current = items.find((i) => i.id === p.item_id);
            // Checked again under the board's lock: its Chief may have gone since.
            const owner = current?.chief_id === undefined ? undefined : yield* chief.byId(current.chief_id);
            if (current === undefined || (current.chief_id !== undefined && owner === undefined)) return { write: [], value: undefined };
            // Its chats are followed by its state alone: it leaves for done or dropped, never to wait again.
            if (Board.RUNNING_STATES.has(current.state) && (typeof notBefore === "string" || p.state === "queued")) return { write: [], value: "running" as const };
            // An item stays with its Chief, which works only in its projects.
            if (p.project_ids !== undefined && owner !== undefined && p.project_ids.some((id) => !inProjects(owner.profile, id))) return { write: [], value: "elsewhere" as const };
            before = current;
            let next: Board.Item = {
              ...(p.text !== undefined ? Board.rewritten(current, p.text, now()) : current),
              ...(p.title !== undefined ? { title: p.title } : {}),
              ...(p.pinned !== undefined ? { pinned: p.pinned } : {}),
              ...(p.project_ids !== undefined ? { project_ids: [...new Set(p.project_ids)] } : {}),
              updated_at: now(),
            };
            next = Board.mission(next, { done_when: p.done_when, check_in: p.check_in }, now());
            if (p.updates !== undefined) next = Board.followUpdates(next, p.updates, now());
            if (notBefore === null && next.state === "scheduled") next = Board.requeue(next, now());
            else if (typeof notBefore === "string") next = Board.schedule(next, notBefore, now());
            if (p.state === "queued") next = Board.requeue(next, now());
            if (p.state === "done") next = Board.done(next, now());
            if (p.state === "dropped") next = Board.drop(next, now());
            return { write: [next], value: next };
          }),
        );
        if (next === undefined) return yield* Effect.fail(new ProtocolError({ reason: "invalid_state", message: `${p.item_id}'s Chief was removed: its items can't be changed or started` }));
        if (next === "running") return yield* Effect.fail(new ProtocolError({ reason: "invalid_state", message: `${p.item_id} has chats running: it can't be scheduled or queued again; drop it or let them finish first` }));
        if (next === "elsewhere") return yield* Effect.fail(new ProtocolError({ reason: "invalid_params", message: `${p.item_id} stays with its Chief, which does not work in that project: give the work to a Chief that does` }));
        if (before !== undefined) {
          const projects = before.project_ids;
          if (next.state === "dropped" && before.state !== "dropped" && (before.proposal !== undefined || before.state === "proposed")) yield* chief.learn("dropped_suggestion", next, before);
          if (next.text !== before.text && before.proposal !== undefined) yield* chief.learn("rewrote_after_draft", next, before);
          if (next.project_ids.length !== projects.length || next.project_ids.some((id) => !projects.includes(id))) yield* chief.learn("moved_projects", next, before);
          if (next.pinned && !before.pinned) {
            const ordered = (yield* chief.board.all).filter((i) => i.chief_id === next.chief_id && Board.OPEN_STATES.has(i.state)).sort(Board.byRank);
            yield* chief.learn("reordered", next, before, ordered.findIndex((i) => i.id === next.id) + 1 || undefined);
          }
        }
        return Board.toWire(next);
      }),
    "chief.items.remove": (p) =>
      Effect.gen(function* () {
        const current = yield* item(p.item_id);
        // Its chats still run: the board must keep watching them. Drop it instead, or wait for them.
        if (Board.RUNNING_STATES.has(current.state)) return yield* Effect.fail(new ProtocolError({ reason: "invalid_state", message: `${p.item_id} has chats running: drop it or let them finish first` }));
        const removed = yield* chief.board.remove(p.item_id, "person:remove");
        if (removed !== undefined) yield* chief.learn("removed", removed);
        return {};
      }),
    "chief.items.reorder": (p) =>
      Effect.gen(function* () {
        yield* item(p.item_id);
        if (p.before_item_id !== null) yield* item(p.before_item_id);
        const moved = yield* chief.board.update("person:reorder", (items) => {
          const write = Board.reorderByUser(items, p.item_id, p.before_item_id, now());
          const next = write.find((i) => i.id === p.item_id);
          const ordered = items.map((i) => write.find((changed) => changed.id === i.id) ?? i).filter((i) => i.chief_id === next?.chief_id && Board.OPEN_STATES.has(i.state)).sort(Board.byRank);
          return Effect.succeed({ write, value: next === undefined ? undefined : { next, position: ordered.findIndex((i) => i.id === next.id) + 1 || undefined } });
        });
        if (moved !== undefined) yield* chief.learn("reordered", moved.next, undefined, moved.position);
        return { items: wire(yield* chief.board.items) };
      }),
    "chief.change_sets.list": () => chief.board.changeSets.pipe(Effect.map((change_sets) => ({ change_sets: [...change_sets] }))),
    "chief.start": (p) =>
      Effect.gen(function* () {
        for (const id of p.item_ids) {
          const current = yield* liveItem(id);
          // You approved it: only the concurrency limit and the daily cap can still hold it back. Checked again under
          // admission's lock, so a second Start (or a readmission) never starts it twice.
          if (current.proposal !== undefined) {
            yield* chief.admit(id, current.proposal, true, (i) => Board.OPEN_STATES.has(i.state));
            continue;
          }
          // No chat drafted yet: the Chief drafts and starts it, told as a note in start mode.
          const flagged = yield* chief.board.update("start", (items) => {
            const open = items.filter((i) => i.id === id && Board.OPEN_STATES.has(i.state));
            return Effect.succeed({ write: open.map((i) => ({ ...Board.requeue(i, now()), start: true, delivered: false })), value: open[0] });
          });
          if (flagged !== undefined && (yield* canThink(flagged.chief_id))) yield* chief.sendNote({ ...flagged, start: true });
        }
        const items = yield* chief.board.all;
        return { items: wire(items.filter((i) => p.item_ids.includes(i.id))) };
      }).pipe(Effect.mapError(refused)),
    "chief.voice.start": (p, ctx) => calls((v) => v.start({ device: p.device, connectionId: ctx.connectionId, ...(p.answer ? { answer: p.answer } : {}), ...(p.chief_id ? { chiefId: p.chief_id } : {}) })),
    "chief.voice.signal": (p) => calls((v) => v.signal(p.call_id, p.seq, p.events)),
    "chief.voice.update": (p) => calls((v) => v.setMuted(p.call_id, p.muted).pipe(Effect.map((call) => ({ call })))),
    "chief.voice.end": (p) => calls((v) => v.end(p.call_id, p.reason ?? "person").pipe(Effect.map((call) => ({ call })))),
    "chief.voice.key": (p) => calls((v) => v.setKey(p.engine, p.key)),
    "chief.view.get": (p) =>
      Effect.gen(function* () {
        const me = yield* chief.resolve({ chiefId: p.chief_id });
        return yield* chief.view.get(me.profile.id);
      }).pipe(Effect.mapError(refused)),
    // The person closed its tab: closed by them, so the Chief leaves it closed a while (smartView.ts).
    "chief.view.dismiss": (p) => chief.mustBe(p.chief_id).pipe(Effect.flatMap((me) => chief.view.close(me.profile.id, p.id, "person")), Effect.mapError(refused)),
  };
  const forbidden = new ProtocolError({ reason: "forbidden", message: "the Chiefs belong to this runtime's owner" });
  // Every chief.* call checks its caller first: notes captured here count as the owner's own words. Then it waits for
  // the Chief's startup pass (Chief.ts settled), so none sees a Chief or a board from before it.
  return Object.fromEntries(
    Object.entries(handlers).map(([method, handler]) => [
      method,
      (params: never, ctx: { readonly connectionId: string; readonly principal?: string }) =>
        allowed(ctx.principal) ? chief.settled.pipe(Effect.andThen((handler as (p: never, c: typeof ctx) => Effect.Effect<unknown, ProtocolError>)(params, ctx))) : Effect.fail(forbidden),
    ]),
  ) as unknown as typeof handlers;
};
