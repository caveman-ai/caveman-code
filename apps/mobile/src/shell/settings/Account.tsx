// Settings > Account on a phone: who is signed in to Caveman here, with Sign out (live/SignIn.tsx, the one sign-in
// row), and their plan as one of their computers reads it: a percent used and its reset for each limit, nothing else
// (account-model.ts). While no computer has answered, the page says nothing about the plan. Signed out on a board that
// is the person's own it is the one sign-in row. Someone who never signed in sees that row over the scripted world's
// account, its plan and its team, read-only.
import { Linking, Text, View } from "react-native";
import { YOU } from "../../board/world";
import { Icon } from "../../components/Icon";
import { Tag } from "../../components/ui/Badge";
import { useAgents } from "../../live/agents";
import { SignInRow } from "../../live/SignIn";
import { useTheme } from "../../theme";
import { useMe } from "../me";
import { planLines } from "./account-model";
import { Card, Page, SettingRow } from "./kit";
import { StatusRow, useAgentsWhileOpen } from "./Models";

/** Caveman Platform, where the team is managed (state/cloud.ts HOSTED_CLOUD); the one Caveman account signs in there too. */
export const CLOUD = "https://app.caveman.so";

/** The scripted world's person and plan, for someone who never signed in: also what the sidebar and Profile still read. */
export const ME = { name: YOU.name, initial: YOU.initial, email: YOU.email, organization: YOU.organization, role: "Owner" };
export const PLAN = { name: "Max", line: "Renews on Nov 14. Two free months to give." };
const MEMBERS = [
  { name: YOU.name, email: YOU.email, role: "Owner" },
  { name: "Charles Babbage", email: "charles@example.com", role: "Admin" },
  { name: null, email: "mary@example.com", role: "Member", invited: true },
];

export function AccountSettings({ description }: { description: string }) {
  const me = useMe();
  const account = useAgents((s) => s.account);
  const now = useAgentsWhileOpen();
  if (me.scripted) return <ScriptedAccount description={description} />;
  const plan = me.signedIn ? planLines(account, now) : [];
  return (
    <Page description={description}>
      <Card>
        {/* Signed in, the row is the account's email with Sign out; signed out, "Sign in to Caveman". */}
        <SignInRow signOutToo />
      </Card>
      {plan.length > 0 ? (
        <Card title="Plan">
          {plan.map((line) => (
            <StatusRow key={line.window} name={line.label} status={line.words} tone={line.tone} />
          ))}
        </Card>
      ) : null}
    </Page>
  );
}

/** The scripted world's account under the real sign-in row: nothing here signs anyone in or out but that row. */
function ScriptedAccount({ description }: { description: string }) {
  const { c, t } = useTheme();
  return (
    <Page description={description}>
      <Card>
        <SignInRow />
      </Card>
      <Card title="Caveman account">
        <SettingRow label={ME.email} description={`${ME.organization} · ${ME.role}`} />
        <SettingRow label="Plan" description={PLAN.line} under>
          <Text style={[t.row, { color: c.muted }]}>{PLAN.name}</Text>
        </SettingRow>
      </Card>
      <Card title="Team" description="Invites, roles, SSO and domains are managed in Caveman Platform.">
        {MEMBERS.map((m) => (
          <SettingRow
            key={m.email}
            label={
              <Text numberOfLines={1} style={t.row}>
                {m.name ?? m.email}
              </Text>
            }
            description={m.name ? m.email : undefined}
          >
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              {m.invited ? <Tag label="Invited" /> : null}
              <Text style={t.small}>{m.role}</Text>
            </View>
          </SettingRow>
        ))}
        <SettingRow label="Manage in Caveman Platform" onPress={() => void Linking.openURL(`${CLOUD}/team`)}>
          <Icon name="open" size={18} color={c.muted} />
        </SettingRow>
      </Card>
    </Page>
  );
}
