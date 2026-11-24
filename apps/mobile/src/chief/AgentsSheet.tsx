// A Chief's agents, all of them, on the shared medium sheet (shell/Sheet.tsx: glass floating 8 pt in, the glass X,
// the title centred; native agents sheet, IMG_5349; DECISIONS.md, "Agents sheet"): opened from the floating row's
// capsule. It is what makes fifty chats manageable from a phone: a search
// field, state chips with their counts (All, Needs you, Working, Ready, Done), and one row per chat with its state as a
// glyph and a word, its title, one live line and its age. What needs you comes first, with the one pair under it, so a
// morning of asks clears from here; an answer waits behind its own Undo in the pair's place, so clearing ten asks in a
// row never takes back an earlier one; finished chats fold into "N done" at the foot. A row's peek is pushed inside
// this sheet, as a page with a back chevron (Peek.tsx PeekPage), never a second sheet over it: one grabber, one way
// back to the list. Subagents are never rows: their asks light their parent.
import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, type ScrollViewInstance, Text, View } from "react-native";
import Animated from "react-native-reanimated";
import {
  type Chat,
  type Chief,
  deviceById,
  ENGINE_NAME,
  HOME_CHIEF,
  type Phase,
} from "../board/model";
import { Icon } from "../components/Icon";
import { SearchField } from "../components/ui/Field";
import { ScopeChip } from "../components/ui/Floating";
import { enter, haptic, layout as glide } from "../motion";
import { rowAge } from "../shell/inbox";
import { Sheet, SheetBack, SHEET_TEXT_X } from "../shell/Sheet";
import { StateWord } from "../shell/rows/StateWord";
import { childName, lineTwo, type Row, unseenReady } from "../store/select";
import { useStore } from "../store/store";
import { alpha, layout, useTheme } from "../theme";
import { usualDevice } from "../home/model";
import { act } from "../asks/decide";
import { SummaryCard } from "../asks/SummaryCard";
import { askerOf as anyAskerOf, needOf } from "../store/select";
import { askerOf, type Card } from "./cards";
import { type Pendings, undo } from "./decide";
import { CommandChip, Pair, UndoBar } from "./parts";
import { PeekOpen, PeekPage } from "./Peek";
import { STATE_WORD, StateGlyph } from "../components/ui/WorkLink";

/** A chip's filter: a state, everything, or the ready ones already looked at ("Seen"). */
export type AgentsFilter = Phase | "all" | "seen";

const CHIPS: readonly { id: AgentsFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "needs", label: "Needs you" },
  { id: "working", label: "Working" },
  // Ready counts what you haven't looked at, as every "ready" does (store/select.ts readyOf); Seen holds the rest.
  { id: "ready", label: "Ready" },
  { id: "seen", label: "Seen" },
  { id: "done", label: "Done" },
];

interface Props {
  open: boolean;
  onClose: () => void;
  chief: Chief;
  /** Its chats as rows, most urgent first (store/select.ts listOf). */
  rows: readonly Row[];
  /** The whole board, to find which of a chat's agents asks. */
  chats: readonly Chat[];
  /** The filter it opens on. */
  filter: AgentsFilter;
  /** What waits behind Undo, by the chat the answer goes to. */
  pending: Pendings;
  /** Opens a chat, the sheet put away (a peek's Open, or its More). */
  onOpen: (id: string) => void;
  onDecide: (card: Card, yes: boolean) => void;
}

/**
 * What a row says under its title (store/select.ts lineTwo, the one O7 line): the ask, the live sentence, or a ready
 * change's "+38 −12 · workspace", then the device only where these chats don't usually run or it is away.
 */
