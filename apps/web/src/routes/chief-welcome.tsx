// A Chief's greeting, for clean mobile navigation.md "Its screen"): three
// lines in its voice, set as its replies are (who it is, what it does, what to hand it first), then a "Put <name> to work" card of three
// missions in the projects it works in: a ready-made Chief's own (shell/chief-templates.ts), else the starters. A pick
// is sent as your note. Once the conversation has begun, the greeting stays at its top with the card folded to one
// line, "Answered in the chat".
import type { ChiefAvatar } from "@caveman-app/session-protocol";
import { UnlockButton } from "../components/UnlockPlans.tsx";
import { Button } from "@caveman-app/ui/components/button";
import { ArrowRight01Icon, CheckListIcon, Icon, Refresh01Icon, ShieldKeyIcon, type IconSvgElement } from "@caveman-app/ui/icons/huge";
import { cn } from "@caveman-app/ui/lib/cn";
import { useState } from "react";
import { MessengerName, MessengerRow } from "../components/transcript/messenger.tsx";
import { templateOf } from "../shell/chief-templates.ts";
import { useRuntimeSelector } from "../state/runtime.tsx";

/** What a Chief does, in its own voice, when it has no role of its own. */
export const DEFAULT_ROLE = "I take work off your plate and get it done in the background. You hear from me when it's done or I need you.";

export interface Mission {
  readonly icon: IconSvgElement;
  /** Its name on the card: what to own, and where. */
  readonly title: string;
  /** One line under it: what that means. */
  readonly line: string;
  /** What is sent as your note when you pick it. */
  readonly note: string;
}

/**
 * Three missions for a Chief's first card, in the projects it works in (none listed: every project), the first two of
 * them: keep CI green, a security review every day, and weekly dependency upgrades. No projects yet: none.
 */
export function starterMissions(projects: ReadonlyArray<{ readonly id: string; readonly name: string }>, scope: ReadonlyArray<string>): Mission[] {
  const mine = scope.length === 0 ? projects : projects.filter((p) => scope.includes(p.id));
  const [first, second = first] = mine;
  if (first === undefined) return [];
  return [
    { icon: CheckListIcon, title: `Keep CI green in ${first.name}`, line: "Fix failing checks as they land on main", note: `Keep CI green in ${first.name}: when a check fails on main, find out why and fix it.` },
    { icon: ShieldKeyIcon, title: `Daily security review of ${second!.name}`, line: "Leaked secrets, unsafe code, risky packages", note: `Review ${second!.name} for security problems every day, starting now: leaked secrets, unsafe code, risky packages. Only tell me what you find.` },
    { icon: Refresh01Icon, title: `Upgrade dependencies weekly in ${first.name}`, line: "One pull request a week, tests passing", note: `Every week, upgrade ${first.name}'s dependencies that are safe to upgrade, in one pull request with the tests passing.` },
  ];
}

/**
 * The card's three missions: a ready-made Chief's own while its role is still its template's, else the starters. None
 * while it has no project to work in, as for the starters.
 */
export function cardMissions(projects: ReadonlyArray<{ readonly id: string; readonly name: string }>, scope: ReadonlyArray<string>, role: string | undefined): ReadonlyArray<Mission> {
  const starters = starterMissions(projects, scope);
  return starters.length === 0 ? starters : (templateOf(role)?.missions ?? starters);
}

/**
 * Its greeting, in the conversation's column: its name, three lines and its character at the last, then the card.
 * `onPick` absent: the conversation has begun, and the card is folded to "Answered in the chat".
 */
export function ChiefIntro({ name, avatar, role, scope, onPick }: { name: string; avatar: ChiefAvatar | null; role?: string | undefined; scope: ReadonlyArray<string>; onPick?: ((mission: Mission) => Promise<void>) | undefined }) {
  const projects = useRuntimeSelector((v) => v.projects);
  const missions = cardMissions(projects, scope, role);
  return (
    <article aria-label={`${name} says hello`} className="pt-3">
      <MessengerRow avatar={avatar} end working={false}>
        <MessengerName name={name} />
        <div className="flex flex-col gap-4 text-[14px] leading-6 text-foreground [overflow-wrap:anywhere]">
          <p>Hi, I'm {name}.</p>
          <p>{role?.trim() || DEFAULT_ROLE}</p>
          <p>{missions.length > 0 ? "What should I take on first?" : "Add a project and tell me what to take on."}</p>
        </div>
      </MessengerRow>
      {missions.length > 0 ? (
        <div className="ml-[38px] mt-2.5">
          {onPick ? <PutToWork name={name} missions={missions} onPick={onPick} /> : (
            <p className="flex h-7 items-center gap-2 text-[13px]">
              <span className="text-foreground">Put {name} to work</span>
              <span className="text-muted-foreground">Answered in the chat</span>
            </p>
          )}
        </div>
      ) : null}
    </article>
  );
}

