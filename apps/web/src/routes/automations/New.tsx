// New automation: a floating chatbox over the page. Its name on top, what it should do under it, and one row of quick
// choices at its foot (the project, when it runs, the model, what it may touch, whose it is), then Create, which
// writes the file. Build with agent hands the words to a chat that writes the file with you; Use template picks one
// of the examples, shown in the same box with its own Create. Opened by `?new` on any Automations page
// (`?new=template` opens the examples); what is typed stays while the app runs, so closing it loses nothing.
import type { AutomationTemplateSummary } from "@caveman-app/session-protocol";
import { Button } from "@caveman-app/ui/components/button";
import { clickOrigin } from "@caveman-app/ui/components/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@caveman-app/ui/components/dropdown-menu";
import { menuDescription } from "@caveman-app/ui/components/menu";
import type { PixelIconName } from "@caveman-app/ui/icons/names";
import { cn } from "@caveman-app/ui/lib/cn";
import { Icon, ArrowDown01Icon, Cancel01Icon } from "@caveman-app/ui/icons/huge";
import { modalMotion, overlayMotion } from "@caveman-app/ui/motion";
import * as Dialog from "@radix-ui/react-dialog";
import { forwardRef, useRef, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router";
import { ProjectBadge, ProjectPicker, useLastProject } from "../../components/ProjectPicker.tsx";
import { isComposing, keysText } from "../../panels/chrome.tsx";
import { useRuntimeSelector } from "../../state/runtime.tsx";
import { useActions } from "./actions.tsx";
import { useTemplates } from "./data.ts";
import { BLANK_DRAFT, draftText, GITHUB, localDay, modelWord, PRESET, presetOf, presetSchedule, whenWord, type Computer, type GitHubChoice, type NewDraft, type Preset, type When } from "./draft.ts";
import { CLASS_HINT, TIMES } from "./Form.tsx";
import { chipMark, TriggerMark } from "./marks.tsx";
import { budgetWord, clockWord, dateWord, isCloudTemplate, NAME, slug, TEMPLATE_ORDER, type Scope } from "./model.ts";
import { Glyph } from "@caveman-app/ui/icons/Glyph";

// ------------------------------------------------------------ what is typed

/** What was typed, kept while the app runs: closing the box loses nothing; Create and Build with agent clear it. */
let kept: NewDraft = BLANK_DRAFT;

// ------------------------------------------------------------ the words for each choice

const CHECKOUT: Record<Computer, { chip: string; label: string; hint: string; icon: PixelIconName }> = {
  readonly: { chip: "Read-only", label: "Read-only copy", hint: "Reads, never changes", icon: "tool-read" },
  full: { chip: "Own branch", label: "Its own branch", hint: "Commits what it changes", icon: "branch" },
  none: { chip: "No repo", label: "No repo", hint: "For work on the web or in your tools", icon: "tool-web" },
};

const WHOSE: Record<Scope, { chip: string; label: string; hint: string; icon: PixelIconName }> = {
  me: { chip: "Just me", label: "Just me", hint: "Kept out of git, live at once", icon: "account" },
  project: { chip: "Everyone", label: "Everyone on the repo", hint: "Shared in git, live once merged", icon: "repo" },
};

// ------------------------------------------------------------ opening it

/** Opens the box over whatever Automations page is showing; `template` opens straight onto the examples. */
export function useNewAutomation() {
  const [params, setParams] = useSearchParams();
  return (mode: "blank" | "template" = "blank") => {
    const next = new URLSearchParams(params);
    next.set("new", mode === "template" ? "template" : "1");
    setParams(next);
  };
}

export function NewAutomation() {
  const [params, setParams] = useSearchParams();
  const mode = params.get("new");
  const close = () => {
    const next = new URLSearchParams(params);
    next.delete("new");
    setParams(next, { replace: true });
  };
  return (
    <Dialog.Root open={mode !== null} onOpenChange={(open) => !open && close()}>
      <Dialog.Portal>
        <Dialog.Overlay className={`fixed inset-0 z-40 bg-black/50 ${overlayMotion}`} />
        {mode !== null ? <Box key="box" startOnTemplates={mode === "template"} onClose={close} /> : null}
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// ------------------------------------------------------------ the box

function Box({ startOnTemplates, onClose }: { startOnTemplates: boolean; onClose: () => void }) {
  const actions = useActions();
  const projects = useRuntimeSelector((v) => v.projects);
  const last = useLastProject({ inUrl: false });
  const [draft, setDraftState] = useState(kept);
  const setDraft = (next: Partial<NewDraft>) => setDraftState((d) => (kept = { ...d, ...next }));
  const [picked, setPicked] = useState<string | null>(null);
  const projectId = picked ?? last.project?.id ?? null;
  const project = projects.find((p) => p.id === projectId) ?? null;
  const [template, setTemplate] = useState<AutomationTemplateSummary | null>(null);
  const [menu, setMenu] = useState(startOnTemplates);
  const [busy, setBusy] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);
  const createRef = useRef<HTMLButtonElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  // A Cloud template's files run from the repo, so it is always the project's.
  const scope: Scope = template && isCloudTemplate(template) ? "project" : draft.scope;

  const name = slug(draft.title);
  const why =
    projectId === null
      ? "Pick a project"
      : template
        ? undefined
        : draft.title.trim() === ""
          ? "Name it first"
          : !NAME.test(name)
            ? "Use letters in the name"
            : draft.prompt.trim() === ""
              ? "Say what it should do"
              : undefined;

  const create = async () => {
    if (why || !projectId || busy) return;
    setBusy(true);
    if (template) {
      await actions.fromTemplate(template, scope, projectId);
    } else if (await actions.createFile(name, draftText(draft), scope, projectId)) {
      kept = BLANK_DRAFT;
    }
    setBusy(false);
  };

  const buildWithAgent = () => {
    const words = draft.prompt.trim();
    kept = BLANK_DRAFT;
    actions.describe(projectId, words ? `does this: ${words}` : "");
  };

  return (
    <Dialog.Content
      aria-describedby={undefined}
      ref={clickOrigin}
      onOpenAutoFocus={(e) => {
        e.preventDefault();
        if (!startOnTemplates) (draft.title ? promptRef : titleRef).current?.focus();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          void create();
        }
      }}
      className={cn(
        "dashboard-scope fixed inset-x-0 top-[16vh] z-50 mx-auto flex w-[min(760px,calc(100vw-32px))] flex-col rounded-xl border border-border bg-popover text-popover-foreground shadow-overlay outline-none dark:border-input",
        modalMotion,
      )}
    >
      <Dialog.Title className="sr-only">{template ? template.title : "New automation"}</Dialog.Title>
      <div className="flex items-start gap-2 pl-5 pr-3 pt-3.5">
        {template ? (
          <h2 className="min-w-0 flex-1 truncate pt-0.5 text-[18px] font-medium leading-7 text-foreground">{template.title}</h2>
        ) : (
          <input
            ref={titleRef}
            value={draft.title}
            onChange={(e) => setDraft({ title: e.target.value })}
            onKeyDown={(e) => e.key === "Enter" && !e.metaKey && !e.ctrlKey && !isComposing(e) && (e.preventDefault(), promptRef.current?.focus())}
            placeholder="Automation title"
            aria-label="Name"
            className="min-w-0 flex-1 bg-transparent pt-0.5 text-[18px] font-medium leading-7 text-foreground outline-none placeholder:text-[hsl(var(--subtle-foreground))]"
          />
        )}
        <Button variant="secondary" size="sm" onClick={buildWithAgent} title="A chat in the project writes the file with you and checks it">
          <Glyph name="engine-caveman" className="size-3.5" />
          Build with agent
        </Button>
        <TemplateMenu
          open={menu}
          onOpenChange={setMenu}
          onPick={(t) => {
            setTemplate(t);
            if (isCloudTemplate(t)) setDraft({ scope: "project" });
          }}
          onPicked={() => createRef.current?.focus()}
          onFind={() => void actions.suggest(projectId)}
        />
        <Dialog.Close className="ml-1 grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground outline-none transition-colors duration-75 hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
          <Icon icon={Cancel01Icon} className="size-4" />
          <span className="sr-only">Close</span>
        </Dialog.Close>
      </div>

      {template ? (
        <TemplateView template={template} scope={scope} />
      ) : (
        <textarea
          ref={promptRef}
          value={draft.prompt}
          onChange={(e) => setDraft({ prompt: e.target.value })}
          placeholder="Tell it what to do, e.g. read new issues and label each one by area"
          aria-label="What it should do"
          className="mx-5 mt-2 block max-h-[44vh] min-h-[176px] resize-none bg-transparent text-[14px] leading-[22px] text-foreground outline-none [field-sizing:content] placeholder:text-[hsl(var(--subtle-foreground))]"
        />
      )}

      <div className="flex items-center gap-0.5 whitespace-nowrap px-3 pb-3 pt-2">
        <ProjectPicker value={projectId} onChange={setPicked}>
          <Chip aria-label={`Project: ${project?.name ?? "none"}`} className="min-w-0 shrink">
            {project ? <ProjectBadge github={project.repository?.host === "github.com"} /> : <Glyph name="folder" />}
            <span className="max-w-[160px] truncate">{project?.name ?? "Choose a project"}</span>
          </Chip>
        </ProjectPicker>
        {template ? null : (
          <>
            <WhenMenu when={draft.when} github={project?.repository?.host === "github.com"} onChange={(when) => setDraft({ when })} />
            <ModelMenu value={draft.model} onChange={(model) => setDraft({ model })} />
            <Choice label="What it may touch" value={draft.computer} options={CHECKOUT} order={["readonly", "full", "none"]} onChange={(computer) => setDraft({ computer })} />
          </>
        )}
        {template && isCloudTemplate(template) ? null : <Choice label="Whose it is" value={scope} options={WHOSE} order={["me", "project"]} onChange={(s) => setDraft({ scope: s })} />}
        <span className="ml-auto" />
        {template ? (
          <Button variant="ghost" onClick={() => setTemplate(null)}>
            Back
          </Button>
        ) : null}
        <Button ref={createRef} className="ml-1" onClick={() => void create()} disabled={why !== undefined || busy} title={why ?? `Create (${keysText("⌘↩", "mod+enter")})`}>
          {busy ? "Creating…" : "Create"}
        </Button>
      </div>
    </Dialog.Content>
  );
}

// ------------------------------------------------------------ the quick choices

/** The composer's own chip (its permissions and model pickers): grey words, lit while its menu is open. */
const CHIP =
  "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md pl-1.5 pr-2 text-[13px] text-muted-foreground outline-none transition-colors duration-75 hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-accent data-[state=open]:text-foreground";

const Chip = forwardRef<HTMLButtonElement, React.ButtonHTMLAttributes<HTMLButtonElement>>(function Chip({ children, className, ...rest }, ref) {
  return (
    <button ref={ref} type="button" className={cn(CHIP, className)} {...rest}>
      {children}
      <Icon icon={ArrowDown01Icon} className="size-3.5 shrink-0 opacity-70" />
    </button>
  );
});

const MENU = { align: "start", sideOffset: 8 } as const;

/** When it runs: a schedule (and its time), something on GitHub, or only by hand. */
function WhenMenu({ when, github, onChange }: { when: When; github: boolean; onChange: (w: When) => void }) {
  const s = when.kind === "schedule" ? when.schedule : null;
  const at = s?.at ?? s?.once?.slice(11) ?? "09:00";
  const value = s ? presetOf(s) : when.kind === "github" ? `github:${when.event}` : "manual";
  const pick = (v: string) => {
    if (v === "manual") return onChange({ kind: "manual" });
    if (v.startsWith("github:")) return onChange({ kind: "github", event: v.slice(7) as GitHubChoice });
    onChange({ kind: "schedule", schedule: presetSchedule(v as Preset, at) });
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Chip aria-label={`When it runs: ${whenWord(when)}`}>
          <span aria-hidden className="contents">
            <TriggerMark mark={when.kind === "github" ? "github" : when.kind === "schedule" ? "schedule" : "manual"} className="size-4" />
          </span>
          {whenWord(when)}
        </Chip>
      </DropdownMenuTrigger>
      <DropdownMenuContent {...MENU} className="w-[280px]">
        <DropdownMenuRadioGroup value={value} onValueChange={pick}>
          <DropdownMenuLabel>On a schedule</DropdownMenuLabel>
          {(Object.keys(PRESET) as Preset[]).map((p) => (
            <DropdownMenuRadioItem key={p} value={p}>
              {PRESET[p].label}
            </DropdownMenuRadioItem>
          ))}
          {s?.at ? <TimeSub value={at} onChange={(next) => onChange({ kind: "schedule", schedule: { ...s, at: next } })} /> : null}
          {s?.once ? (
            <>
              <DateSub value={s.once.slice(0, 10)} onChange={(day) => onChange({ kind: "schedule", schedule: { ...s, once: `${day} ${at}` } })} />
              <TimeSub value={at} onChange={(next) => onChange({ kind: "schedule", schedule: { ...s, once: `${s.once!.slice(0, 10)} ${next}` } })} />
            </>
          ) : null}
          <DropdownMenuSeparator />
          <DropdownMenuLabel>{github ? "When on GitHub" : "When on GitHub (needs a GitHub repo)"}</DropdownMenuLabel>
          {(Object.keys(GITHUB) as GitHubChoice[]).map((g) => (
            <DropdownMenuRadioItem key={g} value={`github:${g}`} disabled={!github}>
              {GITHUB[g].label}
            </DropdownMenuRadioItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuRadioItem value="manual">
            <span className="shrink-0">By hand only</span>
            <span className={menuDescription}>Run now starts it</span>
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The time of day, a submenu of half hours that opens on the one it holds. */
function TimeSub({ value, onChange }: { value: string; onChange: (at: string) => void }) {
  const times = TIMES.includes(value) ? TIMES : [...TIMES, value].sort();
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <span className="shrink-0">At</span>
        <span className="tabular-nums text-muted-foreground">{clockWord(value)}</span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent
        ref={(el) => {
          if (el) requestAnimationFrame(() => el.querySelector<HTMLElement>("[data-state=checked]")?.scrollIntoView({ block: "center" }));
        }}
        className="max-h-[288px] w-[132px]"
      >
        <DropdownMenuRadioGroup value={value} onValueChange={onChange}>
          {times.map((t) => (
            <DropdownMenuRadioItem key={t} value={t} className="tabular-nums">
              {clockWord(t)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

/** The day a once runs: the next five weeks, today first. Any other day is set in the form. */
function DateSub({ value, onChange }: { value: string; onChange: (day: string) => void }) {
  const now = new Date();
  const days = Array.from({ length: 35 }, (_, i) => localDay(now, i));
  const list = days.includes(value) ? days : [value, ...days];
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <span className="shrink-0">On</span>
        <span className="tabular-nums text-muted-foreground">{dateWord(value)}</span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent
        ref={(el) => {
          if (el) requestAnimationFrame(() => el.querySelector<HTMLElement>("[data-state=checked]")?.scrollIntoView({ block: "center" }));
        }}
        className="max-h-[288px] w-[180px]"
      >
        <DropdownMenuRadioGroup value={value} onValueChange={onChange}>
          {list.map((d) => (
            <DropdownMenuRadioItem key={d} value={d} className="tabular-nums">
              {d === days[0] ? "Today" : d === days[1] ? "Tomorrow" : dateWord(d)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

/** The model class the step asks for; each becomes the model set for it, on whichever engine runs it. */
function ModelMenu({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Chip aria-label={`Model: ${modelWord(value)}`}>
          <Glyph name="engine-caveman" />
          {modelWord(value)}
        </Chip>
      </DropdownMenuTrigger>
      <DropdownMenuContent {...MENU} className="w-[300px]">
        <DropdownMenuRadioGroup value={value} onValueChange={onChange}>
          {Object.entries(CLASS_HINT).map(([cls, hint]) => (
            <DropdownMenuRadioItem key={cls} value={cls}>
              <span className="shrink-0">{modelWord(cls)}</span>
              <span className={menuDescription}>{hint}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A one-of choice with an icon, a short word on the chip, and a line on each option in its menu. */
function Choice<K extends string>({ label, value, options, order, onChange }: {
  label: string;
  value: K;
  options: Record<K, { chip: string; label: string; hint: string; icon: PixelIconName }>;
  order: ReadonlyArray<K>;
  onChange: (v: K) => void;
}) {
  const now = options[value];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Chip aria-label={`${label}: ${now.label}`}>
          <Glyph name={now.icon} />
          {now.chip}
        </Chip>
      </DropdownMenuTrigger>
      <DropdownMenuContent {...MENU} className="w-[360px]">
        <DropdownMenuLabel>{label}</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={value} onValueChange={(v) => onChange(v as K)}>
          {order.map((k) => (
            <DropdownMenuRadioItem key={k} value={k}>
              <Glyph name={options[k].icon} />
              <span className="shrink-0">{options[k].label}</span>
              <span className={menuDescription}>{options[k].hint}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ------------------------------------------------------------ templates

/** Use template: every example, by category, each with its line; and the scout that finds chores in your chats. */
function TemplateMenu({ open, onOpenChange, onPick, onPicked, onFind }: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onPick: (t: AutomationTemplateSummary) => void;
  /** After the menu closes on a pick: focus goes on to Create, not back to Use template. */
  onPicked: () => void;
  onFind: () => void;
}) {
  const templates = useTemplates();
  const picked = useRef(false);
  const list = templates.value ?? [];
  const groups = TEMPLATE_ORDER.map((c) => ({ category: c, items: list.filter((t) => t.category === c) })).filter((g) => g.items.length > 0);
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button variant="secondary" size="sm">
          Use template
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        sideOffset={8}
        className="w-[420px]"
        onCloseAutoFocus={(e) => {
          if (!picked.current) return;
          picked.current = false;
          e.preventDefault();
          onPicked();
        }}
      >
        {templates.value === undefined ? (
          templates.error ? (
            <p className="px-2 py-2 text-[13px] text-destructive">Couldn't read the templates: {templates.error}</p>
          ) : (
            <p className="px-2 py-2 text-[13px] text-muted-foreground">Reading the templates…</p>
          )
        ) : (
          groups.map((g, i) => (
            <div key={g.category}>
              {i > 0 ? <DropdownMenuSeparator /> : null}
              <DropdownMenuLabel>{g.category}</DropdownMenuLabel>
              {g.items.map((t) => (
                <DropdownMenuItem key={t.id} onSelect={() => ((picked.current = true), onPick(t))} title={t.summary}>
                  <span aria-hidden className="contents">
                    <TriggerMark mark={chipMark(t.chips)} className="size-4" />
                  </span>
                  <span className="shrink-0">{t.title}</span>
                  <span className={menuDescription}>{t.summary}</span>
                </DropdownMenuItem>
              ))}
            </div>
          ))
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onFind}>
          <Glyph name="engine-caveman" />
          <span className="shrink-0">Find chores in my chats</span>
          <span className={menuDescription}>Caveman drafts some for you</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A template in the box: what it does, then the few facts that decide whether it's the one. */
function TemplateView({ template: t, scope }: { template: AutomationTemplateSummary; scope: Scope }) {
  const chips = t.chips.length > 0 ? t.chips : ["By hand"];
  const paths = t.paths.map((p) => (scope === "me" ? p.replace(".caveman/automations/", ".caveman/local/automations/") : p));
  return (
    <div className="min-h-[176px] px-5 pb-2 pt-2">
      <p className="text-[14px] leading-[22px] text-foreground">{t.summary}</p>
      <dl className="mt-4 grid grid-cols-[96px_minmax(0,1fr)] gap-x-4 gap-y-2 text-[13px]">
        <Fact label="Starts">
          <TriggerMark mark={chipMark(t.chips)} className="size-4" />
          {chips.join(" or ")}
        </Fact>
        <Fact label={t.steps.length === 1 ? "Step" : "Steps"}>{t.steps.map((s) => s.name).join(", then ")}</Fact>
        {isCloudTemplate(t) ? (
          <Fact label="Runs on">
            <Glyph name="computer-cloud" />
            Cloud, once you deploy it
          </Fact>
        ) : null}
        {t.budget !== undefined ? <Fact label="Budget">Up to {budgetWord(t.budget)} a run</Fact> : null}
        <Fact label={paths.length === 1 ? "Writes" : `Writes ${paths.length}`}>
          <span className="min-w-0 truncate font-mono text-[12px] text-muted-foreground" title={paths.join("\n")}>
            {paths.join(", ")}
          </span>
        </Fact>
      </dl>
    </div>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="flex min-w-0 items-center gap-1.5 text-foreground">{children}</dd>
    </>
  );
}
