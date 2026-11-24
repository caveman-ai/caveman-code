// Which way to GitHub the project step offers first. Connecting through Caveman installs the Caveman GitHub App, which
// only an owner or admin of the organization can do; for anyone below that, and for a person who has not signed in, it
// can only fail (docs: ). They get the gh CLI way (`gh auth login`) and nothing that would be refused. A person
// whose account can't be read (still loading, Cloud unreachable) is handled the same: gh always works, and the step
// never waits on Cloud.

import type { AccountSummary } from "@caveman-app/session-protocol";

/**
 * Whether this account may connect GitHub through Caveman. Cloud's role names as the runtime reads them
 * (packages/runtime cloudSignin.ts appRole): "owner" and "admin", in any case; every other role is a member.
 */
export const canConnectThroughCaveman = (
  account: Pick<AccountSummary, "signed_in" | "role"> | null | undefined,
): boolean => !!account?.signed_in && /^(owner|admin)$/i.test(account.role ?? "");

/** The gh CLI way goes first (and Caveman's is not offered) for signed-out people and for members below admin. */
export const ghFirst = (
  account: Pick<AccountSummary, "signed_in" | "role"> | null | undefined,
): boolean => !canConnectThroughCaveman(account);
