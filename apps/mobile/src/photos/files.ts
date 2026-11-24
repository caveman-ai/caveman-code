// Where a kept picture is now. Pictures the app keeps (picked, taken, shared in) live under its Documents folder and
// are saved in messages by their file URL, but iOS moves an app's container to a new folder when the app updates, so
// a saved URL points at the old one. Drawn, a URL into some Documents folder is read as the same file in this one's.
import { Platform } from "react-native";

const MARK = "/Documents/";
let documents: string | null | undefined;

function documentsNow(): string | null {
  if (documents !== undefined) return documents;
  try {
    const { Paths } = require("expo-file-system") as typeof import("expo-file-system");
    const uri = Paths.document.uri;
    documents = uri.endsWith("/") ? uri : `${uri}/`;
  } catch {
    documents = null;
  }
  return documents;
}

/** The URL to draw a picture from: a kept file's in today's Documents folder, anything else as it is. */
export function current(uri: string): string {
  if (Platform.OS !== "ios" || !uri.startsWith("file://")) return uri;
  const at = uri.indexOf(MARK);
  if (at < 0) return uri;
  const docs = documentsNow();
  return docs ? docs + uri.slice(at + MARK.length) : uri;
}
