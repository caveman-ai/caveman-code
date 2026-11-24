// What step 1 (SignInStep.tsx) makes of cloud.status: who is signed in, and why a signed-in person's computer is not
// registered with Caveman. Pure, so the screen stays thin (docs/ "1. Sign in").

import type { CloudStatus } from "@caveman-app/session-protocol";
import { needsSignIn, notRegistered } from "../../state/cloud.ts";

type Account = NonNullable<CloudStatus["account"]>;

/**
 * The account the first run treats as signed in: one with a live enrollment (state/cloud.ts needsSignIn), or one the
 * runtime kept without a runtime identity because Caveman refused or could not register this computer (the account
 * stays first, DECIDED D1). Null while a sign-in waits for approval and for a Cloud that refused this computer.
 */
export function signedInAccount(status: CloudStatus | null): Account | null {
  if (!status?.account) return null;
  // No runtime identity: the account was kept without one, until a new sign-in waits for approval.
  if (status.runtime_id === undefined) return status.signin ? null : status.account;
  return needsSignIn(status) ? null : status.account;
}

/** The line under a signed-in account whose computer is not registered, or null when it is. Remote control is off. */
export function registrationProblem(status: CloudStatus | null): string | null {
  if (!notRegistered(status)) return null;
  return (
    status?.signin_error ?? "Remote control is off because Caveman did not register this computer."
  );
}
