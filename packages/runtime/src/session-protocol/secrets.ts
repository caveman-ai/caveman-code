// Project secrets on the Session Protocol: the secret.* methods, the send
// backstop, the env a workspace's processes get, and the per-item scrub of
// tool output (16-SECRETS.md). Values come in only through secret.set and
// secret.import and never go back out.
import * as fs from "node:fs";
import * as path from "node:path";

import { containsKnownSecret, isReservedEnvName, parseDotenv, SECRET_NAME_PATTERN, type Repo, type Scrubber } from "@caveman-app/session-protocol";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

import * as ServerConfig from "../config.ts";
import { openNoFollowSync } from "../openNoFollow.ts";
import { TRUNCATED_FOR_TRANSPORT } from "../orchestration-v2/WireProjection.ts";
import { ProjectSecrets, type ProjectSecretsError } from "../secrets/ProjectSecrets.ts";
import { cloudAvailability } from "./cloudSync.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { type Handler, ProtocolError } from "./handlers.ts";
import { git } from "./lifecycle.ts";
import type { DraftEvent } from "./projector.ts";

type SecretMethod = "secret.list" | "secret.repin" | "secret.set" | "secret.delete" | "secret.env_files" | "secret.import";

const MAX_ENV_FILE_BYTES = 1024 * 1024;

const fail = (reason: string, message: string) => Effect.fail(new ProtocolError({ reason, message }));

/**
 * Git-ignored `.env*` files at the top of `root`, by name. Regular files only:
 * a symlink could point anywhere, and a tracked file is not ignored, so a
 * committed `.env.example` is never offered.
 */
export const ignoredEnvFiles = (driver: GitVcsDriver.GitVcsDriver["Service"], root: string) =>
  Effect.gen(function* () {
    const names = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.startsWith(".env"))
      .map((entry) => entry.name);
    if (names.length === 0) return [];
    const result = yield* git(driver, root, ["check-ignore", "--", ...names], { allowNonZeroExit: true }).pipe(
      Effect.orElseSucceed(() => ({ stdout: "" })),
    );
    const ignored = new Set(result.stdout.split("\n").map((line) => line.trim()));
    return names.filter((name) => ignored.has(name)).sort();
  });

/**
 * Reads `<root>/<name>`, refusing a symlink at open time (it may have been
 * swapped in since the listing), and a FIFO or device without blocking on it.
 */
export function readEnvFile(root: string, name: string): string {
  const fd = openNoFollowSync(path.join(root, name), fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_ENV_FILE_BYTES) throw new Error(`${name} is not a readable env file`);
    return fs.readFileSync(fd, "utf8");
  } finally {
    fs.closeSync(fd);
  }
}

/** turn.submit's backstop: a known credential shape, or a value already stored for any repository. */
export const secretInInput = (scrubber: Scrubber, text: string) => containsKnownSecret(text) || scrubber.scrub(text) !== text;

/** A file attachment's text (base64, or a data: URL); images are not read. */
const attachmentText = (attachment: { readonly type: string; readonly data: string }) => {
  if (attachment.type !== "file") return "";
  const data = attachment.data;
  const comma = data.startsWith("data:") ? data.indexOf(",") : -1;
  if (comma < 0) return Buffer.from(data, "base64").toString("utf8");
  if (/;base64$/i.test(data.slice(0, comma))) return Buffer.from(data.slice(comma + 1), "base64").toString("utf8");
  try {
    return decodeURIComponent(data.slice(comma + 1));
  } catch {
    return data.slice(comma + 1);
  }
};

/**
 * The send backstop for text a person or agent hands the engine: the text
 * and any file attachments. Nothing of a rejected input is kept.
 */
export const rejectSecretInput = (
  secrets: ProjectSecrets["Service"],
  text: string,
  attachments: ReadonlyArray<{ readonly type: string; readonly data: string }> = [],
) =>
  secrets.scrubber.pipe(
    Effect.flatMap((scrubber) =>
      [text, ...attachments.map(attachmentText)].some((part) => part !== "" && secretInInput(scrubber, part))
        ? fail("secret_in_input", "This text holds a secret. Store it with secret.set and refer to it by name; nothing was sent.")
        : Effect.void,
    ),
  );

/**
 * The repository's secrets as env, for a process the runtime starts. Goes
 * after [env] and the port variables. Never a name that changes how the
 * process itself runs (PATH, BASH_ENV, GIT_SSH_COMMAND...). Locked, an
 * origin that moved, or no repository: nothing.
 */
