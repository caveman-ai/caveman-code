// New Chief, from Home's "New Chief" row and Settings > Chiefs: a large sheet to name one, pick its character from
// the cast, and choose the projects it watches. The character stands at the top on its floor and takes the name as you
// type it, so you meet it before you make it. Create adds it to the board (board/script.ts addChief, kept on disk with
// the board): it joins Home's Chiefs list last, above New Chief, and its screen opens on its first line. On a real
// stack the runtime on your computer makes it (docs/chief.md, its profile). From Settings > Chiefs it is pushed over
// Settings, and Back comes back there; Create puts every sheet away, since the new Chief's screen opens under them.
import type { CastCharacter } from "@caveman-app/ui/mascot/poses";
import { type ReactNode, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import Animated, { useAnimatedKeyboard, useAnimatedStyle } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { projects as places } from "../board/places";
import { Icon } from "../components/Icon";
import { PixelIcon } from "../components/Pixel";
import { Sprite } from "../components/Sprite";
import { Button } from "../components/ui/Button";
import { Floor } from "../components/ui/Empty";
import { useInSheetFill } from "../components/ui/Floating";
import { haptic } from "../motion";
import { layout, useTheme } from "../theme";
import { Sheet, SheetGroup, SheetLabel, SheetRow } from "./Sheet";
import * as script from "../board/script";
import { showChief } from "../nav/ref";
import { closeSheet } from "./ui";

/** The cast a Chief can be: the people, then the two big animals. */
const CAST: readonly { id: CastCharacter; name: string }[] = [
  { id: "caveman", name: "Caveman" },
  { id: "cavewoman", name: "Cavewoman" },
  { id: "elder", name: "Elder" },
  { id: "kid", name: "Kid" },
  { id: "mammoth", name: "Mammoth" },
  { id: "sabertooth", name: "Sabertooth" },
];

/** 24 cells: 64pt is 8 device pixels a cell on a 3x screen, 48 is 6, so both stay crisp. */
const HERO = 64;
const PICK = 48;

export function NewChiefSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Sheet open={open} onClose={onClose} detent="large" title="New Chief" closeLabel="Close New Chief">
      {/* Drawn only while it is up (Sheet.tsx), so each time it opens the form starts empty. */}
      <Form />
    </Sheet>
  );
}

