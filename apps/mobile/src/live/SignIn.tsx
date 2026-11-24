// Signing in to Caveman on this phone, as one row: "Sign in to Caveman" beside its button; while a sign-in is under
// way, the code to check on Caveman's page with Open and Cancel; signed in, the account with Sign out. Settings >
// Account holds it (words: signing in to Caveman is Settings > Account), and Settings > Computers shows the same row
// while nobody is signed in, so there is one way in and one set of words for it.
import { useEffect } from "react";
import { Text, View } from "react-native";

import { CardLine, RowButton, SettingRow } from "../shell/settings/kit";
import { mono, useTheme } from "../theme";
import { cancelSignIn, refresh, signIn, signOut, useLink } from "./link";
import * as platform from "./native";

export function SignInRow({
  signOutToo = false,
}: {
  /** Signed in, the row is the account with Sign out (Settings > Account); elsewhere it draws nothing then. */ signOutToo?: boolean;
}) {
  const { t } = useTheme();
  const account = useLink((s) => s.account);
  const signingIn = useLink((s) => s.signingIn);
  const problem = useLink((s) => s.problem);
  useEffect(() => void refresh(), []);
  if (account && !signOutToo) return null;
  return (
    <>
      {signingIn ? (
        <SettingRow
          label={
            <Text
              selectable
              accessibilityLabel={signingIn.code.split("").join(" ")}
              style={[t.code, { fontFamily: mono, fontSize: 20, lineHeight: 26, letterSpacing: 1 }]}
            >
              {signingIn.code}
            </Text>
          }
          description="Check this code on Caveman's page, then approve."
          // The code has the row's width to itself, so it is never broken over two lines on a narrow phone.
          stacked
        >
          <View style={{ flexDirection: "row", gap: 8 }}>
            <RowButton
              label="Open"
              onPress={() => platform.openUrl(signingIn.url)}
              accessibilityLabel="Open Caveman's page"
            />
            <RowButton label="Cancel" variant="ghost" onPress={cancelSignIn} />
          </View>
        </SettingRow>
      ) : account ? (
        <SettingRow label={account.email}>
          <RowButton label="Sign out" variant="ghost" onPress={() => void signOut()} />
        </SettingRow>
      ) : (
        <SettingRow label="Sign in to Caveman">
          <RowButton
            label="Sign in"
            variant="primary"
            onPress={() => void signIn()}
            disabled={account === undefined}
          />
        </SettingRow>
      )}
      {problem && !account ? <CardLine tone="bad">{problem}</CardLine> : null}
    </>
  );
}
