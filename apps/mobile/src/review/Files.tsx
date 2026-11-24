// Files in the guide's order (apps/web/src/routes/review/Files.tsx, docs/): every
// changed hunk under the chapter that explains it (review/sections.ts), so a file the guide reads in three places reads
// in three parts ("notify.ts · 1 of 3"). Without a tour: code, then tests, then generated files, each file whole.
//
// Each part is its patch, hunk by hunk, with the unchanged run before a hunk said as a count and the block git names,
// a 44 pt Viewed box at its head and a Viewed row at its end, where your thumb is when you finish it; ticking either
// folds the part, as the desktop does, so what's left to read is what's open, and the end's row moves you on to the
// next part not yet viewed. A file is viewed once every part of it is. A section's head says how many of its parts
// are viewed and opens its chapter in the guide.
import { Text, View } from "react-native";
import { Icon } from "../components/Icon";
import { Squish } from "../components/Squish";
import { FileTypeMark } from "../components/transcript/FileTypeMark";
import { haptic } from "../motion";
import { alpha, mono, useTheme } from "../theme";
import { CodeCard, CodeRows, type Threads } from "./Code";
import { type DiffFile, gapBefore, hunksOf } from "./diff";
import { CALL_WORD, pad, splitPath } from "./model";
import { Counts, ReadCheck } from "./parts";
import { type Part, partsOf, type Section } from "./sections";

export { type Part, partsOf, type Section, sectionsOf } from "./sections";

/** Rows a part shows before it folds: a part is read whole, so only a long one folds. */
const FILE_FOLD = 60;

/** A file's whole patch, or some of its hunks, the unchanged run before each said as a count with the block git names. */
export function FileDiff({ file, header = true, threads, only }: { file: DiffFile; header?: boolean; threads?: Threads; /** The hunks to show, by index; all when absent. */ only?: readonly number[] }) {
  const { c, t } = useTheme();
  const hunks = hunksOf(file);
  const { dir, name } = splitPath(file.path);
  return (
    <CodeCard>
      {header ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: 44, paddingHorizontal: 12, borderBottomWidth: 1, borderBottomColor: alpha(c.text, 0.07) }}>
          <FileTypeMark path={file.path} size={14} />
          <Text numberOfLines={1} style={{ fontFamily: mono, fontSize: 13, color: c.text }}>
            {name}
          </Text>
          <Text numberOfLines={1} ellipsizeMode="head" style={{ flex: 1, fontFamily: mono, fontSize: 11.5, color: c.subtle }}>
            {dir.replace(/\/$/, "")}
          </Text>
          <Counts add={file.additions} del={file.deletions} size={12} />
        </View>
      ) : null}
      {hunks.map((h, i) => {
        if (only && !only.includes(i)) return null;
        const gap = gapBefore(hunks, i);
        const first = !only || only[0] === i;
        return (
          <View key={i}>
            {gap > 0 || h.context ? (
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: 32, paddingHorizontal: 12, backgroundColor: alpha(c.text, 0.025), borderTopWidth: first ? 0 : 1, borderBottomWidth: 1, borderColor: alpha(c.text, 0.06) }}>
                <Icon name="code" size={12} color={c.subtle} />
                <Text style={[t.meta, { fontSize: 12 }]}>{gap > 0 ? `${gap} unchanged ${gap === 1 ? "line" : "lines"}` : "From the top"}</Text>
                {h.context ? (
                  <Text numberOfLines={1} style={{ flex: 1, fontFamily: mono, fontSize: 11.5, color: c.subtle, textAlign: "right" }}>
                    {h.context}
                  </Text>
                ) : null}
              </View>
            ) : null}
            <CodeRows rows={h.rows} path={file.path} foldPast={FILE_FOLD} threads={threads} />
          </View>
        );
      })}
    </CodeCard>
  );
}

/** The 44 pt Viewed box, the head's and the end's. */
function ViewedBox({ name, viewed, onViewed, wide = false }: { name: string; viewed: boolean; onViewed: (on: boolean) => void; wide?: boolean }) {
  const { c, t } = useTheme();
  return (
    <Squish
      label={viewed ? `${name}, viewed. Unmark` : `Mark ${name} viewed`}
      selected={viewed}
      depth={0.97}
      onPress={() => {
        if (viewed) haptic.tick();
        else haptic.done();
        onViewed(!viewed);
      }}
      style={wide ? { flexDirection: "row", alignItems: "center", gap: 10, height: 48, paddingHorizontal: 14, marginTop: 8, borderRadius: 12, backgroundColor: alpha(c.text, 0.04) } : { flexDirection: "row", alignItems: "center", gap: 6, height: 44, paddingLeft: 10, paddingRight: 6 }}
    >
      <ReadCheck read={viewed} />
      <Text style={[t.small, { color: viewed ? c.success : wide ? c.text : c.muted }]}>{wide ? `Viewed ${name}` : "Viewed"}</Text>
      {wide ? <Text style={[t.meta, { flex: 1, textAlign: "right" }]}>then the next</Text> : null}
    </Squish>
  );
}

