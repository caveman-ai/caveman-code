/**
 * Prewarm: guides written before anyone opens the pull request
 * (docs/, "Measured"). The call cannot get much faster, so
 * the guide is written when a pull request that waits on you first shows up, on an idle
 * subscription, and opening it is instant.
 *
 * Every 10 minutes (and once 30 seconds after start) it lists open pull requests through the same
 * cached `PullRequestService.list` read `pr.list` uses. Template guides (bots, mechanical files)
 * are written at once, free. A model writes only on the first writer's login, when its engine ran
 * no turn for a while, its plan window has room and today's model runs are under the cap: two
 * minutes, 70% and 20 by default, each a server setting (`reviewGuidePrewarmIdleMinutes`,
 * `reviewGuidePrewarmPlanPercent`, `reviewGuidePrewarmDaily`). One run at a time; the guide
 * service puts a person's run first.
 *
 * A pull request a chat opens or links gets its guide at once, without waiting for a pass: the
 * moment the link lands, on the cheapest writer here (DeepSeek Flash, Luna or Haiku, a
 * subscription or Caveman credits before the person's own key; `automaticReviewGuideWriters`),
 * whatever harness the chat runs on. When the chat wrote the pull request's TL;DR as it linked it,
 * a short change needs nothing more, and a long one's tour starts from it. One the chat opened (not
 * one a person linked) then gets its guide as a comment on the host, for its reviewers
 * (`reviewGuidePost`, docs/).
 *
 * @module pullRequest/PullRequestReviewGuidePrewarm
 */
import type {
  ModelSelection,
  OrchestrationV2DomainEvent,
  PullRequestListResult,
  PullRequestRef,
  ServerProvider,
  ServerSettings as ServerSettingsValue,
} from "@caveman-app/protocol";
import type { SessionEvent } from "@caveman-app/session-protocol";
import { resolveProjectSettings } from "@caveman-app/shared/projectSettings";
import { planUsedPercent, reviewGuideWriterRank } from "@caveman-app/shared/serverSettings";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import type * as Scope from "effect/Scope";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { ruleOf } from "../cloudLink/credentialRule.ts";
import { CloudLinkState } from "../cloudLink/index.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import { SessionStore } from "../session-protocol/store.ts";
import * as PullRequestReviewGuideService from "./PullRequestReviewGuideService.ts";
import * as PullRequestService from "./PullRequestService.ts";

/**
 * A link a chat just made to a pull request it opened or picked up: new (never synced), by the
 * agent, the app's own create flow, or the person. Stack links and their tombstones are not.
 */
export function newlyLinkedPullRequest(event: OrchestrationV2DomainEvent) {
  if (event.type !== "thread.pull-request-link-updated") return null;
  const link = event.payload;
  return link.snapshot === null && (link.source === "agent" || link.source === "created" || link.source === "manual")
    ? { threadId: event.threadId, host: link.host, repository: link.repository, number: link.number, source: link.source }
    : null;
}

/** Open pull requests that wait on the viewer: asking for their review, or their own. Never drafts. */
export function prewarmCandidates(listed: PullRequestListResult): ReadonlyArray<PullRequestRef> {
  return listed.entries
    .filter((entry) => {
      if (entry.state !== "open" || entry.isDraft) return false;
      const viewer = listed.viewers[entry.host]?.toLowerCase();
      return entry.viewerReviewRequested || (viewer !== undefined && entry.author?.login.toLowerCase() === viewer);
    })
    .map((entry) => ({
      projectId: entry.projectId,
      repository: entry.repository,
      number: entry.number,
      host: entry.host,
    }));
}

