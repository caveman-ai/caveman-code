// Add a project, the desktop's dialog (apps/web/src/components/ProjectPicker.tsx AddProject) as a sheet: two ways in,
// one tab each. Your Mac, by its name: a field that searches the checkouts found there (your Claude and Codex history,
// your code folders) or takes a folder's path. GitHub: a link or owner/name to clone, above your repositories. A field
// that holds the other tab's kind of thing offers to carry it across. Picking a row adds it and starts there. A row
// says at its right where it was found, as the desktop's CandidateMeta does: the Claude spark, the OpenAI mark for
// Codex, a "Clone" tag where it is only on GitHub, then how lately it was used.
//
// The phone has nothing of its own to add: the Mac's tab reads the Mac (board/places.ts). While the Mac is asleep or
// offline that tab says so and points to GitHub, whose repositories a Cloud computer clones; with no Mac this phone
// drives, GitHub is the only way in, so there are no tabs.
import { useState } from "react";
import { Text, View } from "react-native";
import { addProject, candidates, isProject, macName, macReachable, matches, pairedMac, type Place, projects, readTyped } from "../../board/places";
import { PixelFolder } from "../../components/Pixel";
import { BrandMark } from "../../components/ui/BrandMark";
import { Button } from "../../components/ui/Button";
import { SearchField } from "../../components/ui/Field";
import { Segmented } from "../../components/ui/Segmented";
import { alpha, useTheme } from "../../theme";
import { SheetGroup, SheetRow } from "../Sheet";
import { FadeScroll, Found, foundWords } from "./parts";

export type AddFrom = "folder" | "github";

/** The tab a sheet opens on for what it was handed: a link on GitHub's, a path on the Mac's, else the one asked for. */
export function tabFor(from: AddFrom, query: string): AddFrom {
  if (!pairedMac()) return "github";
  const kind = readTyped(query).kind;
  return kind === "repo" ? "github" : kind === "path" ? "folder" : from;
}

const parent = (path: string) => path.slice(0, path.lastIndexOf("/")) || path;

