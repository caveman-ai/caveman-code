// The foot of a new chat's box (components/composer-foot.tsx; Codex's "branch ⌄  This Mac ⌄" under the composer): at
// its start where the work starts, the branch the chat starts from, the repositories it works in (a project with
// several) and where it runs; at its end how many chats the task starts as, its runs. The project is picked in the
// question over the box (NewChat.tsx), never here. Each chip's picker opens upward, as the box's model picker does. A chip that holds a pick other than its default is drawn in
// ink, the rest a step under it. The foot wraps in a narrow window.
// In a browser window (routes/new-chat-web.ts) a chat in Cloud starts on a repository Cloud sees: the question names
// it (RepoMenu), there is no branch to pick, and "this Mac" is no row: the window has no computer of its own.
import type { Project, ProjectSource, Result } from "@caveman-app/session-protocol";
import { Button } from "@caveman-app/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@caveman-app/ui/components/dropdown-menu";
import {
  fadeEdges,
  menuDescription,
  menuEmpty,
  menuHeading,
} from "@caveman-app/ui/components/menu";
import { Popover, PopoverContent, PopoverTrigger } from "@caveman-app/ui/components/popover";
import {
  GitBranchIcon,
  Icon,
  Layers01Icon,
  Search01Icon,
  Tick02Icon,
} from "@caveman-app/ui/icons/huge";
import { COMPUTER_KIND_ICON } from "@caveman-app/ui/icons/names";
import { cn } from "@caveman-app/ui/lib/cn";
import { touchScreen } from "@caveman-app/ui/lib/touch";
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactElement } from "react";
import { Link } from "react-router";
import { FootChip, PlaceChip } from "../components/composer-foot.tsx";
import { Dot } from "../components/environment/parts.tsx";
import type { runOnLabel } from "../state/environment.ts";
import { thisComputer } from "../lib/platform.ts";
import { useRuntimeClient } from "../state/runtime.tsx";
import { sourceLine, sourcesLabel } from "../state/sources.ts";
import { isComposing } from "@caveman-app/ui/lib/ime";
import { CHROME_ICON, Glyph } from "@caveman-app/ui/icons/Glyph";

/** Where a new chat runs: this computer, Cloud, or another Mac of the person's by its runtime ("mac:<id>"). */
export type Where = "this_mac" | "cloud" | `mac:${string}`;

/** Another Mac of the person's that can take a chat now. */
export interface OtherMac {
  readonly id: string;
  readonly name: string;
}

/** The repositories and folders a new chat works in: the project's (several), the ticked ones, and what a tick does. */
export interface SourcePick {
  readonly all: ReadonlyArray<ProjectSource>;
  readonly ticked: ReadonlyArray<ProjectSource>;
  readonly onToggle: (name: string) => void;
  /** Ticked ones the chat is started without where it runs now (Cloud takes no folder): by name. */
  readonly leftOut?: ReadonlyArray<string>;
}

/** Cloud as the run-on control draws it: runOnLabel's words, the pill's with what Cloud leaves out. */
export type CloudChoice = ReturnType<typeof runOnLabel>;

/** The runs New chat offers: the task once, twice or four times, each a chat of its own. */
export const RUN_CHOICES = [1, 2, 4] as const;

type Branches = Result<"project.branches">;

