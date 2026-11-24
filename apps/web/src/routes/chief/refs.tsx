// What the Chief names in its replies, drawn in place (Transcript's inlineRefs): [[12]] is a piece of work on its
// board, its current title in the blue with the mark of where it stands in front (styles.css .work-link); #1415, a
// pull request of its chats, is its review guide, with a document's mark. Part of the sentence, never a box. Each
// link reads the board and the chats itself, so an old reply still says where its work stands now. A click opens
// it: the work's chat in a tab of its own, the guide in the Chief's panel.
import { Icon, FileTextIcon } from "@caveman-app/ui/icons/huge";
import { useNavigate } from "react-router";
import type { InlineRefs } from "../../components/Transcript.tsx";
import { openSurface } from "../../panels/store.ts";
import { windowTabs } from "../../panes/store.ts";
import { useChief } from "../../state/chief.ts";
import type { WorkspaceView } from "../../state/model.ts";
import { useRuntimeSelector } from "../../state/runtime.tsx";
import { chatByRef, groupOf, itemByRef, workId, workTitle, WORK_REF_PATTERN, type WorkGroup } from "./work-model.ts";
import { WorkShowing } from "./showing.tsx";
import { shownIn } from "./showing-model.ts";
import { WorkMark } from "./work.tsx";

interface RefsContext {
  /** The prefix its numbers show with (CH). */
  readonly prefix: string;
  /** The Chief's side panel, where the Work tab and guides open. */
  readonly panel: string;
  readonly chiefId: string | undefined;
  /** Chats whose result card is in the conversation: their screenshots and preview show there, not under a reply. */
  readonly carded?: ReadonlySet<string>;
}

/** [[12]] and #1415, for the Chief's transcript. */
export function chiefRefs(ctx: RefsContext): InlineRefs {
  return {
    pattern: new RegExp(`${WORK_REF_PATTERN.source}|(?<![\\w#/])#\\d{2,6}\\b`),
    render: (ref) => (ref.startsWith("#") ? <PrRef number={Number(ref.slice(1))} {...ctx} /> : <WorkRef raw={ref} {...ctx} />),
    after: (text, at) => <NamedWorkShowing text={text} at={at} {...ctx} />,
  };
}

/** Under a reply: the screenshots and preview chips of the work it names, as they were when it was written. */
function NamedWorkShowing({ text, at, panel, chiefId, carded }: RefsContext & { text: string; at: string }) {
  const { items } = useChief(chiefId);
  const workspaces = useRuntimeSelector((v) => v.workspaces);
  return <WorkShowing shown={shownIn(text, at, items, workspaces, carded)} chiefWorkspaceId={panel} />;
}

/** The mark sits on the text's middle, a touch smaller than the line. */
const MARK = "mr-1 inline-block size-3.5 -translate-y-px align-middle";

const CHAT_GROUP: Record<WorkspaceView["state"], WorkGroup> = { working: "working", queued: "queued", needs_input: "needs", failed: "needs", completed: "done", archived: "done" };

/** One chat of the Chief's work: the mark of where it stands now and its title in the blue; a click opens it in a tab of its own. */
export function ChatLink({ chat }: { chat: WorkspaceView }) {
  const navigate = useNavigate();
  return (
    <a href={`#/w/${chat.id}`} title={chat.title} className="work-link" onClick={(e) => { e.preventDefault(); navigate(windowTabs.openChat(chat.id)); }}>
      <WorkMark group={CHAT_GROUP[chat.state]} className={MARK} />{chat.title}
    </a>
  );
}

function WorkRef({ raw, prefix, panel, chiefId }: RefsContext & { raw: string }) {
  const navigate = useNavigate();
  const { items } = useChief(chiefId);
  const workspaces = useRuntimeSelector((v) => v.workspaces);
  const chat = chatByRef(raw, items, workspaces);
  const item = itemByRef(raw, items);
  if (chat) return <ChatLink chat={chat} />;
  // Off the board (finished more than a day ago): its number alone, quiet.
  if (!item)
    return (
      <span className="work-link work-link-quiet" title="No longer on the board">
        {/\[\[\d+\]\]/.test(raw) ? `${prefix}-${raw.slice(2, -2)}` : "Work no longer available"}
      </span>
    );
  const chats = item.workspace_ids.filter((id) => workspaces.some((w) => w.id === id));
  const open = () => {
    // One chat: it opens in a tab of its own. Several, or none yet: the Work tab shows them.
    if (chats.length === 1) navigate(windowTabs.openChat(chats[0]!));
    else openSurface(panel, "chief-work", { chief_id: chiefId });
  };
  return (
    <a
      href={chats.length === 1 ? `#/w/${chats[0]}` : undefined}
      title={`${workId(prefix, item) ?? ""} ${workTitle(item)}`.trim()}
      tabIndex={0}
      onClick={(e) => {
        e.preventDefault();
        open();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") open();
      }}
      className="work-link"
    >
      <WorkMark group={groupOf(item) ?? "done"} className={MARK} />
      {workTitle(item)}
    </a>
  );
}

function PrRef({ number, panel }: RefsContext & { number: number }) {
  const workspaces = useRuntimeSelector((v) => v.workspaces);
  const chat = workspaces.find((w) => w.pullRequest?.number === number && w.projectId);
  // Not one of its chats' pull requests: the words as written.
  if (!chat?.projectId) return <span>#{number}</span>;
  const projectId = chat.projectId;
  return (
    <a
      href={chat.pullRequest!.url}
      title={`The review guide for #${number}`}
      onClick={(e) => {
        e.preventDefault();
        openSurface(panel, "pr", { project_id: projectId, number });
      }}
      className="work-link"
    >
      <Icon icon={FileTextIcon} className={MARK} />#{number}
    </a>
  );
}
