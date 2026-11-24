// What the shell draws over the whole stack, whatever screen is on top: the sheets any screen can open, the moment
// card where the screen on top lets it float, and the toast. Every sheet is the one anatomy (Sheet.tsx): Search,
// Connect, Profile, Settings and New Chief stand large and opaque from the top; Details, Share to Caveman and the
// pickers (the model, where a new chat runs, Add a project) float medium on glass. Screens open them through shell/ui.ts; nothing here
// belongs to one screen. They all stand on one frame (Sheet.tsx SheetFrame): a sheet opened from another is pushed
// over it, the frame staying up and its head changing in place, and Back comes back to it.
import type { ReactNode } from "react";
import { useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useChoices } from "../board/catalog";
import { deviceById, deviceByLabel, deviceLabel, THIS_MAC } from "../board/model";
import { macReachable, placeOf, settle } from "../board/places";
import * as script from "../board/script";
import { MomentSheet } from "../components/MomentSheet";
import { Toast, type ToastSlot, useBarCentre } from "../components/Toast";
import { showChat, showChief } from "../nav/ref";
import { chatOf, useChat } from "../store/select";
import { useStore } from "../store/store";
import { layout } from "../theme";
import { COMPOSER_HEIGHT } from "./Composer";
import { ConnectSheet } from "./ConnectSheet";
import { DetailsSheet } from "./DetailsSheet";
import { SHEET_MAX, useShell } from "./layout";
import { NewChiefSheet } from "./NewChiefSheet";
import { ProfileSheet } from "./ProfileSheet";
import { SearchSheet } from "./SearchSheet";
import { type Detent, SheetFrame } from "./Sheet";
import { SettingsSheet } from "./SettingsSheet";
import { ShareSheet, useShareInbox } from "./ShareSheet";
import { AddProjectSheet, ModelSheet, settledOn, useChatPick, useDefaultPick, useListed, WhereSheet } from "./Sheets";
import { BAR_HEIGHT } from "./TopBar";
import { closeSheet, dismissSheet, openAddProject, openSettings, popSheet, type SheetName, setPick, setReviewing, setWhere, ui, useUi } from "./ui";

/** The sheets that stand from the top and cover the bar; the toast moves into their head row while they're up. */
const LARGE: ReadonlySet<SheetName> = new Set(["search", "connect", "profile", "settings", "newChief"]);
/** Every sheet the shell holds: each stays drawn, hidden, while it isn't up, so it keeps what it was doing. */
const ALL: readonly SheetName[] = ["model", "where", "addProject", "details", "settings", "search", "profile", "connect", "newChief", "share"];
const detentOf = (name: string): Detent => (LARGE.has(name as SheetName) ? "large" : "medium");

/** One circle and its gap, from the screen's edge: where the bar's middle slot begins. */
const SIDE = layout.inset + layout.float + layout.floatGap;