/** The card: three missions, each a row you pick (the compact layout). */
function PutToWork({ name, missions, onPick }: { name: string; missions: ReadonlyArray<Mission>; onPick: (mission: Mission) => Promise<void> }) {
  // One pick at a time; one that didn't go says so under the card, and the card stays to try again.
  const [sending, setSending] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const pick = (m: Mission) => {
    setProblem(null);
    setSending(m.title);
    onPick(m)
      .catch((e: unknown) => setProblem(`Not sent: ${e instanceof Error ? e.message : String(e)}`))
      .finally(() => setSending(null));
  };
  return (
    <div className="max-w-[560px] rounded-xl border border-border bg-card p-1.5">
      <p className="px-2.5 pb-1 pt-1.5 text-[13px] font-medium text-foreground">Put {name} to work</p>
      <ul>
        {missions.map((m) => (
          <li key={m.title}>
            <button
              type="button"
              onClick={() => pick(m)}
              disabled={sending !== null}
              aria-busy={sending === m.title || undefined}
              className="group/mission flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left outline-none transition-colors duration-75 disabled:opacity-60 hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            >
              <span aria-hidden className="grid size-8 shrink-0 place-items-center rounded-lg bg-secondary text-muted-foreground">
                <Icon icon={m.icon} className="size-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] text-foreground">{m.title}</span>
                <span className="block truncate text-[12px] text-muted-foreground">{m.line}</span>
              </span>
              <Icon icon={ArrowRight01Icon} className={cn("size-4 shrink-0 text-muted-foreground transition-transform duration-150 ease-snap group-hover/mission:translate-x-0.5")} />
            </button>
          </li>
        ))}
      </ul>
      {problem ? (
        <p role="alert" className="px-2.5 pb-1.5 pt-1 text-[12.5px] text-destructive">
          {problem}
        </p>
      ) : null}
    </div>
  );
}

/**
 * A Chief's empty conversation: its greeting with the card open, and while it has nothing to think with, one line
 * saying so with the way to fix it.
 */
export function ChiefWelcome({
  name,
  avatar,
  role,
  scope,
  noKey,
  onAddKey,
  onUnlock,
  onPick,
}: {
  name: string;
  avatar: ChiefAvatar | null;
  role?: string | undefined;
  scope: ReadonlyArray<string>;
  noKey: boolean;
  onAddKey: () => void;
  /** Offered where a plan would run it (offersUnlock): no key to paste. */
  onUnlock?: (() => void) | undefined;
  onPick: (mission: Mission) => Promise<void>;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto pl-14 pr-6 pt-2 max-md:px-4">
      <div className="mx-auto max-w-[760px] pb-6">
        <ChiefIntro name={name} avatar={avatar} role={role} scope={scope} onPick={onPick} />
        {noKey ? (
          <div role="note" className="ml-[38px] mt-6 flex items-center gap-3">
            <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-warning" />
            <p className="min-w-0 flex-1 text-[13px] leading-5 text-foreground">
              {onUnlock
                ? "I can't think yet. A plan runs me on its usage, no key to paste; until then your notes wait in the Queue."
                : "I can't think yet. Add a key, sign in or turn on credits; until then your notes wait in the Queue."}
            </p>
            {onUnlock ? (
              <>
                <Button type="button" size="sm" variant="ghost" onClick={onAddKey}>
                  Add a key
                </Button>
                <UnlockButton onClick={onUnlock} />
              </>
            ) : (
              <Button type="button" size="sm" onClick={onAddKey}>
                Add a key
              </Button>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}