export const repoEnv = (secrets: ProjectSecrets["Service"], repo: Repo) =>
  secrets.keyOf(repo).pipe(
    Effect.flatMap(secrets.resolve),
    Effect.map((entries) => Object.fromEntries(entries.filter((e) => !isReservedEnvName(e.name, "process")).map((e) => [e.name, e.value])) as Record<string, string>),
    Effect.orElseSucceed(() => ({}) as Record<string, string>),
  );

/** The scrubber's shortest value: a pause sends a held tail only while it is shorter, so it never shows a whole one. */
const MIN_HELD = 8;

/**
 * A stream scrub that follows the current scrubber: when it changes (a
 * secret set while a command runs), the held tail moves into a stream of
 * the new one, which still knows every old value. `idle` sends what waits
 * after output pauses (an echo, a prompt) unless it is long enough to be a
 * value's start, and keeps matching it against what follows, so a value
 * that started in it is masked from there on; `end` masks a long one as
 * `[secret]`.
 */
export function followingStream(current: () => Scrubber) {
  let scrubber = current();
  let inner = scrubber.stream();
  /** What `idle` sent of the text `inner` still holds: inner's next output renders it again, unless a value started in it. */
  let shown = "";
  const unseen = (out: string) => {
    let same = 0;
    while (same < out.length && same < shown.length && out[same] === shown[same]) same++;
    shown = same === out.length ? shown.slice(same) : "";
    return out.slice(same);
  };
  /** Everything inner holds, rendered; a fresh stream of the current scrubber takes its place. */
  const take = () => {
    const held = inner.flush();
    scrubber = current();
    inner = scrubber.stream();
    return held;
  };
  const follow = () => {
    if (current() === scrubber) return "";
    const held = take();
    return unseen(inner.push(held));
  };
  return {
    push: (chunk: string) => {
      const lead = follow();
      return lead + unseen(inner.push(chunk));
    },
    idle: () => {
      const held = take();
      if (held.length >= MIN_HELD) return unseen(inner.push(held));
      const out = unseen(held);
      shown = held;
      return out + unseen(inner.push(held));
    },
    end: () => {
      const held = take();
      if (held.length < MIN_HELD) return unseen(held);
      shown = "";
      return "[secret]";
    },
  };
}