export function NewChatBar({
  project,
  base,
  onBase,
  where,
  onWhere,
  computerName,
  macs = [],
  cloud,
  sources,
  runs,
}: {
  /** The project picked in the question; null where a chat starts on no project (a browser window, a chat in Cloud). */
  project: Project | null;
  /** A project with several: which of them the chat works in. Absent for a project with one, and on another Mac. */
  sources?: SourcePick | undefined;
  /** The branch picked to start from; null: the one the checkout is on. */
  base: string | null;
  onBase: (branch: string | null) => void;
  /** Absent where no place can take a chat (a browser window with Cloud off and no Mac on line). */
  where?: Where | undefined;
  onWhere?: ((where: Where) => void) | undefined;
  /** This computer's own row; null in a browser window, which has none. */
  computerName: string | null;
  /** The person's other Macs that can take a chat now, by name. */
  macs?: ReadonlyArray<OtherMac>;
  cloud: CloudChoice;
  /** The task as several chats. Absent: one. */
  runs?: { readonly value: number; readonly onChange: (runs: number) => void } | undefined;
}) {
  return (
    <div
      className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1"
      aria-label="Where the chat starts"
      role="group"
    >
      {/* Where: the place is last, so its swap moves nothing but itself. */}
      <div className="flex min-w-0 flex-wrap items-center gap-x-1 gap-y-1">
        {/* A plain folder has no branches: its chats run in the folder itself. */}
        {project && !project.no_git ? (
          <BranchPicker key={project.id} projectId={project.id} base={base} onBase={onBase} />
        ) : null}
        {sources ? (
          <SourcesMenu {...sources}>
            <FootChip icon={Layers01Icon} aria-label={`Works in ${sourcesLabel(worksIn(sources))}`}>
              <span className="truncate">{sourcesLabel(worksIn(sources))}</span>
            </FootChip>
          </SourcesMenu>
        ) : null}
        {where && onWhere ? (
          <RunOnMenu
            where={where}
            onChange={onWhere}
            computerName={computerName}
            macs={macs}
            cloud={cloud}
          />
        ) : null}
        {/* Setup failed: the pill says so, and this is the way to what failed. A chat still starts. */}
        {where === "cloud" && cloud.failed ? (
          <Button
            asChild
            variant="ghost"
            size="sm"
            className="shrink-0 px-1.5 text-[13px] font-normal text-foreground"
          >
            <Link to="/settings/environments">See why</Link>
          </Button>
        ) : null}
      </div>
      {/* How many: at the row's end, where an open chat's foot keeps its context ring. */}
      {runs ? (
        <div className="ml-auto flex min-w-0 items-center gap-x-1">
          <RunsMenu {...runs} />
        </div>
      ) : null}
    </div>
  );
}

/** The ticked ones the chat works in where it runs. */
const worksIn = (sources: SourcePick) =>
  sources.ticked.filter((s) => !(sources.leftOut ?? []).includes(s.name));

/**
 * project.branches for the open picker (and once at rest, to name the checkout's branch): a query asks again,
 * and an answer to an older query never lands over a newer one. A runtime without it (method_not_found) answers null.
 */
function useBranches(projectId: string, query: string, open: boolean) {
  const { client } = useRuntimeClient();
  const [answer, setAnswer] = useState<Branches | null>(null);
  const [failed, setFailed] = useState(false);
  const asked = useRef(0);
  useEffect(() => {
    if (!client) return;
    const n = ++asked.current;
    const q = query.trim();
    // Typing waits a beat; opening (and the first read) asks at once.
    const timer = setTimeout(
      () =>
        void client
          .call("project.branches", { project_id: projectId, ...(q ? { query: q } : {}) })
          .then(
            (r) => {
              if (n !== asked.current) return;
              setAnswer(r);
              setFailed(false);
            },
            () => n === asked.current && setFailed(true),
          ),
      q ? 120 : 0,
    );
    return () => clearTimeout(timer);
  }, [client, projectId, query, open]);
  return { answer, failed };
}

