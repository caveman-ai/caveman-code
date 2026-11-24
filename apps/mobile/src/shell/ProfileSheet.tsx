// You, from the avatar at Home's top left (native Profile, IMG_5343; DECISIONS.md O8): a large sheet with who is
// signed in, what runs where, and the places that aren't Home's to hold: Automations, Computers and Settings. Review
// is the Ready tile's (O8) and Plugins live in Connect, so neither is here. It counts agents, never money: spend lives
// in Settings and Mission control, measured only. Computers and Settings are pushed over it, on the same sheet, and
// Back comes back here.
//
// Who is signed in comes from the one place that knows (me.ts). The scripted world's person, with a name, a plan and
// an organization, stands here only on the scripted board. On your own board it is your email and nothing else, or,
// signed out, the one row that signs you in.
import { StackActions } from "@react-navigation/native";
import { ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { DEVICES, deviceById } from "../board/model";
import { PixelIcon } from "../components/Pixel";
import { navigationRef } from "../nav/ref";
import type { RouteName } from "../nav/routes";
import { useRows } from "../store/select";
import { alpha, useTheme } from "../theme";
import { closeSidebar } from "./drawer";
import { useMe } from "./me";
import { PLAN } from "./settings/Account";
import { Sheet, SheetGroup, SheetRow } from "./Sheet";
import { openSettings } from "./ui";

const AVATAR = 88;

export function ProfileSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { c, t } = useTheme();
  const insets = useSafeAreaInsets();
  const me = useMe();
  const rows = useRows();
  // What runs where, from the same rows every count on Home comes from.
  const local = rows.filter((r) => deviceById(r.chat.device).kind === "mac").length;
  const cloud = rows.length - local;
  const online = DEVICES.filter((d) => d.status === "online").length;

  const push = (route: Extract<RouteName, "Automations">) => {
    onClose();
    // Pushed over the panel, which comes back from beside the sidebar to show it.
    closeSidebar();
    if (navigationRef.isReady()) navigationRef.dispatch(StackActions.push(route));
  };
  // Nobody to name: signed out on your own board.
  const nobody = !me.scripted && !me.signedIn;

  return (
    <Sheet open={open} onClose={onClose} detent="large" title="Profile" closeLabel="Close Profile">
      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 32 }}>
        {nobody ? (
          <SheetRow icon={<PixelIcon name="account" />} label="Sign in to Caveman" chevron onPress={() => openSettings("account")} />
        ) : (
          <View accessible accessibilityLabel={me.scripted ? `${me.name}, ${me.email}, ${PLAN.name} plan, ${me.organization}` : me.email} style={{ paddingHorizontal: 20, paddingTop: 8 }}>
            <View style={{ alignSelf: "center", width: AVATAR, height: AVATAR, borderRadius: AVATAR / 2, backgroundColor: c.raised, borderWidth: 1, borderColor: alpha(c.text, 0.06), alignItems: "center", justifyContent: "center" }}>
              <Text style={{ fontSize: 36, lineHeight: 42, fontWeight: "500", color: c.text, letterSpacing: -0.5 }}>{me.initial}</Text>
            </View>
            {me.scripted ? (
              <>
                <Text style={[t.title, { marginTop: 24 }]}>{me.name}</Text>
                <Text style={[t.row, { fontSize: 15, lineHeight: 20, color: c.muted, marginTop: 2 }]}>{me.email}</Text>
                <Text style={[t.row, { fontSize: 15, lineHeight: 20, color: c.muted, marginTop: 4 }]}>
                  {PLAN.name} plan · {me.organization}
                </Text>
              </>
            ) : (
              // Your own account: the email it is signed in with, and nothing the script made up.
              <Text numberOfLines={1} style={[t.title, { marginTop: 24 }]}>
                {me.email}
              </Text>
            )}
          </View>
        )}
        <View style={{ height: 1, marginHorizontal: 20, marginTop: nobody ? 8 : 20, backgroundColor: c.hairline }} />
 {/* Two counts side by side, as native "Local Agents | Cloud Agents". */}
        <View accessible accessibilityLabel={`${local} chats on your Mac, ${cloud} in Cloud`} style={{ flexDirection: "row", paddingHorizontal: 20, paddingTop: 20 }}>
          <Stat label="On your Mac" value={local} />
          <Stat label="In Cloud" value={cloud} />
        </View>
        {/* The scripted world's automations stand only on the scripted board: a phone reads none of a person's own yet. */}
        {me.scripted ? (
          <SheetGroup label="Work">
            <SheetRow icon={<PixelIcon name="automations" />} label="Automations" detail="Agents that run on a schedule" chevron onPress={() => push("Automations")} />
          </SheetGroup>
        ) : null}
        <SheetGroup label="You">
          <SheetRow
            icon={<PixelIcon name="computer-this-mac" />}
            label="Computers"
            // The scripted world's count. A person's own places each say their state in Settings > Computers; Cloud is
            // one place there, never a machine to count.
            {...(me.scripted ? { value: `${online} online` } : null)}
            chevron
            onPress={() => openSettings("computers")}
          />
          <SheetRow
            icon={<PixelIcon name="settings" />}
            label="Settings"
            chevron
            onPress={() => openSettings()}
          />
        </SheetGroup>
      </ScrollView>
    </Sheet>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  const { c, t } = useTheme();
  return (
    <View style={{ flex: 1, gap: 2 }}>
      <Text style={[t.row, { fontSize: 15, lineHeight: 20, color: c.subtle }]}>{label}</Text>
      <Text style={[t.title, { fontWeight: "500", fontVariant: ["tabular-nums"], color: c.soft }]}>{value}</Text>
    </View>
  );
}