/** Which engines ran a turn lately, read from the session events. */
export function engineActivity() {
  const running = new Map<string, string>();
  const lastSeen = new Map<string, number>();
  return {
    observe(event: SessionEvent) {
      if (event.type === "turn.started") {
        running.set(event.session_id, event.payload.engine);
        lastSeen.set(event.payload.engine, Date.parse(event.at));
      } else if (event.type === "turn.done") {
        const engine = running.get(event.session_id);
        running.delete(event.session_id);
        if (engine !== undefined) lastSeen.set(engine, Date.parse(event.at));
      }
    },
    /** No turn in flight on the engine, and none ended in the last `idleMs`. */
    idle(engine: string, now: number, idleMs: number) {
      return (
        ![...running.values()].includes(engine) &&
        now - (lastSeen.get(engine) ?? Number.NEGATIVE_INFINITY) >= idleMs
      );
    },
  };
}

/**
 * The writer a prewarm may run a model on, or null for template guides only: the first writer, on
 * a login or Caveman credits (never an API key), its engine idle, its fullest plan window under
 * `reviewGuidePrewarmPlanPercent`, and today's model runs under `reviewGuidePrewarmDaily`.
 * Model runs are counted in memory: a restart only resets the count, never a head already written.
 */
// ponytail: idle is per engine, not per provider instance; a second Claude login waits for the first one's turns.
export function prewarmWriter(input: {
  readonly writers: ReadonlyArray<ModelSelection>;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly idle: (engine: string) => boolean;
  readonly runsToday: number;
  readonly settings: Pick<ServerSettingsValue, "reviewGuidePrewarmDaily" | "reviewGuidePrewarmPlanPercent">;
}): ModelSelection | null {
  const writer = input.writers[0];
  const provider = input.providers.find((candidate) => candidate.instanceId === writer?.instanceId);
  if (writer === undefined || provider === undefined || input.runsToday >= input.settings.reviewGuidePrewarmDaily) return null;
  if (
    reviewGuideWriterRank(provider, writer.model) > 1 ||
    planUsedPercent(provider) >= input.settings.reviewGuidePrewarmPlanPercent
  ) {
    return null;
  }
  return input.idle(PullRequestReviewGuideService.engineOfDriver(provider.driver)) ? writer : null;
}

export class PullRequestReviewGuidePrewarm extends Context.Service<
  PullRequestReviewGuidePrewarm,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    /** One pass over the open pull requests, one guide at a time. */
    readonly pass: Effect.Effect<void>;
    /** The guide for a pull request a chat just linked, on the cheapest writer here; resolves when it is written. */
    readonly linked: (link: NonNullable<ReturnType<typeof newlyLinkedPullRequest>>) => Effect.Effect<void>;
  }
>()("caveman/pullRequest/PullRequestReviewGuidePrewarm") {}

