// Who the app says you are. Signed in to Caveman, that is the account's email and nothing else: the scripted world's
// own person (board/world.ts YOU) stands in only on the scripted board, for someone who never signed in. A board that
// is the person's own never shows the script's name, email or organization, signed in or out.
import { YOU } from "../board/world";
import { useLink } from "../live/link";
import { isLive } from "../live/seams";

export interface Me {
  /** What a header calls you: the account's email, the scripted person's name, or "" on your own board while signed out. */
  name: string;
  /** One letter for the avatar; "" when there is nobody to name. */
  initial: string;
  /** The account's email; "" while signed out on your own board. */
  email: string;
  /** The scripted world's organization; null for a real account (the phone is not told one). */
  organization: string | null;
  /** Signed in to Caveman on this phone. */
  signedIn: boolean;
  /** The scripted world's person: nobody ever signed in here. */
  scripted: boolean;
}

export function useMe(): Me {
  const account = useLink((s) => s.account);
  if (account)
    return {
      name: account.email,
      initial: account.email.charAt(0).toUpperCase(),
      email: account.email,
      organization: null,
      signedIn: true,
      scripted: false,
    };
  if (isLive())
    return {
      name: "",
      initial: "",
      email: "",
      organization: null,
      signedIn: false,
      scripted: false,
    };
  return {
    name: YOU.name,
    initial: YOU.initial,
    email: YOU.email,
    organization: YOU.organization,
    signedIn: false,
    scripted: true,
  };
}
