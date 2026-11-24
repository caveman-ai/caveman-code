// The box that starts a chat, at the foot of Home, a tile's list and a workspace (DECISIONS.md Home 7, 8 and O10):
// "What should we build?" at rest; focused, the card says where the chat will run (the last workspace you started one
// in, or the workspace on screen, from its main branch, on the computer new chats run on, by its Devices name) and
// which model it starts on (Settings' default until you pick another). Sending starts the chat and makes it the main
// panel's root at once, in the new chat's place, so its top left is the sidebar's button (nav/ref.ts `showChat`). What
// you write waits as the new chat's draft (a workspace's box keeps its own).
import { useEffect, useRef } from "react";
import type { SharedValue } from "react-native-reanimated";
import { boardEngine } from "../board/catalog";
import { deviceByLabel, deviceById, ENGINE_NAME, THIS_MAC } from "../board/model";
import { NO_AGENT } from "../live/engines";
import { isLive } from "../live/seams";
import { showChat } from "../nav/ref";
import { NEW_CHAT } from "../store/sessions";
import { useRows } from "../store/select";
import { Composer, type Voice } from "./Composer";
import { triggerOf, useNewPick } from "./Sheets";
import { notice, openModel, openWhere, startChat, useUi } from "./ui";

export function NewChatComposer({
  workspace,
  placeholder,
  onVoice,
  onTyping,
  onHeight,
  contentEnd,
}: {
  /** A workspace's own box: its chats start there. */
  workspace?: string;
  /** Defaults to "What should we build?". */
  placeholder?: string;
  onVoice?: (voice: Voice) => void;
  onTyping?: (typing: boolean) => void;
  onHeight?: (height: number) => void;
  /** Where the page's last line is on screen, so the band behind the bar shows only while content runs under it. */
  contentEnd?: SharedValue<number>;
}) {
  // What it starts on, as the place its box names takes it: on the person's own board the chip never names an
  // agent or a model that place lacks.
  const { pick, picked, listed } = useNewPick();
  const where = useUi((s) => s.where);
  // The agent the person picked themselves is not one this place runs, so the chip names another: said once, in
  // the web's sentence where Cloud is the place ("Claude isn't connected for Cloud."). The picker says where it is
  // put right.
  const own = useUi((s) => s.pick);
  const told = useRef("");
  useEffect(() => {
    if (!own || listed.engines.length === 0) return;
    // Seated again (another place, another pick): the next time it is not, that is said anew.
    if (own.engine === pick.engine) return void (told.current = "");
    const key = `${own.engine}@${where.computer}`;
    if (told.current === key) return;
    told.current = key;
    const why = listed.missing.find((m) => boardEngine(m.engine) === own.engine)?.line.split(". ")[0];
    const place = deviceByLabel(where.computer)?.kind === "cloud" ? "for Cloud" : `on ${where.computer}`;
    notice({ id: `pick-${Date.now()}`, text: why ? `${why.replace(/\.$/, "")}.` : `${ENGINE_NAME[own.engine]} isn't set up ${place}.`, icon: "alert", tone: "info" });
  }, [own, pick.engine, listed, where.computer]);
  // A place that has answered and runs no agent: the chip says that, never a model the place lacks. The picker it
  // opens says where one is set up.
  const chip = listed.none ? { engine: "", model: "", label: NO_AGENT, accessibilityLabel: (listed.line ?? NO_AGENT).replace(/\.$/, "") } : triggerOf(pick, listed.engines);
  const rows = useRows();
  const repo = workspace ?? where.repo;
  const device = deviceByLabel(where.computer) ?? deviceById(THIS_MAC);
  return (
    <Composer
      variant="new"
      draft={workspace ? `workspace:${workspace}` : NEW_CHAT}
      placeholder={placeholder ?? ""}
      speech="Make the relay reconnect test stop flaking"
      onSend={(text, images) => {
        // Nothing was started (a followed computer's board takes no chat from the phone yet): nothing to open.
        const id = startChat(text, { ...pick, picked }, workspace, images);
        if (id) showChat(id);
      }}
      chats={rows.map((r) => ({ id: r.chat.id, title: r.chat.title, engine: r.chat.engine, repo: r.chat.repo }))}
      model={{ ...chip, onPress: () => openModel() }}
      // A real computer's chat starts from its project's own checkout: no branch is made up for it.
      where={{ repo, branch: isLive() ? "" : "main", device, fixed: !!workspace, onPress: openWhere }}
      onVoice={onVoice}
      onTyping={onTyping}
      onHeight={onHeight}
      contentEnd={contentEnd}
    />
  );
}