const make = Effect.gen(function* () {
  const pullRequests = yield* PullRequestService.PullRequestService;
  const guides = yield* PullRequestReviewGuideService.PullRequestReviewGuideService;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const engine = yield* Orchestrator.OrchestratorV2;
  const store = yield* Effect.serviceOption(SessionStore);
  const activity = engineActivity();
  let today = { day: "", runs: 0 };
  // A Cloud computer whose person's credentials stay outside it (cloudLink/credentialRule.ts) holds no GitHub sign-in
  // to read pull requests with, and nobody asked it for a guide: the timed pass reads nothing and runs no model
  // there. It only failed, every ten minutes; with a way to read it would spend the person's plan unasked, on a
  // computer that sleeps when nobody is at it. A pull request a chat links (`linked`) is that chat's own doing.
  const cloudLink = yield* CloudLinkState;
  const unattended = () => ruleOf(cloudLink).known() === true;

  const pass = Effect.gen(function* () {
    if (unattended()) return;
    const settings = yield* serverSettings.getSettings;
    if (!settings.reviewGuidesEnabled || !settings.reviewGuidePrewarm) return;
    const listed = yield* pullRequests.list({ state: "open", involvement: "all" });
    for (const ref of prewarmCandidates(listed)) {
      const now = yield* Clock.currentTimeMillis;
      const day = new Date(now).toDateString();
      if (today.day !== day) today = { day, runs: 0 };
      const providers = yield* providerRegistry.getProviders;
      const projectSettings = resolveProjectSettings(settings, ref.projectId).settings;
      const writer = prewarmWriter({
        writers: ServerSettings.automaticReviewGuideWriters(projectSettings, providers, ref.projectId),
        providers,
        // Without the session store no turn can be seen, so none is assumed to have ended.
        idle: (engine) => Option.isSome(store) && activity.idle(engine, now, settings.reviewGuidePrewarmIdleMinutes * 60_000),
        runsToday: today.runs,
        settings,
      });
      const outcome = yield* guides.prewarm(ref, writer === null ? [] : [writer]).pipe(
        Effect.catch((error) =>
          Effect.logDebug("Review guide prewarm skipped a pull request", { number: ref.number, error }).pipe(
            Effect.as("skipped" as const),
          ),
        ),
      );
      if (writer !== null && (outcome === "single-pass" || outcome === "checkout" || outcome === "failed")) {
        today.runs += 1;
      }
      if (outcome !== "skipped") yield* Effect.logInfo("Review guide prewarmed", { number: ref.number, outcome });
    }
  }).pipe(
    Effect.catchCause((cause) => Effect.logWarning("Review guide prewarm pass failed", cause)),
    Effect.withSpan("PullRequestReviewGuidePrewarm.pass"),
  );

  const linked: PullRequestReviewGuidePrewarm["Service"]["linked"] = (link) =>
    Effect.gen(function* () {
      const settings = yield* serverSettings.getSettings;
      if (!settings.reviewGuidesEnabled) return;
      const thread = yield* engine.getThreadShell(link.threadId);
      if (thread === null) return;
      const ref = { projectId: thread.projectId, host: link.host, repository: link.repository, number: link.number };
      if (settings.reviewGuidePrewarm) {
        const writers = ServerSettings.automaticReviewGuideWriters(
          resolveProjectSettings(settings, ref.projectId).settings,
          yield* providerRegistry.getProviders,
          ref.projectId,
        );
        // No cheap writer here and no guide model chosen: a template still lands; a change that needs a model waits for a person.
        const outcome = yield* guides.prewarm(ref, writers);
        if (outcome !== "skipped") {
          yield* Effect.logInfo("Review guide written for a linked pull request", { number: ref.number, outcome });
        }
      }
      // Posted once there is a guide worth it; with none yet, the next one written for it is.
      if (link.source !== "manual") yield* guides.post(ref, "link");
    }).pipe(
      Effect.catchCause((cause) => Effect.logDebug("Review guide for a linked pull request skipped", { number: link.number, cause })),
      Effect.withSpan("PullRequestReviewGuidePrewarm.linked"),
    );

  const start = () =>
    Effect.gen(function* () {
      // Each link writes on its own fiber, so a long guide never holds up the next link.
      yield* forkParked(
        Stream.runForEach(engine.streamDomainEvents, (event) => {
          const link = newlyLinkedPullRequest(event);
          return link === null ? Effect.void : Effect.asVoid(Effect.forkScoped(linked(link)));
        }).pipe(Effect.catchCause((cause) => Effect.logWarning("Review guide link stream failed", cause))),
      );
      if (Option.isSome(store)) {
        // Subscribed before the fork, so no turn from here on is missed.
        const events = yield* PubSub.subscribe(store.value.events);
        yield* Effect.forkScoped(
          Effect.forever(PubSub.take(events).pipe(Effect.map((event) => activity.observe(event)))),
        );
      }
      yield* forkParked(
        Effect.sleep("30 seconds").pipe(
          Effect.andThen(pass.pipe(Effect.repeat(Schedule.spaced("10 minutes")))),
          Effect.asVoid,
        ),
      );
    });

  return PullRequestReviewGuidePrewarm.of({ start, pass, linked });
});

export const layer = Layer.effect(PullRequestReviewGuidePrewarm, make);