/** The branch a new chat starts from: the checkout's own until another is picked. */
function BranchPicker({
  projectId,
  base,
  onBase,
}: {
  projectId: string;
  base: string | null;
  onBase: (branch: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  // The branch a chat starts from when none is picked, as the runtime read it last.
  const [checkout, setCheckout] = useState<string | null>(null);
  const { answer, failed } = useBranches(projectId, open ? query : "", open);
  useEffect(() => {
    if (answer?.checkout !== undefined) setCheckout(answer.checkout);
  }, [answer]);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  // A pick hands focus to the message box; only closing without one goes back to the chip.
  const handedOff = useRef(false);
  const uid = useId();
  const [active, setActive] = useState(0);
  const rows = answer?.branches ?? [];
  const chosen = base ?? checkout;
  useEffect(
    () =>
      setActive(
        Math.max(
          0,
          rows.findIndex((b) => b.name === chosen),
        ),
      ),
    [answer],
  );
  useEffect(() => {
    list.current?.querySelector(`[data-row="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  // Nothing to name yet, or a runtime from before project.branches: no chip rather than a wrong one.
  if (chosen === null || (failed && answer === null)) return null;
  const pick = (name: string) => {
    handedOff.current = true;
    setOpen(false);
    // The checkout's own branch is the default: picking it is picking nothing.
    onBase(name === checkout ? null : name);
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (rows.length)
        setActive((i) => (i + (e.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length);
    } else if (e.key === "Enter" && !isComposing(e)) {
      e.preventDefault();
      const row = rows[active];
      if (row) pick(row.name);
    }
  };
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setQuery("");
      }}
    >
      <PopoverTrigger asChild>
        <FootChip
          icon={GitBranchIcon}
          aria-label={`Start from branch ${chosen}`}
          title={
            base ? `Starts from ${base}` : `Starts from ${chosen}, the branch this project is on`
          }
          picked={base !== null}
        >
          <span className="truncate">{chosen}</span>
        </FootChip>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        className="flex max-h-[min(420px,var(--radix-popover-content-available-height))] w-[340px] flex-col overflow-hidden p-0"
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          handedOff.current = false;
          if (!touchScreen()) input.current?.focus();
        }}
        onCloseAutoFocus={(e) => {
          if (handedOff.current) e.preventDefault();
        }}
      >
        {/* The project picker's search row: the lens, a hairline, and the blue line while it has focus. */}
        <div className="relative mx-3 flex h-11 shrink-0 items-center gap-2">
          <input
            ref={input}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKey}
            placeholder="Search branches"
            aria-label="Search branches"
            role="combobox"
            aria-expanded
            aria-controls={`${uid}-list`}
            aria-activedescendant={rows[active] ? `${uid}-${active}` : undefined}
            aria-autocomplete="list"
            spellCheck={false}
            autoComplete="off"
            className="peer order-2 h-full min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground"
          />
          <Icon icon={Search01Icon} className="order-1 size-4 shrink-0 text-muted-foreground" />
          <span
            aria-hidden
            className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-border"
          />
          <span
            aria-hidden
            className="pointer-events-none absolute inset-x-0 bottom-0 h-px origin-center scale-x-0 bg-target transition-transform duration-200 ease-swift peer-focus:scale-x-100"
          />
        </div>
        <div className={cn(menuHeading, "px-3.5")}>Start from</div>
        <div
          ref={list}
          id={`${uid}-list`}
          role="listbox"
          aria-label="Branches"
          onScroll={(e) => fadeEdges(e.currentTarget)}
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-1.5 pb-1.5"
        >
          {rows.length === 0 ? (
            <div className={menuEmpty}>
              {answer === null ? "Reading branches…" : `No branch matches “${query.trim()}”.`}
            </div>
          ) : null}
          {rows.map((b, i) => (
            <div
              key={b.name}
              id={`${uid}-${i}`}
              data-row={i}
              role="option"
              aria-selected={b.name === chosen}
              data-active={i === active || undefined}
              onPointerMove={() => i !== active && setActive(i)}
              onClick={() => pick(b.name)}
              className={cn(
                "flex h-8 cursor-default items-center gap-2 rounded-md px-2 transition-colors duration-75",
                i === active && "bg-accent",
              )}
            >
              <Glyph
                name="branch"
                className={cn(
                  "shrink-0",
                  i === active ? "text-foreground" : "text-muted-foreground",
                )}
              />
              <span className="min-w-0 truncate font-mono text-[12px] text-foreground">
                {b.name}
              </span>
              {b.current ? (
                <span className="shrink-0 text-[12px] text-muted-foreground">checked out</span>
              ) : b.default ? (
                <span className="shrink-0 text-[12px] text-muted-foreground">default</span>
              ) : null}
              {b.name === chosen ? (
                <Icon
                  icon={Tick02Icon}
                  className="ml-auto size-3.5 shrink-0 text-foreground"
                  strokeWidth={2}
                />
              ) : null}
            </div>
          ))}
          {answer?.more ? <div className={menuEmpty}>Type to find more.</div> : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * Which of its project's repositories and folders a new chat works in: every one until the person unticks it, the
 * project's own always (plain text, first: there is nothing to tick). One the chat is started without where it runs
 * (`leftOut`: Cloud takes no folder) shows unticked with the reason beside it, and its tick comes back with the Mac.
 * A tick keeps the menu open (several may change); `children` is its trigger, built like its neighbours.
 * `align`: the edge of the trigger the menu lines up with (a trigger at the end of its row opens toward the start).
 */
export function SourcesMenu({
  all,
  ticked,
  onToggle,
  leftOut = [],
  align = "start",
  children,
}: SourcePick & { align?: "start" | "end"; children: ReactElement }) {
  const [own, ...others] = all;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent side="top" align={align} className="w-[300px]">
        <DropdownMenuLabel>Works in</DropdownMenuLabel>
        {own ? (
          // The project's own: always in. Its name sits under the others' names, past their ticks.
          <div className="flex h-8 items-center gap-2 px-2 text-[13px] text-foreground">
            <span aria-hidden className="size-4 shrink-0" />
            {own.name}
            <span className={menuDescription}>{sourceLine(own)}</span>
          </div>
        ) : null}
        {others.map((s) => {
          const stays = leftOut.includes(s.name);
          return (
            <DropdownMenuCheckboxItem
              key={s.name}
              checked={!stays && ticked.some((t) => t.name === s.name)}
              disabled={stays}
              onSelect={(e) => e.preventDefault()}
              onCheckedChange={() => onToggle(s.name)}
              // A row that cannot be ticked keeps its contrast: grey words, never faded ones.
              className={stays ? "text-muted-foreground data-[disabled]:opacity-100" : undefined}
            >
              {s.name}
              <span className={menuDescription}>
                {stays ? `${sourceLine(s)} · stays on ${thisComputer}` : sourceLine(s)}
              </span>
            </DropdownMenuCheckboxItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Where the chat runs: this computer, another Mac of the person's by its name, or Cloud. The rows are bare: a place
 * needs no explaining. Cloud's setup shows on the pill once Cloud is picked ("Cloud · setting up 3/5"); a Cloud that
 * cannot be picked is drawn as its reason, in grey that still reads.
 */
function RunOnMenu({
  where,
  onChange,
  computerName,
  macs,
  cloud,
}: {
  where: Where;
  onChange: (where: Where) => void;
  computerName: string | null;
  macs: ReadonlyArray<OtherMac>;
  cloud: CloudChoice;
}) {
  const handedOff = useRef(false);
  const choose = (next: Where) => {
    handedOff.current = true;
    onChange(next);
  };
  const mac = where.startsWith("mac:") ? macs.find((m) => `mac:${m.id}` === where) : undefined;
  const label = where === "cloud" ? cloud.chip : (mac?.name ?? computerName ?? "");
  // The place a chat runs when nothing is picked: this computer, or Cloud in a browser window.
  const usual: Where = computerName === null ? "cloud" : "this_mac";
  const tick = (
    <Icon icon={Tick02Icon} className="ml-auto size-3.5 text-foreground" strokeWidth={2} />
  );
  const cloudRow =
    cloud.disabled !== undefined ? (
      // The reason is the row: grey that passes contrast, not a faded label with a tooltip.
      <DropdownMenuItem disabled className="text-muted-foreground data-[disabled]:opacity-100">
        <Glyph name={COMPUTER_KIND_ICON.caveman_cloud ?? "computer-cloud"} />
        {cloud.disabled}
      </DropdownMenuItem>
    ) : (
      <DropdownMenuItem onSelect={() => choose("cloud")}>
        <Glyph name={COMPUTER_KIND_ICON.caveman_cloud ?? "computer-cloud"} />
        Cloud
        {where === "cloud" ? tick : null}
      </DropdownMenuItem>
    );
  // The usual place leads: this computer, or in a browser window Cloud while it can be picked.
  const cloudFirst = usual === "cloud" && cloud.disabled === undefined;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <PlaceChip
          place={{
            id: where,
            name: label,
            icon: CHROME_ICON[where === "cloud" ? "computer-cloud" : "computer-this-mac"],
            high: where === "cloud",
          }}
          aria-label={where === "cloud" ? `Runs in ${cloud.chip}` : `Runs on ${label}`}
          picked={where !== usual}
        >
          {where === "cloud" && cloud.tone === "busy" ? <Dot tone="busy" /> : null}
        </PlaceChip>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="top"
        align="start"
        className="w-auto min-w-[200px] max-w-[340px]"
        onCloseAutoFocus={(e) => {
          if (handedOff.current) e.preventDefault();
          handedOff.current = false;
        }}
      >
        {cloudFirst ? cloudRow : null}
        {computerName !== null ? (
          <DropdownMenuItem onSelect={() => choose("this_mac")}>
            <Glyph name={COMPUTER_KIND_ICON.this_mac ?? "computer-vpc"} />
            {computerName}
            {where === "this_mac" ? tick : null}
          </DropdownMenuItem>
        ) : null}
        {macs.map((m) => (
          <DropdownMenuItem key={m.id} onSelect={() => choose(`mac:${m.id}`)}>
            <Glyph name={COMPUTER_KIND_ICON.this_mac ?? "computer-vpc"} />
            <span className="truncate">{m.name}</span>
            {where === `mac:${m.id}` ? tick : null}
          </DropdownMenuItem>
        ))}
        {cloudFirst ? null : cloudRow}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The repositories Cloud sees for the person, and the one a chat in Cloud starts on. */
export interface RepoPick {
  readonly all: ReadonlyArray<string>;
  readonly value: string | null;
  readonly onChange: (repo: string) => void;
  /** Where another repository is connected (Cloud's own page). */
  readonly connect: string;
}

/**
 * The repository a chat in Cloud starts on, from a browser window: Cloud's own list, by owner/name, and the way to
 * connect another. `children` is its trigger: the name in the question over the box, as a project's is.
 */
export function RepoMenu({
  all,
  value,
  onChange,
  connect,
  children,
}: RepoPick & { children: ReactElement }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="max-h-[min(420px,var(--radix-dropdown-menu-content-available-height))] w-auto min-w-[240px] max-w-[340px] overflow-y-auto"
      >
        <DropdownMenuLabel>Repository</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={value ?? ""} onValueChange={onChange}>
          {all.map((r) => (
            <DropdownMenuRadioItem key={r} value={r}>
              <span className="truncate">{r}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuItem asChild className="text-muted-foreground">
          <a href={connect} target="_blank" rel="noreferrer">
            Connect another repository
          </a>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The task as several chats: once, twice or four times. The chip says the count; its rows say what they are. */
function RunsMenu({ value, onChange }: { value: number; onChange: (runs: number) => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <FootChip
          aria-label={`Runs: ${value}`}
          picked={value > 1}
          className="shrink-0 tabular-nums"
        >
          ×{value}
        </FootChip>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="min-w-[140px]">
        <DropdownMenuRadioGroup
          value={String(value)}
          onValueChange={(next) => onChange(Number(next))}
        >
          {RUN_CHOICES.map((n) => (
            <DropdownMenuRadioItem key={n} value={String(n)}>
              {n === 1 ? "1 run" : `${n} runs`}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
