// A pixel glyph in the quiet grey, for an empty list.
import { glyphPaths } from "@caveman-app/ui/icons/glyphs";
import type { PixelIconName } from "@caveman-app/ui/icons/names";
import { View } from "react-native";
import Svg, { Path } from "react-native-svg";
import { crisp, PixelIcon, stillGrid } from "../components/Pixel";
import { useTheme } from "../theme";

/**
 * A glyph in one grey, for a list with nothing in it: its state colour would claim something that isn't
 * there (an empty Needs you shows no amber).
 */
export function Quiet({
  name,
  size,
}: {
  name: Exclude<PixelIconName, "engine-caveman">;
  size: number;
}) {
  const { c } = useTheme();
  // Working's dots keep their own cell size (Pixel.tsx), still and in the quiet grey.
  if (name === "state-working")
    return <PixelIcon name={name} size={size} ink={c.subtle} animate={false} />;
  const drawn = crisp(size);
  return (
    <View
      aria-hidden
      style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}
    >
      <Svg width={drawn} height={drawn} viewBox="0 0 16 16">
        {glyphPaths(stillGrid(name)).map(({ char, d }) => (
          <Path
            key={char}
            d={d}
            fill={c.subtle}
            fillOpacity={char === ":" ? 0.4 : char === "+" ? 0.7 : char === "'" ? 0.16 : 1}
          />
        ))}
      </Svg>
    </View>
  );
}