/** The colour a tail window cut inside a styled line starts with (terminalOutputTail). */
const LEADING_STYLE = /^(?:\u001b\[[0-9;]*m)*/;

/**
 * A `truncated` replace frame's text after its leading colour: what the window's cut left of a value it fell inside
 * goes as `[secret]`, as a stream's end masks a value it cuts off, unless that is shorter than a value can be.
 */
function maskCutStart(scrubber: Scrubber, text: string): string {
  const style = LEADING_STYLE.exec(text)![0];
  const cut = scrubber.cutValueEnd(text.slice(style.length));
  return cut < MIN_HELD ? text : `${style}[secret]${text.slice(style.length + cut)}`;
}

/**
 * How the runtime ends a text it cut to a bound: a detail read (WireProjection), a failure message
 * (makeProviderFailure), a tool input's one-line summary. The cut came before the scrub, so a value it fell inside ends
 * the text unmasked.
 */
const CUT_MARKERS = [TRUNCATED_FOR_TRANSPORT, "…"];

/** The marker `text` ends with when the runtime cut it to a bound, else undefined. */
export const cutMarkerOf = (text: string) => CUT_MARKERS.find((cut) => text.endsWith(cut));

/**
 * `text` masked by `scrubber`, its end as a stream's end masks a value the end cut off: a text cut inside a value keeps
 * its start, which the whole-text scrub cannot recognise.
 */
export function maskEnd(scrubber: Scrubber, text: string): string {
  const stream = followingStream(() => scrubber);
  return stream.push(text) + stream.end();
}

/**
 * `text` masked by `scrubber`, its end too when it ends in a cut's marker (maskEnd). The /ws route (ClientScrub) and
 * the projector (daemon.ts) read the same cut texts through it.
 */
export function maskCut(scrubber: Scrubber, text: string): string {
  const marker = cutMarkerOf(text);
  return marker === undefined ? scrubber.scrub(text) : maskEnd(scrubber, text.slice(0, -marker.length)) + marker;
}

/**
 * Scrubs one command row's live output (CommandOutputHub frames) with a following stream, so a
 * value split across two chunks is caught. A `replace` frame starts a fresh stream, and one whose
 * window was cut (`truncated`) first loses what the cut left of a value; the last frame
 * (`running: false`) also carries what the stream held, masked if it could start a value. `idle`,
 * once output pauses, gives what it holds unless that could be a value's start, as a terminal's does.
 */
export function makeCommandOutputScrub(current: () => Scrubber) {
  let stream = followingStream(current);
  const scrub = <
    F extends { readonly kind: "replace" | "append"; readonly text: string; readonly truncated: boolean; readonly running: boolean },
  >(frame: F): F => {
    if (frame.kind === "replace") stream = followingStream(current);
    const text = frame.kind === "replace" && frame.truncated ? maskCutStart(current(), frame.text) : frame.text;
    return { ...frame, text: stream.push(text) + (frame.running ? "" : stream.end()) };
  };
  return Object.assign(scrub, { idle: () => stream.idle() });
}

const STREAMED = new Set(["tool.output", "message.delta", "reasoning.delta"]);

/**
 * Scrubs streamed text per item (tool.output, message and reasoning deltas)
 * with a following stream, so a value split across two events is caught,
 * also when it was set mid-command. A held tail goes out before its item's
 * tool.done or message.done, else before its turn's turn.done. One per
 * projector: items are keyed by id, which is global.
 */
export function makeOutputScrub() {
  let latest: Scrubber | undefined;
  const streams = new Map<string, { readonly turn: string | undefined; readonly ids: Partial<DraftEvent>; readonly stream: ReturnType<typeof followingStream> }>();
  const tail = (key: string, at: string): Array<DraftEvent> => {
    const held = streams.get(key);
    streams.delete(key);
    const text = held?.stream.end() ?? "";
    return text === "" ? [] : [{ ...held!.ids, at, payload: { text } } as DraftEvent];
  };
  return (scrubber: Scrubber, drafts: ReadonlyArray<DraftEvent>): Array<DraftEvent> => {
    latest = scrubber;
    return drafts.flatMap((draft) => {
      const item = draft.item_id;
      if (STREAMED.has(draft.type) && item !== undefined) {
        const key = `${draft.type}\0${item}`;
        let held = streams.get(key);
        if (held === undefined) {
          const { payload: _payload, at: _at, ...ids } = draft;
          streams.set(key, (held = { turn: draft.turn_id ?? undefined, ids, stream: followingStream(() => latest!) }));
        }
        const payload = draft.payload as { text: string };
        const text = held.stream.push(payload.text);
        // Text the stream holds back is dropped for now; an empty delta goes out (a thought's line, before its text).
        return text === "" && payload.text !== "" ? [] : [{ ...draft, payload: { ...payload, text } } as DraftEvent];
      }
      if (draft.type === "tool.done" && item !== undefined) return [...tail(`tool.output\0${item}`, draft.at), draft];
      if (draft.type === "message.done" && item !== undefined) return [...tail(`message.delta\0${item}`, draft.at), draft];
      if (draft.type === "turn.done") {
        const ended = [...streams].filter(([, held]) => held.turn === draft.turn_id).map(([key]) => key);
        return [...ended.flatMap((key) => tail(key, draft.at)), draft];
      }
      return [draft];
    });
  };
}

/**
 * Refuses names a stored secret may never have: what SecretName refuses
 * (`__proto__`...), and the ones that change how a process runs (PATH,
 * shells, git, loaders, proxies, TLS trust). Caveman Cloud refuses the same.
 */
export const refuseReservedNames = (names: ReadonlyArray<string>) => {
  const refused = [...new Set(names)].filter((name) => !SECRET_NAME_PATTERN.test(name) || isReservedEnvName(name, "process"));
  return refused.length === 0
    ? Effect.void
    : fail(
        "invalid_params",
        `${refused.join(", ")} can't be stored as a secret: reserved for how processes run (PATH, shells, git, loaders, proxies, TLS) or not a valid variable name`,
      );
};

/** How a ProjectSecrets failure reads on the wire. */
const secretError = (error: ProjectSecretsError) =>
  new ProtocolError({
    reason: error.reason === "not_a_repository" ? "invalid_params" : error.reason === undefined ? "internal" : "invalid_state",
    message: error.message,
  });

/**
 * secret.*: keyed by the repository (ProjectSecrets.keyOf); a Repo that is
 * not one is invalid_params. `allowed` says which principals may use this
 * runtime's secrets ("just me"); any other is forbidden.
 */
export const makeSecretHandlers = (allowed: (principal: string | undefined) => boolean) => Effect.gen(function* () {
  const secrets = yield* ProjectSecrets;
  const config = yield* Effect.serviceOption(ServerConfig.ServerConfig);
  const driver = yield* GitVcsDriver.GitVcsDriver;
  const internal = secretError;
  const keyOf = (repo: Repo) => secrets.keyOf(repo).pipe(Effect.mapError(secretError));
  /** The checkout's top level, real path; undefined for a repository given by URL (no files here to read). */
  const localRoot = (repo: Repo) =>
    "url" in repo
      ? Effect.succeed(undefined)
      : git(driver, repo.path, ["rev-parse", "--show-toplevel"]).pipe(
          Effect.map((result) => fs.realpathSync(result.stdout.trim())),
          Effect.mapError(() => new ProtocolError({ reason: "invalid_params", message: `${repo.path} is not a git repository` })),
        );

  const forbidden = new ProtocolError({ reason: "forbidden", message: "these secrets belong to this runtime's owner" });
  const handlers: { readonly [M in SecretMethod]: Handler<M> } = {
    "secret.list": (p) =>
      Effect.gen(function* () {
        const repository = yield* keyOf(p.repo);
        const list = yield* secrets.list(repository).pipe(Effect.mapError(internal));
        return {
          repository,
          secrets: list,
          ...(Option.isSome(config) ? cloudAvailability(config.value.stateDir, repository, list.map((s) => s.name)) : {}),
        };
      }),
    "secret.repin": (p) => secrets.repin(p.repo).pipe(Effect.mapError(secretError), Effect.map((repository) => ({ repository }))),
    "secret.set": (p) =>
      refuseReservedNames(p.secrets.map((s) => s.name)).pipe(
        Effect.andThen(keyOf(p.repo)),
        Effect.flatMap((repository) =>
          secrets.set(repository, p.secrets.map((s) => ({ name: s.name, value: Redacted.make(s.value) }))).pipe(Effect.mapError(internal)),
        ),
        Effect.map((list) => ({ secrets: list })),
      ),
    "secret.delete": (p) =>
      keyOf(p.repo).pipe(
        Effect.flatMap((repository) => secrets.remove(repository, p.name).pipe(Effect.mapError(internal))),
        Effect.as({}),
      ),
    "secret.env_files": (p) =>
      Effect.gen(function* () {
        const repository = yield* keyOf(p.repo);
        const root = yield* localRoot(p.repo);
        if (root === undefined) return { files: [] };
        const stored = new Set((yield* secrets.list(repository).pipe(Effect.mapError(internal))).map((s) => s.name));
        const files = [];
        for (const name of yield* ignoredEnvFiles(driver, root)) {
          let text: string;
          try {
            text = readEnvFile(root, name);
          } catch {
            continue;
          }
          const names = [...new Set(parseDotenv(text).entries.filter((e) => e.value !== "" && !stored.has(e.name)).map((e) => e.name))];
          if (names.length > 0) files.push({ path: name, names });
        }
        return { files };
      }),
    "secret.import": (p) =>
      Effect.gen(function* () {
        const repository = yield* keyOf(p.repo);
        const root = yield* localRoot(p.repo);
        if (root === undefined) return yield* fail("invalid_params", "a repository given by URL has no files here to import");
        // The trust boundary: only a name secret.env_files would list (top level, .env*, git-ignored, a regular file).
        if (!(yield* ignoredEnvFiles(driver, root)).includes(p.path)) {
          return yield* fail("invalid_params", `${p.path} is not a git-ignored .env file at the top of the repository`);
        }
        let text: string;
        try {
          text = readEnvFile(root, p.path);
        } catch {
          return yield* fail("invalid_params", `${p.path} could not be read as an env file`);
        }
        const picked = p.names === undefined ? null : new Set(p.names);
        const entries = parseDotenv(text).entries.filter((e) => e.value !== "" && (picked === null || picked.has(e.name)));
        if (entries.length === 0) return { secrets: [] };
        yield* refuseReservedNames(entries.map((e) => e.name));
        // A name assigned twice keeps its last value, as dotenv loaders do.
        const last = new Map(entries.map((e) => [e.name, e.value]));
        const list = yield* secrets
          .set(repository, [...last].map(([name, value]) => ({ name, value: Redacted.make(value) })))
          .pipe(Effect.mapError(internal));
        return { secrets: list };
      }),
  };
  // Every secret.* call checks its caller first.
  return Object.fromEntries(
    Object.entries(handlers).map(([method, handler]) => [
      method,
      (params: never, ctx: { readonly connectionId: string; readonly principal?: string }) =>
        allowed(ctx.principal) ? (handler as (p: never, c: typeof ctx) => Effect.Effect<unknown, ProtocolError>)(params, ctx) : Effect.fail(forbidden),
    ]),
  ) as unknown as typeof handlers;
});