export function AddProject({ from, onFrom, onAdded, initial = "" }: { from: AddFrom; onFrom: (from: AddFrom) => void; onAdded: (name: string) => void; /** What the chooser's search held, in the tab it belongs to. */ initial?: string }) {
  const { c, t } = useTheme();
  const all = projects.use();
  const mac = pairedMac();
  // One field per tab, so switching never carries a path to GitHub or a link to the Mac.
  const [queries, setQueries] = useState<Record<AddFrom, string>>(() => ({ folder: "", github: "", [tabFor(from, initial)]: initial }));
  const query = queries[from];
  const q = query.trim();
  const field = readTyped(query);
  const setQuery = (text: string) => setQueries((now) => ({ ...now, [from]: text }));
  const carry = (to: AddFrom) => {
    setQueries((now) => ({ ...now, [to]: query, [from]: "" }));
    onFrom(to);
  };

  const github = <BrandMark name="github" size={16} color={alpha(c.text, 0.8)} />;
  const folder = <PixelFolder open={false} />;
  const onMac = from === "folder" && !!mac;
  const mark = onMac ? folder : github;
  const name = macName();
  // Searching shows what is a project already, so a name that finds nothing new still finds something.
  const added = q ? all.filter((p) => (onMac || p.github) && matches(p, field.needle)) : [];
  const list = candidates().filter((x) => (onMac ? x.path : x.github) && !isProject(x, all) && matches(x, field.needle));
  const ready = onMac ? field.kind === "path" : field.kind === "repo";
  const add = (place: Place) => onAdded(addProject(place).name);
  const submit = () => {
    if (ready && field.kind !== "search") add(field.place);
  };

  const tabs = mac ? (
    <Segmented
      label="Where it is"
      value={from}
      onChange={onFrom}
      options={[
        { value: "folder", label: `On ${mac.name}`, icon: ({ ink }) => <PixelFolder open={false} ink={ink} /> },
        { value: "github", label: "GitHub", icon: ({ ink }) => <BrandMark name="github" size={14} color={ink} /> },
      ]}
    />
  ) : null;

  // The Mac's tab while it can't answer: what it holds can't be read until it's back, and GitHub is the way in meanwhile.
  if (onMac && !macReachable())
    return (
      <View style={{ paddingHorizontal: 16, gap: 12, paddingBottom: 8 }}>
        {tabs}
        <Text style={[t.small, { paddingHorizontal: 4 }]}>{`${name} is ${mac?.status === "asleep" ? "asleep" : "offline"}. Its folders show when it's back. Add a repository from GitHub to start in Cloud now.`}</Text>
        <View style={{ flexDirection: "row", paddingHorizontal: 4 }}>
          <Button label="Add from GitHub" size="small" onPress={() => onFrom("github")} />
        </View>
      </View>
    );

  const clones = macReachable() ? `Clones into ~/code on ${name}, or uses the copy already there.` : "Cloud clones it when a chat starts.";
  const empty = onMac
    ? q
      ? `Nothing found on ${name} matches “${q}”. Paste a folder's path to add it.`
      : `No repositories found on ${name} yet. Paste a folder's path to add it.`
    : q
      ? `None of your repositories match “${q}”. Paste its link to clone it.`
      : "No GitHub repositories found. Paste a link to clone one.";

  return (
    <View style={{ flexShrink: 1 }}>
      <View style={{ paddingHorizontal: 16, gap: 10, paddingBottom: 4 }}>
        {tabs}
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <View style={{ flex: 1 }}>
            <SearchField variant="capsule" mono value={query} onChangeText={setQuery} placeholder={onMac ? "Search, or paste a path" : "owner/repo, or a GitHub link"} onSubmitEditing={submit} accessibilityLabel={onMac ? `Folder path on ${name}, or search` : "GitHub link or owner/name, or search"} />
          </View>
          <Button label={onMac ? "Add" : "Clone"} variant="primary" round disabled={!ready} onPress={submit} />
        </View>
        {/* In line with the headings and rows under it. */}
        {onMac ? null : <Text style={[t.small, { paddingHorizontal: 4 }]}>{clones}</Text>}
      </View>
      <FadeScroll style={{ flexShrink: 1 }} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 4 }}>
        {/* A link typed on the Mac's tab (or a path on GitHub's) is offered across, as the desktop's field does. */}
        {onMac && field.kind === "repo" ? <SheetRow icon={github} label="Clone it from GitHub" detail={`That's a link, not a folder on ${name}`} onPress={() => carry("github")} /> : null}
        {!onMac && field.kind === "path" && mac ? <SheetRow icon={folder} label={`Add it as a folder on ${mac.name}`} detail="That's a path, not a GitHub link" onPress={() => carry("folder")} /> : null}
        {added.length ? (
          <SheetGroup label="Already added">
            {added.map((p) => (
              <SheetRow key={`added-${p.name}`} icon={mark} label={p.name} detail={[p.github, p.path && parent(p.path)].filter(Boolean).join(" · ") || undefined} onPress={() => onAdded(p.name)} />
            ))}
          </SheetGroup>
        ) : null}
        {list.length ? (
          <SheetGroup label={onMac ? `Found on ${name}` : "Your repositories"}>
            {list.map((x) => (
              <SheetRow
                key={x.name}
                icon={mark}
                label={x.name}
                detail={onMac ? (x.path && parent(x.path)) || undefined : [x.github, x.private ? "private" : null].filter(Boolean).join(" · ")}
                right={<Found sources={x.sources ?? []} clone={!x.path} age={x.age} />}
                hint={foundWords(x.sources ?? [], !x.path, x.age)}
                onPress={() => add(x)}
              />
            ))}
          </SheetGroup>
        ) : null}
        {!list.length && !added.length && field.kind === "search" ? <Text style={[t.small, { paddingHorizontal: 20, paddingVertical: 16 }]}>{empty}</Text> : null}
      </FadeScroll>
    </View>
  );
}
