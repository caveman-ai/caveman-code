// What a failed GitHub clone offers next (ProjectPicker.tsx): signing in when git could not authenticate, else a retry.
// The words are the runtime's: packages/runtime ProjectDiscovery.cloneFailure ("authentication failed", "repository not
// found, or private and git has no sign-in for it here") and environmentRemote.cloneFailure ("refused the credentials").

/** The way out of a failed clone: sign in to GitHub, or run the same add again. */
export type CloneWay = "sign-in" | "retry";

/** The command the GitHub row in onboarding gives (routes/onboarding/ProjectStep.tsx ConnectGithub). */
export const GH_LOGIN = "gh auth login";

// A private repository over https answers like a missing one, by asking for a sign-in git cannot give; so does a 401 or 403.
const AUTH =
  /authentication failed|has no sign-in|refused the credentials|could not read (?:username|password)|terminal prompts disabled|permission denied \(publickey\)|error: 40[13]|returned error: 40[13]|sign in to github/i;

/** Sign in when the clone failed for lack of a login; every other failure (network, timeout, unknown) is a retry. */
export function cloneWay(message: string): CloneWay {
  return AUTH.test(message) ? "sign-in" : "retry";
}
