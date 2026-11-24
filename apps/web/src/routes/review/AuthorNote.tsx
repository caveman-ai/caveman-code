// What the author says: the pull request's description, signed with their avatar and drawn the way the host drew it
// (folds, screenshots, videos, checklists; template comments gone). A hairline runs from the avatar down their words,
// so a long description still reads as theirs and never as Caveman's guide. Three places: while the guide is being
// written it is the page (`open`); on a short change it sits above the diff, held lower (`brief`); under a tour it
// folds to one line quoting its opening, a click away (`folded`). A long one is held to a height, the rest a press away.
import type { PrActor } from "@caveman-app/session-protocol";
import { githubMarkdownLinks } from "@caveman-app/shared/githubMarkdownLinks";
import { Button } from "@caveman-app/ui/components/button";
import { Icon, ArrowRight01Icon } from "@caveman-app/ui/icons/huge";
import { cn } from "@caveman-app/ui/lib/cn";
import { Markdown, markdownLead } from "@caveman-app/ui/markdown/Markdown";
import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { onGithub, readableBody } from "./model.ts";
import { Avatar } from "./parts.tsx";

interface Authored {
  readonly url: string;
  readonly body: string;
  readonly author?: PrActor | undefined;
}

/** Markdown written on the pull request's host (its description, a comment), drawn the way the host draws it. */
export function HostText({ source, url, className }: { source: string; url: string; className?: string | undefined }) {
  const github = onGithub(url);
  const text = useMemo(() => githubMarkdownLinks(source.replace(/\r\n?/g, "\n"), github ? url : null), [source, url, github]);
  return <Markdown source={text} hosted={{ breaks: github }} className={className} />;
}

// A description's headings are its sections (Summary, Test plan), not titles: one step above the text, never louder.
// Prose keeps a reading measure; tables, screenshots and folds take the column.
const PROSE = cn(
  "text-[14px] leading-[1.65]",
  "[&_h1]:mb-1.5 [&_h1]:mt-6 [&_h1]:text-[15px] [&_h1]:tracking-normal [&_h2]:mb-1.5 [&_h2]:mt-6 [&_h2]:text-[15px]",
  "[&_h3]:mb-1 [&_h3]:mt-5 [&_h3]:text-[14px] [&_h4]:text-[13.5px] [&_h5]:text-[13.5px] [&_h6]:text-[13.5px]",
  "[&_li]:max-w-[68ch] [&_p]:max-w-[68ch]",
);

/** How tall a description may stand before the rest folds behind "Show the rest", by place. */
const HOLD = { open: 560, brief: 220 } as const;

export function AuthorNote({ pr, mode, className }: { pr: Authored; mode: "open" | "brief" | "folded"; className?: string | undefined }) {
  const [shown, setShown] = useState(mode !== "folded");
  const lead = useMemo(() => (mode === "folded" ? markdownLead(readableBody(pr.body)) : ""), [mode, pr.body]);
  const { name, bot } = who(pr.author);
  // Only a template's comments, or nothing at all: said plainly, except under a tour, where silence costs nothing.
  if (!readableBody(pr.body)) {
    if (mode === "folded") return null;
    return (
      <Signed author={pr.author} name={name} bot={bot} className={className}>
        <span className="text-muted-foreground">wrote no description.</span>
      </Signed>
    );
  }
  const body = (
    <div className="ml-[10.5px] mt-1.5 border-l border-border pb-0.5 pl-[20.5px] pt-1">
      {mode === "folded" ? (
        <HostText source={pr.body} url={pr.url} className={PROSE} />
      ) : (
        <Held max={HOLD[mode]}>
          <HostText source={pr.body} url={pr.url} className={PROSE} />
        </Held>
      )}
    </div>
  );
  if (mode !== "folded")
    return (
      <section data-passage={`${name}'s description`} aria-label={`${name}'s description`} className={cn("max-w-[720px]", className)}>
        <Signed author={pr.author} name={name} bot={bot}>
          <span className="text-muted-foreground">wrote</span>
        </Signed>
        {body}
      </section>
    );
  return (
    <section data-passage={`${name}'s description`} className={cn("max-w-[720px]", className)}>
      <button
        type="button"
        onClick={() => setShown(!shown)}
        aria-expanded={shown}
        className="group -mx-1.5 flex w-[calc(100%+12px)] min-w-0 items-center gap-2.5 rounded-lg px-1.5 py-1 text-left text-[13px] outline-none transition-colors duration-75 hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Avatar actor={pr.author} size={22} />
        <span className="shrink-0 font-semibold text-foreground">{name}</span>
        {bot ? <BotTag /> : null}
        <span className="shrink-0 text-muted-foreground">wrote</span>
        <span className="min-w-0 flex-1 truncate text-[hsl(var(--subtle-foreground))]">{shown || !lead ? "" : `“${lead}”`}</span>
        <Icon icon={ArrowRight01Icon} className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform duration-150 group-hover:text-foreground motion-reduce:transition-none", shown && "rotate-90")} />
      </button>
      {shown ? body : null}
    </section>
  );
}

/** The author, named the way people say it: an app's `[bot]` suffix or `app/` prefix (gh's) gone, a quiet tag instead. */
function who(author: PrActor | undefined): { name: string; bot: boolean } {
  const login = author?.login ?? "The author";
  const bot = Boolean(author?.bot) || /\[bot\]$|^app\//.test(login);
  return { name: login.replace(/\[bot\]$/, "").replace(/^app\//, ""), bot };
}

function Signed({ author, name, bot, className, children }: { author: PrActor | undefined; name: string; bot: boolean; className?: string | undefined; children: ReactNode }) {
  return (
    <div className={cn("flex min-w-0 items-center gap-2.5 text-[13px]", className)}>
      <Avatar actor={author} size={22} />
      <span className="font-semibold text-foreground">{name}</span>
      {bot ? <BotTag /> : null}
      {children}
    </div>
  );
}

function BotTag() {
  return <span className="shrink-0 rounded-[4px] px-1 text-[11px] leading-4 text-muted-foreground ring-1 ring-inset ring-border">bot</span>;
}

/**
 * A description held to `max` px, fading out, with the rest a press away. Only when the rest is worth a press (more
 * than a few lines past the hold); the held box never grows as its screenshots load, so nothing below it moves.
 * Focus landing in the hidden part (Tab onto a link there) lets it all out.
 */
function Held({ max, children }: { max: number; children: ReactNode }) {
  const inner = useRef<HTMLDivElement>(null);
  const [over, setOver] = useState(false);
  const [all, setAll] = useState(false);
  useLayoutEffect(() => {
    const el = inner.current;
    if (!el || all) return;
    const check = () => setOver(el.offsetHeight > max + 120);
    check();
    const observer = new ResizeObserver(check);
    observer.observe(el);
    return () => observer.disconnect();
  }, [max, all]);
  const held = over && !all;
  return (
    <>
      <div
        className={cn("relative", held && "overflow-hidden")}
        style={held ? { maxHeight: max } : undefined}
        onFocus={(e) => {
          if (held && e.target.getBoundingClientRect().bottom > e.currentTarget.getBoundingClientRect().top + max) setAll(true);
        }}
      >
        <div ref={inner}>{children}</div>
        {held ? <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-20 bg-gradient-to-b from-transparent to-background" /> : null}
      </div>
      {held ? (
        <Button size="sm" variant="secondary" className="mt-2" onClick={() => setAll(true)}>
          Show the rest
        </Button>
      ) : null}
    </>
  );
}
