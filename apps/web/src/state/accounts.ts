// An engine's accounts as the client sorts them (Session Protocol README, "Sign in once"). A connection is an account
// the person made once, kept in Caveman Cloud: which one a chat runs on is their order's to say, never a chat's. A
// login or key kept on this computer is its own, and a chat can be put on it by hand.

type Placed = { readonly where?: "everywhere" | "cloud" | "this_mac" | undefined };

/** A connection kept in Caveman Cloud (EngineAccount.where `everywhere` or `cloud`). */
export const isConnection = (account: Placed): boolean =>
  account.where === "everywhere" || account.where === "cloud";

/**
 * The logins a chat, a pin or the Chief can be put on by hand: this computer's own. A connection is never one of
 * them, so every picker that lists logins, and every "which login is this" guess, reads its accounts through here.
 */
export const pickableLogins = <A extends Placed>(accounts: ReadonlyArray<A>): A[] =>
  accounts.filter((account) => !isConnection(account));
