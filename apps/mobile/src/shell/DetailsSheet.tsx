// A chat's details, from its title capsule and its ··· menu's View Details (native, IMG_5351): a medium sheet with
// the chat's mark and name, Rename and Share as glass circles, then what it is, each row a label and its value in grey:
// its repository or folder, where it runs (a Mac of yours by its name, or Cloud, with that place's one state word and,
// where something went wrong there, why in one sentence), its model at its effort, its agent, when it started. Under
// that its family: the chat it was spawned from and the subagents it spawned, each a row that opens it (a subagent
// opens over its parent, so Back walks up). Its model row opens the model picker for this chat, pushed over the details
// on the same sheet; a pick there comes back here with the row saying the new model. Where the sidebar stands beside
// the panel (the iPhone Duo unfolded) the same body is the inspector beside the chat (screens/ThreadScreen.tsx).
import * as Clipboard from "expo-clipboard";
import { useEffect, useState } from "react";
import { Platform, ScrollView, Share, Text, TextInput, View } from "react-native";
import { type Chat, chiefById, chiefOf, deviceById, ENGINE_NAME, type Phase } from "../board/model";
import { Sprite } from "../components/Sprite";
import { STATE_WORD, StateDot } from "../components/ui/Badge";
import { effortLabel, EngineLogo } from "../components/ui/EngineLogo";
import { GlassCircle } from "../components/ui/Floating";
import { useMark, useNote } from "../live/link";
import { isLive } from "../live/seams";
import { haptic } from "../motion";
import { openChat, openChief } from "../nav/ref";
import { phaseOf, URGENCY, useChat, useChildren, useParent } from "../store/select";
import { dispatch, useStore } from "../store/store";
import { alpha, mono, useTheme } from "../theme";
import { placeOf } from "../board/places";
import { Sheet, SheetGroup, SheetRow } from "./Sheet";
import { triggerOf, useChatPick } from "./Sheets";
import { closeSheet, notice, openModel } from "./ui";

/** "Today at 9:41", "Yesterday at 18:02", "3 Nov at 9:41". */
function startedWords(at: number, now = Date.now()): string {
  const d = new Date(at);
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((day(new Date(now)) - day(d)) / 86_400_000);
  if (days === 0) return `Today at ${time}`;
  if (days === 1) return `Yesterday at ${time}`;
  return `${d.toLocaleDateString([], { day: "numeric", month: "short" })} at ${time}`;
}

/** The branch it works on: the one its change is on, else the worktree branch Caveman makes for a chat. */
const branchOf = (chat: Chat) => chat.moment?.branch ?? `caveman/${chat.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32)}`;

export function DetailsSheet({ open, onClose, chatId }: { open: boolean; onClose: () => void; chatId: string | null }) {
  const chat = useChat(chatId);
  // A chat that isn't there (archived while its capsule was pressed, a stale id) has no details: on the shell's frame a
  // sheet is up because the stack says so, so this one takes itself off it rather than standing empty.
  const missing = open && !chat;
  useEffect(() => {
    if (missing) onClose();
  }, [missing, onClose]);
  return (
    <Sheet open={open && !!chat} onClose={onClose} name="Details" closeLabel="Close details">
      {chat ? <Details chat={chat} /> : null}
    </Sheet>
  );
}

