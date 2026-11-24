// Where a new chat runs: the desktop's project chooser (apps/web/src/components/ProjectPicker.tsx ProjectChooser) with
// the places it can run, in one sheet. The places are bare rows, a Mac of yours by its own name and "Cloud": no
// heading over them and nothing under a name, except the few words that say why one cannot be picked. The search runs across your projects and
// everything you could add, so a repository that isn't a project yet is one tap away: your projects, each its GitHub
// mark or a folder and where it lives under it; then what your Mac and your GitHub hold (a few suggestions, or every
// match once you type), each with the marks of where it was found (your Claude and Codex history, your GitHub); and a
// pasted link, owner/name or path offers to add it. Picking one adds it and picks it. While the phone can't reach your
// Mac a line over the list says so: only GitHub is searched (board/places.ts). "Add a project…" opens the dialog with
// what you typed. Then the places, each by its kind's glyph and its name; one that can't take the project says why
// and can't be picked, and a project one can't take moves to one that can. A row says
// one thing under its name, the repository or else the folder, so nothing wraps. A pick (a project, one added from the
// search, a computer) is the answer: the sheet closes and you're back in the box with the keyboard up (the founder,
// 2026-11-07: "when you click on a repo or environment it should auto go back to the chat box"); the X or a swipe
// closes it without one.
//
// Opened from the computer's chip (`focus` "computer"), the computers lead, the one in use checked, and the projects
// wait under them with their search: what you tapped is what you see first.
import { useState } from "react";
import { Text, View } from "react-native";
import { computerRows, deviceById, deviceByLabel, deviceLabel, THIS_MAC } from "../../board/model";
import { addProject, blocked, candidates, isProject, matches, type Place, projects, readTyped, searchNote, settle } from "../../board/places";
import { Icon } from "../../components/Icon";
import { DeviceGlyph, PixelFolder, PixelIcon } from "../../components/Pixel";
import { BrandMark } from "../../components/ui/BrandMark";
import { SearchField } from "../../components/ui/Field";
import { alpha, useTheme } from "../../theme";
import { SheetGroup, SheetRow } from "../Sheet";
import { FadeScroll, Found, foundWords } from "./parts";

/** Suggestions shown before you type; typing shows every match. */
const SUGGESTED = 3;

function Mark({ place }: { place: Place }) {
  const { c } = useTheme();
  return place.github ? <BrandMark name="github" size={16} color={alpha(c.text, 0.8)} /> : <PixelFolder open={false} />;
}

/** Which half of the sheet leads: the projects (the workspace's chip), or the computers (the computer's chip). */
export type WhereFocus = "repo" | "computer";

export function WherePicker({ repo, computer, onChange, onAddProject, focus = "repo" }: { repo: string; computer: string; onChange: (next: { repo: string; computer: string }) => void; /** The chooser's foot: opens Add a project with what was typed. */ onAddProject?: (query: string) => void; focus?: WhereFocus }) {
  const { c, t } = useTheme();
  const all = projects.use();
  const [query, setQuery] = useState("");
  const q = query.trim();
  const typed = readTyped(q);
  // The repo in use is always a project, even one the board made up.
  const mine = !repo || all.some((p) => p.name === repo) ? all : [...all, { name: repo }];
  const current = mine.find((p) => p.name === repo);
  const found = mine.filter((p) => matches(p, typed.needle));
  const fresh = candidates().filter((x) => !isProject(x, mine) && matches(x, typed.needle));
  const more = q ? fresh : fresh.slice(0, SUGGESTED);
  // A typed link or path that is neither a project nor something found already. A path means a folder on the Mac,
  // which only the Mac can add, while it answers.
  const asked = typed.kind !== "search" && !found.length && !fresh.length ? typed.place : null;
  const note = searchNote();
  const askedStuck = asked && !asked.github && note ? note : null;
  const inUse = deviceByLabel(computer) ?? deviceById(THIS_MAC);

  const pick = (place: Place) => onChange({ repo: place.name, computer: deviceLabel(settle(place, inUse)) });
  const add = (place: Place) => {
    setQuery("");
    pick(addProject(place));
  };
  const check = (on: boolean) => (on ? <Icon name="check" size={18} color={c.text} stroke={2} /> : null);

  const computers = (
    <SheetGroup first={focus === "computer"}>
      {computerRows().map((m) => {
        const device = deviceById(m.id);
        const why = blocked(current, device);
        return (
          <SheetRow
            key={m.id}
            icon={<DeviceGlyph device={device} />}
            label={device.name}
            {...(why ? { detail: why } : null)}
            selected={m.name === computer}
            disabled={!!why}
            right={check(m.name === computer)}
            onPress={() => onChange({ repo, computer: m.name })}
          />
        );
      })}
    </SheetGroup>
  );
  const computersFirst = focus === "computer";

  return (
    <>
      {computersFirst ? <View style={{ paddingBottom: 8 }}>{computers}</View> : null}
      <View style={{ paddingHorizontal: 16, paddingBottom: 4 }}>
        <SearchField variant="capsule" value={query} onChangeText={setQuery} placeholder="Search, or paste a GitHub link" onSubmitEditing={() => asked && !askedStuck && add(asked)} accessibilityLabel="Search projects and repositories, or add one by its link, owner/name or path" />
      </View>
      <FadeScroll style={{ flexShrink: 1 }} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 4 }}>
        {note ? <Text style={[t.small, { paddingHorizontal: 20, paddingTop: 8, paddingBottom: 4 }]}>{note}</Text> : null}
        {asked ? (
          <SheetGroup label="Add">
            <SheetRow
              icon={asked.github ? <BrandMark name="github" size={16} color={alpha(c.text, 0.8)} /> : <PixelIcon name="folder" />}
              label={asked.github ? `Clone ${asked.github}` : "Add this folder"}
              detail={askedStuck ?? (asked.github ? (note ? "Cloud clones it when a chat starts" : "Into ~/code on your Mac, or the copy already there") : asked.path)}
              disabled={!!askedStuck}
              onPress={() => add(asked)}
            />
          </SheetGroup>
        ) : null}
        {found.length ? (
          <SheetGroup label="Projects">
            {found.map((p) => (
              <SheetRow key={p.name} icon={<Mark place={p} />} label={p.name} detail={p.github ?? p.path} selected={p.name === repo} right={check(p.name === repo)} onPress={() => pick(p)} />
            ))}
            {onAddProject ? <SheetRow icon={<Icon name="add" size={18} color={c.muted} />} label="Add a project…" quiet onPress={() => onAddProject(q)} /> : null}
          </SheetGroup>
        ) : null}
        {more.length ? (
          <SheetGroup label={q ? "Add a project" : "Suggested"}>
            {more.map((x) => (
              <SheetRow key={x.name} icon={<Mark place={x} />} label={x.name} detail={x.github ?? x.path} right={<Found sources={x.sources ?? []} clone={!x.path} age={x.age} />} hint={foundWords(x.sources ?? [], !x.path, x.age)} onPress={() => add(x)} />
            ))}
          </SheetGroup>
        ) : null}
        {q && !found.length && !more.length && !asked ? <Text style={[t.small, { textAlign: "center", paddingHorizontal: 20, paddingVertical: 16 }]}>{`Nothing matches “${q}”. Paste a GitHub link or owner/name to clone it.`}</Text> : null}
        {!found.length && onAddProject ? <SheetRow icon={<Icon name="add" size={18} color={c.muted} />} label="Add a project…" quiet onPress={() => onAddProject(q)} /> : null}
        {computersFirst ? null : computers}
      </FadeScroll>
    </>
  );
}
