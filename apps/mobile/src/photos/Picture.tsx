// One picture at a size, wherever pictures show: a library asset (`ph://`, which expo-image asks iOS for at the size it
// is drawn, never the full photo), a kept file, a blob on the web, or one of the web build's drawn screenshots. It
// fades in quickly over the raised fill as it arrives; one that can't load any more (a web blob after a reload, a
// photo since deleted) keeps the fill with the photo glyph, so a message never shows a hole.
import { Image, type ImageContentFit } from "expo-image";
import { useState } from "react";
import { View } from "react-native";
import type { SentImage } from "../board/model";
import { PhoneGlyph } from "../components/Pixel";
import { duration } from "../motion";
import { shotById } from "../shell/composer/attached";
import { useTheme } from "../theme";
import { current } from "./files";
import { ShotThumb } from "./ShotThumb";

/** What a picture needs to be shown: an attachment, a sent picture, a library photo. */
export type Pictured = Pick<SentImage, "uri" | "shot" | "width" | "height">;

/**
 * `fit`: cover for a thumbnail, contain to see it whole. `bare`: no fill under it while it loads (the viewer's black).
 * `label`: what VoiceOver says, when the picture is its own element rather than inside a labelled button.
 */
export function Picture({ image, width, height, radius, fit = "cover", bare = false, label, priority }: { image: Pictured; width: number; height: number; radius: number; fit?: ImageContentFit; bare?: boolean; label?: string; priority?: "low" | "normal" | "high" }) {
  const { c } = useTheme();
  const [broken, setBroken] = useState(false);
  const shot = image.shot ? shotById(image.shot) : undefined;
  if (shot) {
    const drawn = <ShotThumb shot={shot} width={width} height={height} radius={radius} />;
    return label ? (
      <View accessible accessibilityRole="image" accessibilityLabel={label}>
        {drawn}
      </View>
    ) : (
      drawn
    );
  }
  return (
    <View accessible={!!label} accessibilityRole={label ? "image" : undefined} accessibilityLabel={label} style={{ width, height, borderRadius: radius, overflow: "hidden", backgroundColor: bare ? undefined : c.raised, alignItems: "center", justifyContent: "center" }}>
      {broken || !image.uri ? (
        <PhoneGlyph name="photo" size={Math.min(24, Math.round(width / 3))} ink={c.subtle} />
      ) : (
        <Image
          source={{ uri: current(image.uri) }}
          recyclingKey={image.uri}
          contentFit={fit}
          transition={{ duration: duration.fast, effect: "cross-dissolve", skipOnCacheHit: "memory" }}
          priority={priority}
          onError={() => setBroken(true)}
          style={{ position: "absolute", top: 0, left: 0, width, height }}
          accessible={false}
        />
      )}
    </View>
  );
}

/**
 * The size a picture is drawn at to fit a box whole (the viewer, a lone picture in a message): its own proportions,
 * as large as fits. Without its size known, a phone's 3:4; a drawn screenshot is always a phone's.
 */
export function fitted(image: Pictured, box: { width: number; height: number }): { width: number; height: number } {
  const w = image.shot ? 3 : image.width || 3;
  const h = image.shot ? 4 : image.height || 4;
  const scale = Math.min(box.width / w, box.height / h);
  return { width: Math.round(w * scale), height: Math.round(h * scale) };
}