function Form() {
  const { c, t } = useTheme();
  const insets = useSafeAreaInsets();
  const keyboard = useAnimatedKeyboard();
  const [name, setName] = useState("");
  const [character, setCharacter] = useState<CastCharacter>("cavewoman");
  // Null watches every project, as the home Chief does.
  const [projects, setProjects] = useState<readonly string[] | null>(null);
  const named = name.trim();
  const toggle = (p: string) => {
    haptic.tick();
    setProjects((was) => {
      const now = was ?? [];
      const next = now.includes(p) ? now.filter((x) => x !== p) : [...now, p];
      return next.length ? next : null;
    });
  };
  const create = () => {
    if (!named) return;
    haptic.thud();
    const id = script.addChief({ name: named, character, tone: "medium", projects });
    closeSheet();
    // A new Chief is a place of its own: the main panel's root, as the sidebar opens one.
    showChief(id);
  };
  const foot = useAnimatedStyle(() => ({ paddingBottom: keyboard.height.value > 0 ? 12 : Math.max(insets.bottom, 12) }));
  const said = CAST.find((x) => x.id === character)?.name ?? "";

  return (
    <View style={{ flex: 1 }}>
      <ScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 24 }}>
        {/* The Chief you're making, on its floor, wearing the name you type. */}
        <View accessible accessibilityLabel={`${named || "Your new Chief"}, ${said}`} style={{ alignItems: "center", paddingTop: 4 }}>
          <Sprite character={character} tone="medium" size={HERO} />
          <Floor width={HERO + 48} cell={HERO / 24} sink />
          <Text numberOfLines={1} style={[t.title, { marginTop: 14, color: named ? c.text : c.subtle }]}>
            {named || "Your new Chief"}
          </Text>
        </View>
        <SheetLabel>Name</SheetLabel>
        <View style={{ paddingHorizontal: 16 }}>
          <Field value={name} onChangeText={setName} onSubmit={create} />
        </View>
        <SheetLabel>Character</SheetLabel>
        <View accessibilityRole="radiogroup" style={{ flexDirection: "row", flexWrap: "wrap", paddingHorizontal: 16, gap: 8 }}>
          {CAST.map((x) => (
            <Choice
              key={x.id}
              name={x.name}
              on={x.id === character}
              onPress={() => {
                haptic.tick();
                setCharacter(x.id);
              }}
            >
              <Sprite character={x.id} tone="medium" size={PICK} animate={false} />
            </Choice>
          ))}
        </View>
        <SheetGroup label="Watches">
          <SheetRow icon={<PixelIcon name="repo" />} label="Every project" detail="New projects too" right={projects === null ? <Icon name="check" size={18} color={c.text} stroke={2} /> : null} selected={projects === null} onPress={() => setProjects(null)} />
          {places.get().map(({ name: p }) => (
            <SheetRow key={p} icon={<PixelIcon name="repo" />} label={p} right={projects?.includes(p) ? <Icon name="check" size={18} color={c.text} stroke={2} /> : null} selected={!!projects?.includes(p)} onPress={() => toggle(p)} />
          ))}
        </SheetGroup>
      </ScrollView>
      <Animated.View style={[{ paddingHorizontal: 16, paddingTop: 12, borderTopWidth: 1, borderTopColor: c.hairline }, foot]}>
        <Button label={named ? `Create ${named}` : "Create"} variant={named ? "primary" : "secondary"} stretch disabled={!named} onPress={create} />
      </Animated.View>
    </View>
  );
}

/** The name, in the capsule every field in a sheet is (Field.tsx SearchField): 44pt, rounded 22, the in-sheet fill. */
function Field({ value, onChangeText, onSubmit }: { value: string; onChangeText: (v: string) => void; onSubmit: () => void }) {
  const { c, t } = useTheme();
  const fill = useInSheetFill();
  return (
    <TextInput
      value={value}
      onChangeText={onChangeText}
      placeholder="What should it be called?"
      placeholderTextColor={c.subtle}
      accessibilityLabel="Name"
      autoCapitalize="words"
      autoCorrect={false}
      returnKeyType="done"
      maxLength={24}
      onSubmitEditing={onSubmit}
      selectionColor={c.text}
      style={[t.body, { height: layout.float, borderRadius: layout.float / 2, paddingHorizontal: 18, fontSize: 17, lineHeight: 22, letterSpacing: -0.2, backgroundColor: fill }, { outlineStyle: "none" } as object]}
    />
  );
}

/**
 * One of the cast, on a flat `card` tile with a hairline and its name in grey; the one picked is filled with the
 * in-sheet grey (the sheet's chips' chosen fill, `control` in light) and named in ink at 500. No ring: nothing else on
 * the phone is chosen by a ring.
 */
function Choice({ name, on, onPress, children }: { name: string; on: boolean; onPress: () => void; children: ReactNode }) {
  const { c, t } = useTheme();
  const fill = useInSheetFill();
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityLabel={name}
      accessibilityState={{ selected: on, checked: on }}
      onPress={onPress}
      style={[
        {
          width: "31.8%",
          height: 104,
          borderRadius: layout.tile.radius,
          alignItems: "center",
          justifyContent: "center",
          gap: 6,
          backgroundColor: on ? fill : c.card,
          borderWidth: 1,
          borderColor: on ? "transparent" : c.hairline,
        },
        { outlineStyle: "none" } as object,
      ]}
    >
      {children}
      <Text numberOfLines={1} style={[t.small, { color: on ? c.text : c.muted, fontWeight: on ? "500" : "400" }]}>
        {name}
      </Text>
    </Pressable>
  );
}