export function Overlays() {
  const insets = useSafeAreaInsets();
  const sheet = useUi((s) => s.sheet);
  const stack = useUi((s) => s.stack);
  const up = (name: SheetName) => stack.includes(name);
  const done = (name: SheetName) => () => dismissSheet(name);
  const settingsAt = useUi((s) => s.settingsAt);
  const addFrom = useUi((s) => s.addFrom);
  const addQuery = useUi((s) => s.addQuery);
  const where = useUi((s) => s.where);
  const reviewing = useUi((s) => s.reviewing);
  const notice = useUi((s) => s.notice);
  const floating = useUi((s) => s.floating);
  const focused = useUi((s) => s.focused);
  const detailsFor = useUi((s) => s.detailsFor);
  // What another app shares opens Share to Caveman over whatever is up.
  useShareInbox();

  // A chat's picker sets that chat's next turn, harness included; a new chat's sets what it starts on. On the
  // person's own board it lists what the chat's place runs (a new chat's: the place its box names), and while it is
  // open that place is asked for it.
  const fallback = useDefaultPick();
  const ownPick = useUi((s) => s.pick);
  const modelChat = useChat(useUi((s) => s.modelFor));
  const listed = useListed(modelChat ? modelChat.id : null, up("model"));
  const { starts } = useChoices();
  const newPick = settledOn(ownPick ?? fallback, listed, starts);
  const chatPick = useChatPick(modelChat, listed.engines);

  const toast = useStore((s) => s.board.toast);
  const moment = useStore((s) => {
    const id = s.board.momentId;
    const chat = id ? chatOf(s, id) : undefined;
    // An archived chat stays off it while Undo can still bring it back.
    return chat?.phase === "ready" && !s.inbox.archived[chat.id] ? chat : null;
  });
  // The moment no longer floats over a screen as a card (DECISIONS.md: no end-of-run pills over a chat; the toast says
  // a chat is ready and the Ready tile keeps it). It shows only opened for review, from a chat's Changes pill or the
  // Ready list's shelf.
  const momentHere = moment && reviewing ? moment : null;
  const rest = floating?.rest ?? Math.max(insets.bottom, 10) + COMPOSER_HEIGHT + 12;

  // The toast never takes the bar's title or its needs capsule, nor a large title under an empty bar. A large sheet
  // covers the bar, so there it drops under the sheet's head row.
  const covers = useUi((s) => s.covers);
  const covered = covers > 0 || (sheet !== null && LARGE.has(sheet));
  // Where the bar's centre is empty the toast sits in the bar row itself, between its circles (8 from each); where it
  // holds a title or a capsule, the toast drops under the bar at the full width.
  const bar = useBarCentre();
  // Beside a sidebar that stands (the Duo unfolded) the bar is the panel's: the toast keeps to the screen's column, and
  // over a sheet to the sheet's centred width.
  const shell = useShell();
  const { width: across } = useWindowDimensions();
  const fromLeft = shell.panel.left;
  const fromRight = shell.split ? across - shell.panel.left - shell.pane.width : 0;
  const barTop = shell.split ? shell.panel.top : insets.top;
  const sheetSide = Math.max(0, Math.round((across - SHEET_MAX) / 2));
  const slot: ToastSlot = covered
    ? { top: Math.max(insets.top, 16) + 16 + layout.float + 8, left: sheetSide + SIDE, right: sheetSide + SIDE }
    : bar.empty
      ? { top: barTop + (BAR_HEIGHT - layout.float) / 2, left: fromLeft + SIDE, right: fromRight + layout.inset + bar.right * layout.float + Math.max(0, bar.right - 1) * layout.floatGap + layout.floatGap, inBar: true }
      : { top: barTop + BAR_HEIGHT + 8, left: fromLeft + layout.inset, right: fromRight + layout.inset };

  const sheets: Record<SheetName, ReactNode> = {
    model: (
      <ModelSheet
        open={up("model")}
        onClose={done("model")}
        value={modelChat && chatPick ? chatPick : newPick}
        listed={listed}
        onChange={(next) => (modelChat ? script.setModel(modelChat.id, next) : setPick(next))}
        onManageModels={() => openSettings("models")}
      />
    ),
    where: <WhereSheet open={up("where")} onClose={done("where")} repo={where.repo} computer={where.computer} onChange={setWhere} onAddProject={(query) => openAddProject(macReachable() ? "folder" : "github", query)} />,
    addProject: (
      <AddProjectSheet
        open={up("addProject")}
        onClose={done("addProject")}
        from={addFrom}
        query={addQuery}
        onAdded={(name) => {
          // A project the computer in use can't take (a folder only on your Mac, for a Cloud computer) moves to one that can.
          const was = ui.get().where;
          setWhere({ repo: name, computer: deviceLabel(settle(placeOf(name), deviceByLabel(was.computer) ?? deviceById(THIS_MAC))) });
        }}
      />
    ),
    details: <DetailsSheet open={up("details")} onClose={done("details")} chatId={detailsFor} />,
    settings: (
      <SettingsSheet
        open={up("settings")}
        section={settingsAt}
        onOpenChief={(id) => {
          closeSheet();
          showChief(id);
        }}
        onClose={done("settings")}
      />
    ),
    search: <SearchSheet open={up("search")} onClose={done("search")} />,
    profile: <ProfileSheet open={up("profile")} onClose={done("profile")} />,
    connect: <ConnectSheet open={up("connect")} onClose={done("connect")} />,
    newChief: <NewChiefSheet open={up("newChief")} onClose={done("newChief")} />,
    share: <ShareSheet open={up("share")} onClose={done("share")} />,
  };

  return (
    <>
      <MomentSheet
        chat={momentHere}
        open={reviewing}
        onOpenChange={setReviewing}
        onDismiss={() => {
          script.dismissMoment();
          setReviewing(false);
        }}
        onReply={(text) => {
          if (moment) script.send(moment.id, text);
          setReviewing(false);
        }}
        rest={rest}
      />
      <SheetFrame stack={stack} keep={ALL} page={(name) => ({ detent: detentOf(name), element: sheets[name as SheetName] })} onDismiss={closeSheet} onPop={popSheet} />
      <Toast
        news={toast}
        notice={notice}
        // A Chief says its own news in its chat, so its screen skips the toast.
        mute={focused?.name === "Chief" ? (focused.id ?? null) : null}
        // While a sheet is up the board's news waits for it to close; your own notices show at once.
        hold={sheet !== null || covers > 0}
        // A jump from anywhere: the chat becomes the main panel's root, as the sidebar opens it.
        onOpen={showChat}
        here={focused?.name === "Thread" ? (focused.id ?? null) : null}
        slot={slot}
      />
    </>
  );
}