function Meta({ chat, phase, usual }: { chat: Chat; phase: Phase; usual: string }) {
  const { c } = useTheme();
  const line = lineTwo(chat, phase, usual);
  const rest = [line.said || null, line.diff ? null : line.where, line.device]
    .filter(Boolean)
    .join(" · ");
  return (
    <>
      {line.diff ? (
        <>
          {line.diff.add ? <Text style={{ color: c.added }}>{`+${line.diff.add}`}</Text> : null}
          {line.diff.add && line.diff.del ? " " : null}
          {line.diff.del ? <Text style={{ color: c.removed }}>{`−${line.diff.del}`}</Text> : null}
          {` · ${[line.where, line.device].filter(Boolean).join(" · ")}`}
        </>
      ) : (
        rest
      )}
    </>
  );
}

function AgentRow({
  row,
  chats,
  usual,
  pending,
  divided,
  onPeek,
  onDecide,
}: {
  row: Row;
  chats: readonly Chat[];
  /** Where these chats usually run: a row names its device only when it is elsewhere. */ usual: string;
  pending: Pendings;
  divided: boolean;
  onPeek: (id: string) => void;
  onDecide: (card: Card, yes: boolean) => void;
}) {
  const { c, t } = useTheme();
  const { chat, phase } = row;
  const asker = phase === "needs" ? askerOf(chat, chats) : null;
  const waiting = asker ? pending[asker.id] : undefined;
  // A question for direction has no Deny | Allow: its summary card at the dock size, the row above saying who.
  const direction = (() => {
    if (asker || phase !== "needs") return null;
    const who = anyAskerOf(chat, chats);
    const need = needOf(who);
    return need?.kind === "question" ? { asker: who, need } : null;
  })();
  return (
    <Animated.View layout={glide}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${chat.title}, ${STATE_WORD[phase]}, ${ENGINE_NAME[chat.engine]}`}
        accessibilityHint="Peeks at the chat"
        onPress={() => {
          haptic.tick();
          onPeek(chat.id);
        }}
        style={({ pressed }) => ({
          flexDirection: "row",
          alignItems: "flex-start",
          gap: 12,
          minHeight: layout.row.double,
          paddingHorizontal: 20,
          paddingVertical: 10,
          backgroundColor: pressed ? alpha(c.text, 0.06) : undefined,
        })}
      >
        {divided ? (
          <View
            pointerEvents="none"
            style={{
              position: "absolute",
              top: 0,
              left: SHEET_TEXT_X,
              right: 20,
              height: 1,
              backgroundColor: c.hairline,
            }}
          />
        ) : null}
        <View style={{ width: 20, alignItems: "center", paddingTop: 3 }}>
          <StateGlyph phase={phase} />
        </View>
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
            <Text numberOfLines={1} style={[t.row, { flex: 1 }]}>
              {chat.title}
            </Text>
            <Text style={t.meta}>{rowAge(chat.updatedAt, Date.now())}</Text>
          </View>
          <Text numberOfLines={1} style={[t.small, { fontSize: 14, lineHeight: 19 }]}>
            <StateWord phase={phase} />
            {" · "}
            <Meta chat={chat} phase={phase} usual={usual} />
            {asker && asker.id !== chat.id ? (
              <Text style={{ color: c.subtle }}>{` · ${childName(asker)}`}</Text>
            ) : null}
          </Text>
        </View>
      </Pressable>
      {asker ? (
        // Allow is never offered without what it lets run: the command chip, whole, then the inline pair.
        <View
          style={{
            paddingLeft: SHEET_TEXT_X,
            paddingRight: 20,
            paddingBottom: 12,
            paddingTop: 2,
            gap: 8,
          }}
        >
          {asker.ask ? <CommandChip command={asker.ask} /> : null}
          {waiting ? (
            <UndoBar pending={waiting} onUndo={() => undo(waiting.card.chat.id)} />
          ) : (
            <Pair
              kind="ask"
              size="inline"
              command={asker.ask}
              onDecide={(yes) => onDecide({ kind: "ask", chat: asker, row: chat }, yes)}
            />
          )}
        </View>
      ) : direction ? (
        <View style={{ paddingLeft: SHEET_TEXT_X - 16, paddingRight: 20 - 16, marginTop: -14 }}>
          <SummaryCard
            asker={direction.asker}
            row={chat}
            need={direction.need}
            variant="dock"
            surface="none"
            onReply={(reply) => void act(direction.asker.id, reply)}
          />
        </View>
      ) : null}
    </Animated.View>
  );
}

export function AgentsSheet({
  open,
  onClose,
  chief,
  rows,
  chats,
  filter: initial,
  pending,
  onOpen,
  onDecide,
}: Props) {
  // The chat whose peek is pushed over the list, if any.
  const [page, setPage] = useState<string | null>(null);
  const paged = page ? (chats.find((ch) => ch.id === page) ?? null) : null;
  useEffect(() => {
    if (open) setPage(null);
  }, [open]);
  const title = agentsTitle(chief);

  if (paged)
    return (
      <Sheet
        open={open}
        onClose={onClose}
        detent="medium"
        title={paged.title}
        leading={
          <SheetBack
            label={`Back to ${title}`}
            onPress={() => {
              haptic.tick();
              setPage(null);
            }}
          />
        }
        accessory={<PeekOpen chat={paged} onClose={onClose} onOpen={onOpen} />}
      >
        <Animated.View key={paged.id} entering={enter.fade} style={{ flexShrink: 1 }}>
          <PeekPage
            chat={paged}
            chats={chats}
            pending={pending}
            onClose={onClose}
            onOpen={onOpen}
            onDecide={onDecide}
          />
        </Animated.View>
      </Sheet>
    );

  return (
    <Sheet open={open} onClose={onClose} detent="medium" title={title}>
      <AgentsList
        rows={rows}
        chats={chats}
        filter={initial}
        pending={pending}
        onPeek={setPage}
        onDecide={onDecide}
        fresh={open}
      />
    </Sheet>
  );
}

/** "Chief's agents", "Oona's agents". */
export const agentsTitle = (chief: Chief) =>
  chief.id === HOME_CHIEF ? "Chief's agents" : `${chief.name}'s agents`;

/**
 * The list itself: the search field, the state chips and the rows. The sheet holds it on a phone; where the sidebar
 * stands beside the panel (the iPhone Duo unfolded) it is the Chief's inspector beside its chat, and a row opens its
 * chat over the Chief rather than a peek. It starts over (All, no search) each time `fresh` turns true.
 */
export function AgentsList({
  rows,
  chats,
  filter: initial,
  pending,
  onPeek,
  onDecide,
  fresh = true,
}: {
  rows: readonly Row[];
  chats: readonly Chat[];
  filter: AgentsFilter;
  pending: Pendings;
  onPeek: (id: string) => void;
  onDecide: (card: Card, yes: boolean) => void;
  fresh?: boolean;
}) {
  const { c, t } = useTheme();
  const [filter, setFilter] = useState<AgentsFilter>(initial);
  const [query, setQuery] = useState("");
  const [doneOpen, setDoneOpen] = useState(false);
  // Its chips start at All, at the row's start, each time it opens.
  const chips = useRef<ScrollViewInstance>(null);
  useEffect(() => {
    if (fresh) {
      setFilter(initial);
      setQuery("");
      chips.current?.scrollTo({ x: 0, animated: false });
    }
  }, [fresh, initial]);

  const inbox = useStore((s) => s.inbox);
  // Where its chats usually run: a row names its computer only when it runs elsewhere, or that one is away.
  const usual = useMemo(() => usualDevice(rows), [rows]);
  const counts = useMemo(() => {
    const n: Record<AgentsFilter, number> = {
      all: rows.length,
      needs: 0,
      working: 0,
      ready: 0,
      seen: 0,
      done: 0,
    };
    for (const r of rows) n[r.phase === "ready" && !unseenReady(r, inbox) ? "seen" : r.phase] += 1;
    return n;
  }, [rows, inbox]);
  const stateOf = (r: Row): AgentsFilter =>
    r.phase === "ready" && !unseenReady(r, inbox) ? "seen" : r.phase;

  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matches = rows.filter((r) => {
    if (filter !== "all" && stateOf(r) !== filter) return false;
    if (!words.length) return true;
    const hay =
      `${r.chat.title} ${r.chat.repo} ${r.chat.line} ${ENGINE_NAME[r.chat.engine]} ${r.chat.model} ${deviceById(r.chat.device).name}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
  // On All, finished chats wait folded at the foot; a search or the Done chip shows them.
  const foldDone = filter === "all" && !words.length;
  const live = foldDone ? matches.filter((r) => r.phase !== "done") : matches;
  const done = foldDone ? matches.filter((r) => r.phase === "done") : [];

  return (
    <>
      <View style={{ paddingHorizontal: 16, gap: 10, paddingBottom: 6 }}>
        <SearchField
          variant="capsule"
          value={query}
          onChangeText={setQuery}
          placeholder={`Search ${rows.length} agents`}
          accessibilityLabel="Search its agents"
        />
        <ScrollView
          ref={chips}
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: 6 }}
          style={{ marginHorizontal: -16 }}
        >
          <View style={{ width: 10 }} />
          {CHIPS.filter((chip) => chip.id === "all" || counts[chip.id] > 0).map((chip) => {
            const on = filter === chip.id;
            return (
              <ScopeChip
                key={chip.id}
                label={chip.label}
                said={`${chip.label}, ${counts[chip.id]}`}
                on={on}
                onPress={() => {
                  haptic.tick();
                  setFilter(chip.id);
                }}
              >
                <Text
                  numberOfLines={1}
                  style={[
                    t.row,
                    {
                      fontSize: 15,
                      lineHeight: 20,
                      color: on ? c.text : c.soft,
                      fontWeight: on ? "500" : "400",
                    },
                  ]}
                >
                  {chip.label}
                  <Text
                    style={{
                      color: chip.id === "needs" ? c.warning : c.subtle,
                      fontWeight: "400",
                      fontVariant: ["tabular-nums"],
                    }}
                  >{`  ${counts[chip.id]}`}</Text>
                </Text>
              </ScopeChip>
            );
          })}
          <View style={{ width: 10 }} />
        </ScrollView>
      </View>
      <ScrollView
        style={{ flexShrink: 1 }}
        contentContainerStyle={{ paddingTop: 4, paddingBottom: 6 }}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {live.map((r, i) => (
          <AgentRow
            key={r.chat.id}
            row={r}
            chats={chats}
            usual={usual}
            pending={pending}
            divided={i > 0}
            onPeek={onPeek}
            onDecide={onDecide}
          />
        ))}
        {done.length ? (
          <>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ expanded: doneOpen }}
              accessibilityLabel={`${done.length} done`}
              onPress={() => {
                haptic.tick();
                setDoneOpen((o) => !o);
              }}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 12,
                minHeight: layout.row.sheet,
                paddingHorizontal: 20,
              }}
            >
              {live.length ? (
                <View
                  pointerEvents="none"
                  style={{
                    position: "absolute",
                    top: 0,
                    left: SHEET_TEXT_X,
                    right: 20,
                    height: 1,
                    backgroundColor: c.hairline,
                  }}
                />
              ) : null}
              <View style={{ width: 20, alignItems: "center" }}>
                <StateGlyph phase="done" />
              </View>
              <Text style={[t.row, { flex: 1, color: c.muted }]}>{done.length} done</Text>
              <View style={{ transform: [{ rotate: doneOpen ? "180deg" : "0deg" }] }}>
                <Icon name="chevronDown" size={16} color={c.subtle} />
              </View>
            </Pressable>
            {doneOpen
              ? done.map((r) => (
                  <AgentRow
                    key={r.chat.id}
                    row={r}
                    chats={chats}
                    usual={usual}
                    pending={pending}
                    divided
                    onPeek={onPeek}
                    onDecide={onDecide}
                  />
                ))
              : null}
          </>
        ) : null}
        {!live.length && !done.length ? (
          <Text style={[t.small, { textAlign: "center", paddingVertical: 28 }]}>
            {words.length ? `Nothing matches “${query.trim()}”` : "Nothing here"}
          </Text>
        ) : null}
      </ScrollView>
    </>
  );
}