/** A part's place in Files: its head with the Viewed box, then its patch and the Viewed row, unless it is viewed. */
function PartBlock({ part, file, viewed, threads, onViewed, onLayout }: { part: Part; file: DiffFile | undefined; viewed: boolean; threads?: Threads; onViewed: (on: boolean, fromEnd: boolean) => void; onLayout: (y: number) => void }) {
  const { c, t } = useTheme();
  const { dir, name } = splitPath(part.path);
  const hunks = file ? hunksOf(file).filter((h) => part.hunks.includes(h.index)) : [];
  const add = hunks.reduce((n, h) => n + h.rows.filter((r) => r.kind === "add").length, 0);
  const del = hunks.reduce((n, h) => n + h.rows.filter((r) => r.kind === "del").length, 0);
  return (
    <View onLayout={(e) => onLayout(e.nativeEvent.layout.y)} style={{ paddingHorizontal: 12, paddingBottom: 12 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: 48, paddingLeft: 4 }}>
        <FileTypeMark path={part.path} size={15} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text numberOfLines={1} style={{ fontFamily: mono, fontSize: 14, lineHeight: 19, color: viewed ? c.muted : c.text }}>
            {name}
            {part.of > 1 ? <Text style={{ fontFamily: undefined, fontSize: 12, color: c.subtle }}>{`  ${part.index} of ${part.of}`}</Text> : null}
          </Text>
          <Text numberOfLines={1} ellipsizeMode="head" style={{ fontFamily: mono, fontSize: 11.5, lineHeight: 16, color: file?.status === "added" ? c.added : c.subtle }}>
            {file?.status === "added" ? "new file · " : ""}
            {dir.replace(/\/$/, "") || "/"}
          </Text>
        </View>
        <Counts add={add} del={del} size={12} />
        <ViewedBox name={name} viewed={viewed} onViewed={(on) => onViewed(on, false)} />
      </View>
      {viewed ? null : file ? (
        <>
          <FileDiff file={file} header={false} threads={threads} only={part.hunks} />
          <ViewedBox name={name} viewed={false} wide onViewed={(on) => onViewed(on, true)} />
        </>
      ) : (
        <Text style={[t.small, { paddingHorizontal: 4 }]}>This file changed with no lines to show: renamed, or binary.</Text>
      )}
    </View>
  );
}

/**
 * Every part, by chapter. `onPlace` reports where each part's head sits in this view, for the guide's jumps; the
 * section heads open their chapter.
 */
export function FilesView({ sections, files, viewed, threads, onViewed, onOpenStop, onPlace, verbs }: { sections: readonly Section[]; files: ReadonlyMap<string, DiffFile>; viewed: ReadonlySet<string>; threads?: Threads; onViewed: (part: Part, on: boolean, fromEnd: boolean) => void; onOpenStop: (stop: number) => void; onPlace: (part: string, y: number) => void; /** What waits once it's all viewed ("merge it, ask, or send it back"). */ verbs: string }) {
  const { c, t } = useTheme();
  const parts = partsOf(sections);
  const left = parts.filter((p) => !viewed.has(p.id));
  const linesLeft = left.reduce((n, p) => {
    const f = files.get(p.path);
    return n + (f ? hunksOf(f).filter((h) => p.hunks.includes(h.index)).reduce((m, h) => m + h.rows.filter((r) => r.kind !== "ctx").length, 0) : 0);
  }, 0);
  const children: React.ReactNode[] = [];
  sections.forEach((s, k) => {
    const seen = s.parts.filter((p) => viewed.has(p.id)).length;
    const all = seen === s.parts.length;
    children.push(
      <Squish
        key={s.id}
        label={`${s.stop !== null ? `Chapter ${s.stop + 1}, ` : ""}${s.title}${s.call ? `, ${CALL_WORD[s.call]}` : ""}, ${seen} of ${s.parts.length} viewed${s.stop !== null ? ". Read it in the guide" : ""}`}
        depth={0.99}
        disabled={s.stop === null}
        onPress={() => s.stop !== null && onOpenStop(s.stop)}
        style={{ flexDirection: "row", alignItems: "center", gap: 12, minHeight: 56, marginTop: k ? 20 : 0, paddingHorizontal: 16, borderTopWidth: k ? 1 : 0, borderTopColor: c.hairline }}
      >
        <View style={{ width: 26, height: 26, borderRadius: 13, alignItems: "center", justifyContent: "center", backgroundColor: all ? alpha(c.success, 0.16) : alpha(c.text, 0.08) }}>
          {all ? <Icon name="check" size={14} stroke={2.25} color={c.success} /> : s.stop !== null ? <Text style={{ fontFamily: mono, fontSize: 11.5, color: c.soft }}>{pad(s.stop + 1)}</Text> : <Icon name="diff" size={13} color={c.muted} />}
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={[t.label, { fontSize: 16, lineHeight: 21, fontWeight: "600" }]}>{s.title}</Text>
          {s.call ? <Text style={[t.small, { color: c.warning, lineHeight: 17 }]}>{CALL_WORD[s.call]}</Text> : null}
        </View>
        <Text style={t.meta}>
          {seen}/{s.parts.length}
        </Text>
        {s.stop !== null ? <Icon name="chevronRight" size={14} color={c.subtle} /> : null}
      </Squish>,
    );
    for (const part of s.parts) {
      children.push(<PartBlock key={part.id} part={part} file={files.get(part.path)} viewed={viewed.has(part.id)} threads={threads} onViewed={(on, fromEnd) => onViewed(part, on, fromEnd)} onLayout={(y) => onPlace(part.id, y)} />);
    }
  });
  return (
    <View>
      {children}
      <View style={{ paddingHorizontal: 16, paddingTop: 20, gap: 2 }}>
        <Text style={[t.body, { fontSize: 15, lineHeight: 22, color: left.length ? c.muted : c.text }]}>{left.length ? `${parts.length - left.length} of ${parts.length} viewed · ${linesLeft} ${linesLeft === 1 ? "line" : "lines"} left` : `Every file viewed. Your call now: ${verbs}.`}</Text>
      </View>
    </View>
  );
}
