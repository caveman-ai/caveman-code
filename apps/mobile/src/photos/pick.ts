// The `+` menu's Photos and Camera: the system's own photo picker (no library access needed; several at once, numbered
// in the order picked, never more than the message has room for) and the camera, one picture. What they give back
// attaches to the box after what's there. On the web, Photos is the browser's file chooser and Camera the same, with
// the camera offered where the browser has one.
//
// A picked or taken picture is a file in the app's caches, which iOS may clear; it is copied into the app's documents
// first, so a message sent with it still shows it next week. One taken off the box before it was sent is deleted again.
import { Directory, File, Paths } from "expo-file-system";
import { launchCameraAsync, launchImageLibraryAsync, requestCameraPermissionsAsync, UIImagePickerPreferredAssetRepresentationMode, type ImagePickerAsset } from "expo-image-picker";
import { Linking, Platform } from "react-native";
import * as script from "../board/script";
import { attach, type Attachment, type AttachmentSource, MAX_ATTACHED, roomLeft } from "../shell/composer/attached";
import { notice } from "../shell/ui";

const NATIVE = Platform.OS === "ios" || Platform.OS === "android";
/** Where kept pictures live, under the app's documents. */
const KEPT = "attachments";

const full = () => script.notify(`A message takes ${MAX_ATTACHED} pictures at most`);

let kept = 0;
/** The picker's or the camera's file, copied where the system won't clear it; on the web (a blob) it stays as it is. */
async function keep(uri: string): Promise<string> {
  if (!NATIVE || !uri.startsWith("file:")) return uri;
  try {
    const dir = new Directory(Paths.document, KEPT);
    dir.create({ idempotent: true, intermediates: true });
    const from = new File(uri);
    const ext = from.extension.replace(/^\./, "") || "jpg";
    const to = new File(dir, `${Date.now().toString(36)}-${(kept++).toString(36)}.${ext}`);
    await from.copy(to);
    return to.uri;
  } catch {
    return uri;
  }
}

/**
 * A picture taken off the box before it was sent: the copy the app kept of it goes too (picked, taken, or shared in,
 * which share.ts keeps under Documents/share). Library assets are the library's and are left be.
 */
export function forget(a: Pick<Attachment, "uri" | "source">) {
  const kept = ((a.source === "picker" || a.source === "camera") && a.uri.includes(`/Documents/${KEPT}/`)) || (a.source === "share" && a.uri.includes("/Documents/share/"));
  if (!NATIVE || !kept) return;
  try {
    const file = new File(a.uri);
    if (file.exists) file.delete();
  } catch {
    // Already gone.
  }
}

async function attachAll(scope: string, assets: readonly ImagePickerAsset[], source: AttachmentSource): Promise<number> {
  const pictures = assets.filter((a) => a.type !== "video" && a.type !== "pairedVideo" && !a.mimeType?.startsWith("video/"));
  const items = await Promise.all(
    pictures.map(async (a): Promise<Omit<Attachment, "id">> => ({
      uri: await keep(a.uri),
      ...(a.width ? { width: a.width } : null),
      ...(a.height ? { height: a.height } : null),
      ...(a.fileName ? { name: a.fileName } : null),
      source,
      // Picked from the library with full access: the strip shows it ticked, and picking it twice adds it once.
      ...(a.assetId ? { asset: a.assetId.startsWith("ph://") ? a.assetId : `ph://${a.assetId}` } : null),
    })),
  );
  const added = attach(scope, items);
  if (added < items.length && roomLeft(scope) === 0) full();
  return added;
}

/** Photos: the system picker, several at once in the order picked. Returns how many it attached. */
export async function pickPhotos(scope: string): Promise<number> {
  const room = roomLeft(scope);
  if (!room) {
    full();
    return 0;
  }
  try {
    const result = await launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsMultipleSelection: true,
      selectionLimit: room,
      orderedSelection: true,
      // A HEIC comes back as a JPEG, which every engine reads.
      preferredAssetRepresentationMode: UIImagePickerPreferredAssetRepresentationMode.Compatible,
      shouldDownloadFromNetwork: true,
      quality: 1,
    });
    if (result.canceled || !result.assets?.length) return 0;
    return attachAll(scope, result.assets, "picker");
  } catch {
    script.notify("Couldn't open your photos");
    return 0;
  }
}

/** Camera: one picture, then it's on the box. Turned off for the app, the toast says so and opens Settings. */
export async function takePhoto(scope: string): Promise<number> {
  if (!roomLeft(scope)) {
    full();
    return 0;
  }
  try {
    if (NATIVE) {
      const allowed = await requestCameraPermissionsAsync();
      if (!allowed.granted) {
        notice({
          id: `camera-off-${Date.now()}`,
          text: "The camera is off for Caveman Code",
          tone: "info",
          icon: "camera",
          action: { label: "Settings", onPress: () => void Linking.openSettings() },
        });
        return 0;
      }
    }
    const result = await launchCameraAsync({ mediaTypes: ["images"], quality: 0.9 });
    if (result.canceled || !result.assets?.length) return 0;
    return attachAll(scope, result.assets, "camera");
  } catch {
    // The simulator, or a phone whose camera is busy.
    script.notify("There's no camera to use here");
    return 0;
  }
}
