// ), packages/provider-pi/src/client.ts @ ab3a3cd1 (adapted for the in-process Caveman engine).
/**
 * The Caveman engine's client definition: settings form, label and glyph (the
 * app's 16x16 pixel caveman, `packages/ui/src/assets/caveman.svg`, one path
 * per colour; `client.test.ts` fails when the two drift). Browser-safe.
 *
 * @module provider-caveman/client
 */
import { ProviderDriverKind } from "@caveman-app/protocol";
import { defineProviderClient } from "@caveman-app/engine-core/client";

import { CavemanSettings } from "./settings.ts";

const px = (d: string, color: string) => ({ d, fill: { light: color, dark: color } });

export const cavemanClient = defineProviderClient({
  driverKind: ProviderDriverKind.make("caveman"),
  label: "Caveman",
  settingsSchema: CavemanSettings,
  icon: {
    viewBox: "0 0 16 16",
    fill: { light: "#0d0914", dark: "#0d0914" },
    paths: [
      px("M5 0h6v1h-6zM3 1h2v1h-2zM11 1h2v1h-2zM2 2h1v1h-1zM13 2h1v1h-1zM1 3h1v1h-1zM14 3h1v1h-1zM1 4h1v1h-1zM14 4h1v1h-1zM1 5h1v1h-1zM14 5h1v1h-1zM1 6h1v1h-1zM5 6h1v1h-1zM10 6h1v1h-1zM14 6h1v1h-1zM1 7h1v1h-1zM14 7h1v1h-1zM1 8h1v1h-1zM14 8h1v1h-1zM1 9h1v1h-1zM14 9h1v1h-1zM0 10h1v1h-1zM2 10h1v1h-1zM13 10h1v1h-1zM15 10h1v1h-1zM0 11h1v1h-1zM3 11h1v1h-1zM12 11h1v1h-1zM15 11h1v1h-1zM0 12h1v1h-1zM4 12h1v1h-1zM11 12h1v1h-1zM15 12h1v1h-1zM0 13h1v1h-1zM5 13h1v1h-1zM10 13h1v1h-1zM15 13h1v1h-1zM0 14h1v1h-1zM6 14h4v1h-4zM15 14h1v1h-1zM0 15h16v1h-16z", "#0d0914"),
      px("M8 1h3v1h-3zM5 2h8v1h-8zM4 3h10v1h-10zM3 4h1v1h-1zM12 4h2v1h-2zM2 5h1v1h-1zM13 5h1v1h-1zM2 6h1v1h-1zM13 6h1v1h-1zM2 7h1v1h-1zM13 7h1v1h-1zM2 8h2v1h-2zM5 8h6v1h-6zM12 8h2v1h-2zM2 9h5v1h-5zM9 9h5v1h-5zM3 10h10v1h-10zM4 11h8v1h-8zM5 12h2v1h-2zM8 12h3v1h-3zM6 13h4v1h-4z", "#2c1912"),
      px("M5 1h3v1h-3zM3 2h2v1h-2zM2 3h2v1h-2zM2 4h1v1h-1zM12 13h1v1h-1zM3 14h1v1h-1z", "#58341e"),
      px("M4 4h8v1h-8zM3 5h10v1h-10zM3 6h2v1h-2zM6 6h1v1h-1zM9 6h1v1h-1zM11 6h2v1h-2zM3 7h3v1h-3zM10 7h3v1h-3zM4 8h1v1h-1zM11 8h1v1h-1zM1 10h1v1h-1zM14 10h1v1h-1zM1 11h2v1h-2zM13 11h2v1h-2zM1 12h2v1h-2zM13 12h2v1h-2zM1 13h1v1h-1zM14 13h1v1h-1z", "#f1b582"),
      px("M7 6h2v1h-2zM6 7h1v1h-1zM9 7h1v1h-1zM1 14h1v1h-1zM14 14h1v1h-1z", "#d07c4f"),
      px("M7 7h2v1h-2zM7 9h2v1h-2z", "#8b4530"),
      px("M3 12h1v1h-1zM12 12h1v1h-1zM2 13h3v1h-3zM11 13h1v1h-1zM13 13h1v1h-1zM2 14h1v1h-1zM4 14h2v1h-2zM10 14h4v1h-4z", "#eb9e3d"),
      px("M7 12h1v1h-1z", "#4add80"),
    ],
  },
});