/** What a chat is, its info and its family: the sheet's body on a phone, the inspector beside the chat on the Duo. */
export function Details({ chat }: { chat: Chat }) {
  const { c, t } = useTheme();
  const title = useStore((s) => s.inbox.titles[chat.id] ?? chat.title);
  const chats = useStore((s) => s.board.chats);
  const parent = useParent(chat.id);
  const children = useChildren(chat.id);
  const pick = useChatPick(chat);
  const model = pick ? triggerOf(pick) : null;
  const device = deviceById(chat.device);
  const chiefId = chiefOf(chat);
  const chief = chiefId ? chiefById(chiefId) : null;
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(title);

  const finish = () => {
    const next = draft.trim();
    if (next && next !== title) dispatch({ type: "inbox/rename", id: chat.id, title: next });
    setRenaming(false);
  };
  const share = async () => {
    const link = `https://app.caveman.so/code/chat/${chat.id}`;
    try {
      if (Platform.OS === "web") throw new Error("no share sheet");
      await Share.share({ message: `${title}\n${link}` });
    } catch {
      await Clipboard.setStringAsync(link).catch(() => {});
      notice({ id: `share-${Date.now()}`, text: "Link copied", tone: "info", icon: "link" });
    }
  };
  // Opening a chat or a Chief leaves the sheets: the screen it opens is under them.
  const go = (id: string) => {
    closeSheet();
    openChat(id);
  };
  const state = (x: Chat): Phase => phaseOf(x, chats);
  // What it works in: a repository by its owner and name, or a folder by its name.
  const github = placeOf(chat.repo)?.github;
  const status = device.status === "online" ? null : device.status === "asleep" ? "Asleep" : device.status === "offline" ? "Offline" : "Waking…";
  // On the person's own board, not the scripted world's: where it runs is their Mac by name or Cloud, with its state.
  const real = isLive();
  const mark = useMark(chat.id);
  const note = useNote(chat.id);

  return (
    <ScrollView style={{ flexShrink: 1 }} keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: 4 }}>
      <View style={{ alignItems: "center", paddingHorizontal: 24, marginTop: -8 }}>
        <EngineLogo engine={chat.engine} size={28} label={ENGINE_NAME[chat.engine]} />
        {renaming ? (
          <TextInput
            autoFocus
            value={draft}
            onChangeText={setDraft}
            selectTextOnFocus
            returnKeyType="done"
            onSubmitEditing={finish}
            onBlur={finish}
            accessibilityLabel="Chat name"
            selectionColor={c.text}
            style={[t.title, { marginTop: 14, alignSelf: "stretch", textAlign: "center", height: 44, borderRadius: 22, backgroundColor: alpha(c.text, 0.07), paddingHorizontal: 16 }, { outlineStyle: "none" } as object]}
          />
        ) : (
          <Text accessibilityRole="header" numberOfLines={2} style={[t.title, { marginTop: 14, textAlign: "center" }]}>
            {title}
          </Text>
        )}
        <View style={{ flexDirection: "row", gap: 12, marginTop: 16 }}>
          <GlassCircle
            icon={renaming ? "check" : "rename"}
            label={renaming ? "Save the name" : "Rename"}
            onPress={() => {
              haptic.tick();
              if (renaming) finish();
              else {
                setDraft(title);
                setRenaming(true);
              }
            }}
          />
          <GlassCircle icon="share" label="Share" onPress={() => void share()} />
        </View>
      </View>
      <SheetGroup label="Info">
        <SheetRow label={github ? "Repository" : "Folder"} right={<Text numberOfLines={1} style={[t.row, { fontSize: 17, lineHeight: 22, color: c.muted, flexShrink: 1, maxWidth: "72%", textAlign: "right" }]}>{github ?? (chat.repo === "Folder" ? "On your Mac" : chat.repo)}</Text>} />
        {/* A real computer's chat names no branch here: the phone is not told it, and makes none up. */}
        {real ? null : <SheetRow label="Branch" right={<Text numberOfLines={1} style={[t.row, { fontFamily: mono, fontSize: 15, color: c.muted, flexShrink: 1, maxWidth: "62%" }]}>{branchOf(chat)}</Text>} />}
        <SheetRow label="Runs on" value={real ? (mark ?? device.name) : status ? `${device.name} · ${status}` : device.name} />
        {/* Something went wrong where it runs, or it could not run somewhere else: why, in the words it was given. */}
        {note?.detail ? <Text style={[t.small, { paddingHorizontal: 20, paddingBottom: 10 }]}>{note.detail}</Text> : null}
        <SheetRow label="Model" value={model ? [model.label, model.effort && effortLabel(model.effort)].filter(Boolean).join(" · ") : chat.model} hint="Picks the model for its next turn" chevron onPress={() => openModel(chat.id)} />
        <SheetRow label="Agent" value={ENGINE_NAME[chat.engine]} />
        <SheetRow label="Started" value={startedWords(chat.startedAt)} />
        {real ? null : <SheetRow label="Source" value={chat.id.startsWith("ask-") ? "Phone" : "Desktop"} />}
        {chief ? (
          <SheetRow
            label="Chief"
            hint="Opens its Chief"
            right={
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <Sprite character={chief.character} tone={chief.tone} size={24} animate={false} />
                <Text style={[t.row, { fontSize: 17, lineHeight: 22, color: c.muted }]}>{chief.name}</Text>
              </View>
            }
            chevron
            onPress={() => {
              closeSheet();
              openChief(chief.id);
            }}
          />
        ) : real ? null : (
          // One you started yourself: no Chief watches it.
          <SheetRow label="Chief" value="None, you started it" />
        )}
      </SheetGroup>
      {parent ? (
        <SheetGroup label="Started from">
          <SheetRow icon={<StateDot phase={state(parent)} />} label={parent.title} detail={STATE_WORD[state(parent)]} chevron onPress={() => go(parent.id)} />
        </SheetGroup>
      ) : null}
      {children.length ? (
        <SheetGroup label={`Subagents · ${children.length}`}>
          {[...children].sort((a, b) => URGENCY[state(a)] - URGENCY[state(b)]).map((child) => {
            const p = state(child);
            return <SheetRow key={child.id} icon={<StateDot phase={p} />} label={child.title} detail={`${STATE_WORD[p]} · ${child.line}`} chevron onPress={() => go(child.id)} />;
          })}
        </SheetGroup>
      ) : null}
    </ScrollView>
  );
}
