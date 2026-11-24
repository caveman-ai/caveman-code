/* Copied once from Caveman Cloud cloud/web/tailwind.config.js (2026-10-15).
   The app owns it now; content paths live in each app's config. */
const motion = require("./src/styles/motion.json");

// Motion tokens (src/styles/motion.json, STYLE.md §8) as CSS values.
const bezier = ([a, b, c, d]) => `cubic-bezier(${a}, ${b}, ${c}, ${d})`;
const ms = (name) => `${motion.duration[name]}ms`;
const snap = bezier(motion.ease.snap);
// No spring: nothing in the app overshoots (motion.json).
const curves = Object.fromEntries(Object.entries(motion.ease).map(([name, points]) => [name, bezier(points)]));
// Every entrance is `from`-only on ease-snap with `backwards` fill: it ends on
// the element's own values (a row dimmed to opacity-65 fades to 65%, never to
// 100% and back), and once settled leaves no transform or filter behind, so
// the element never becomes a stacking context.
const entrances = Object.entries(motion.enter);

/** @type {import('tailwindcss').Config} */
module.exports = {
  // A tap leaves no hover behind: hover styles apply only where a pointer can hover (iOS keeps them stuck otherwise).
  future: { hoverOnlyWhenSupported: true },
  darkMode: ["class"],
  theme: {
    container: {
      center: true,
      padding: "2rem",
      screens: { "2xl": "1400px" }
    },
    extend: {
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))"
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))"
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))"
        },
        success: {
          DEFAULT: "hsl(var(--success))",
          foreground: "hsl(var(--success-foreground))"
        },
        info: {
          DEFAULT: "hsl(var(--info))",
          foreground: "hsl(var(--info-foreground))"
        },
        warning: {
          DEFAULT: "hsl(var(--warning))",
          foreground: "hsl(var(--warning-foreground))"
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))"
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))"
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))"
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))"
        },
        sidebar: {
          DEFAULT: "hsl(var(--sidebar))",
          foreground: "hsl(var(--sidebar-foreground))",
          accent: "hsl(var(--sidebar-accent))",
          "accent-foreground": "hsl(var(--sidebar-accent-foreground))",
          border: "hsl(var(--sidebar-border))"
        },
        // Lines added and removed (globals.css --diff-*): `text-diff-add-ink` for counts, `bg-diff-add/[0.08]` for lines.
        diff: {
          add: "hsl(var(--diff-add))",
          "add-ink": "hsl(var(--diff-add-ink))",
          del: "hsl(var(--diff-del))",
          "del-ink": "hsl(var(--diff-del-ink))"
        },
        // Ember = the brand flame mark ONLY (the one warm note). Never a UI
        // accent in the dark deck — kept so CaveMark/loaders stay on-brand.
        ember: {
          DEFAULT: "hsl(22 90% 52%)",
          glow: "hsl(28 95% 60%)"
        },
        // Named accents, rationed. moss IS the savings-green (= primary/success);
        // clay/sky are the decorative cool accents (indigo / cyan).
        moss: "hsl(142 69% 58%)",
        gold: "hsl(38 91% 58%)",
        clay: "hsl(232 56% 64%)",
        sky: "hsl(187 90% 48%)",
        indigo: "hsl(232 56% 64%)",
        cyan: "hsl(187 90% 48%)",
        /*
          Beautiful UI (beautifului.dev) token names, so its vendored
          records grid and streaming response styles compile under
          Tailwind 3. The VALUES live in styles/beautifui/foundation.css, where
          every one is derived from a deck token — so `bg-surface` and
          `bg-card` are the same pixel, and there is no second palette.
          `accent` is the one name both systems claim; theirs is namespaced to
          `bui-accent` (the deck's hover fill keeps the bare word).
        */
        page: "var(--page)",
        canvas: "var(--canvas)",
        surface: "var(--surface)",
        inset: "var(--inset)",
        ink: {
          DEFAULT: "var(--ink)",
          2: "var(--ink-2)",
          3: "var(--ink-3)"
        },
        hover: {
          DEFAULT: "var(--hover)",
          2: "var(--hover-2)"
        },
        field: "var(--field, transparent)",
        control: "var(--control-surface, transparent)",
        line: {
          DEFAULT: "var(--line)",
          strong: "var(--line-strong)",
          soft: "var(--line-soft)"
        },
        "bui-accent": {
          DEFAULT: "var(--bui-accent)",
          ink: "var(--bui-accent-ink)",
          tint: "var(--bui-accent-tint)"
        },
        green: {
          DEFAULT: "var(--green)",
          tint: "var(--green-tint)"
        },
        orange: {
          DEFAULT: "var(--orange)",
          tint: "var(--orange-tint)"
        },
        red: {
          DEFAULT: "var(--red)",
          tint: "var(--red-tint)"
        },
        chart: {
          1: "hsl(var(--chart-1))",
          2: "hsl(var(--chart-2))",
          3: "hsl(var(--chart-3))",
          4: "hsl(var(--chart-4))",
          5: "hsl(var(--chart-5))",
          other: "hsl(var(--chart-other, 0 0% 54%))"
        },
        // Caveman Code identity palette (styles/pixel.css, STYLE.md). Identity
        // only: mascot, engine tiles, pixel art. Never state, never chrome.
        id: {
          outline: "hsl(var(--id-outline) / <alpha-value>)",
          hair: "hsl(var(--id-hair) / <alpha-value>)",
          "hair-hi": "hsl(var(--id-hair-hi) / <alpha-value>)",
          skin: "hsl(var(--id-skin) / <alpha-value>)",
          "skin-shade": "hsl(var(--id-skin-shade) / <alpha-value>)",
          "skin-edge": "hsl(var(--id-skin-edge) / <alpha-value>)",
          "skin-light": "hsl(var(--id-skin-light) / <alpha-value>)",
          tunic: "hsl(var(--id-tunic) / <alpha-value>)",
          "tunic-shade": "hsl(var(--id-tunic-shade) / <alpha-value>)",
          bead: "hsl(var(--id-bead) / <alpha-value>)",
          "rock-deep": "hsl(var(--id-rock-deep) / <alpha-value>)",
          "rock-dark": "hsl(var(--id-rock-dark) / <alpha-value>)",
          "rock-mid": "hsl(var(--id-rock-mid) / <alpha-value>)",
          rock: "hsl(var(--id-rock) / <alpha-value>)",
          "rock-light": "hsl(var(--id-rock-light) / <alpha-value>)",
          claude: "hsl(var(--id-engine-claude) / <alpha-value>)",
          codex: "hsl(var(--id-engine-codex) / <alpha-value>)",
          acp: "hsl(var(--id-engine-acp) / <alpha-value>)"
        },
        // The one chrome blue: "here". Drop targets, the pane that just
        // landed, a picker's focused search underline. Never a state.
        target: {
          DEFAULT: "hsl(var(--target) / <alpha-value>)",
          foreground: "hsl(var(--target-foreground) / <alpha-value>)",
          strong: "hsl(var(--target-strong) / <alpha-value>)"
        }
      },
      /*
        Motion curves — the deck's three easings, named so nothing hand-rolls a
        cubic-bezier again. The stock CSS easings are too weak to read as
        intentional at UI durations (<300ms).

        tailwindcss-animate mirrors `transitionTimingFunction` into
        `animationTimingFunction`, so `ease-snap` works on `transition-*` AND on
        `animate-in` / `animate-out`.
      */
      // Named, not arbitrary: `duration-[120ms]` matches both the core transition and
      // tailwindcss-animate's animation utility, and Tailwind warns it is ambiguous.
      transitionDuration: { 120: "120ms" },
      transitionTimingFunction: {
        /*
          snap   — enter/exit. Strong ease-out: all the movement up front, so
                   the surface answers the moment you click it.
          swift  — something already on screen moving to a new place.
          drawer — iOS panel curve: sheets, long travel.
          There is no spring: nothing overshoots its resting place.
        */
        ...curves,
        // Pixel things move in frames, never tweens (STYLE.md "Motion").
        "steps-1": "steps(1, jump-end)",
        "steps-2": "steps(2, jump-end)",
        "steps-3": "steps(3, jump-end)",
        "steps-4": "steps(4, jump-end)",
        "steps-6": "steps(6, jump-end)",
        "steps-8": "steps(8, jump-end)"
      },

      borderRadius: {
        // Beautiful UI's named radii, mapped onto the deck's 0.5rem scale.
        chip: "var(--radius-chip)",
        control: "var(--radius-control)",
        card: "var(--radius-card)",
        window: "var(--radius-window)",
        xl: "calc(var(--radius) + 4px)",
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)"
      },
      fontFamily: {
        sans: ["var(--font-geist-sans)", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["var(--font-geist-mono)", "ui-monospace", "SFMono-Regular", "monospace"],
        display: ["var(--font-display)", "var(--font-geist-sans)", "ui-sans-serif", "sans-serif"],
        pixel: ["var(--font-pixel)", "var(--font-geist-mono)", "ui-monospace", "monospace"]
      },
      fontSize: {
        "2xs": ["0.6875rem", { lineHeight: "0.875rem", letterSpacing: "0.02em" }]
      },
      boxShadow: {
        // Green status-light ring on the primary action (the rationed accent glow).
        ember: "0 0 0 1px hsl(142 69% 58% / 0.30), 0 8px 30px -10px hsl(142 69% 50% / 0.35)",
        // Same green glow under a collision-free name: `shadow-ember` is ambiguous
        // against colors.ember, so Tailwind also emits it as box-shadow-COLOR and
        // the ring paints flame-orange. The auth CTA uses this token instead.
        torch: "0 0 0 1px hsl(142 69% 58% / 0.30), 0 8px 30px -10px hsl(142 69% 50% / 0.35)",
        "inner-top": "inset 0 1px 0 0 hsl(0 0% 100% / 0.04)",
        // Shared depth roles: quiet in-flow lift, stronger floating overlays.
        hairline: "var(--shadow-hairline)",
        btn: "var(--shadow-btn)",
        card: "var(--shadow-card)",
        raised: "var(--shadow-raised)",
        elevated: "var(--shadow-elevated)",
        frame: "var(--shadow-frame)",
        overlay: "var(--shadow-overlay, 0 8px 24px -6px hsl(0 0% 0% / 0.5))",
        // Hard pixel shadows: no blur, whole-pixel offsets (STYLE.md).
        px: "0 1px 0 0 hsl(0 0% 0% / 0.6)",
        "px-2": "0 2px 0 0 hsl(0 0% 0% / 0.6)",
        "px-lip": "inset 0 1px 0 0 hsl(0 0% 100% / 0.07), inset 0 -1px 0 0 hsl(0 0% 0% / 0.35)"
      },
      backgroundImage: {
        "ember-radial": "radial-gradient(60% 60% at 50% 0%, hsl(142 69% 50% / 0.16) 0%, transparent 70%)",
        "grain": "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.5'/%3E%3C/svg%3E\")"
      },
      keyframes: {
        // Entrances (src/styles/motion.json → src/components/motion.ts).
        ...Object.fromEntries(entrances.map(([name, { from }]) => [`${name}-in`, { from }])),
        "accordion-down": {
          from: { height: "0", opacity: "0" },
          to: { height: "var(--radix-accordion-content-height)", opacity: "1" }
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)", opacity: "1" },
          to: { height: "0", opacity: "0" }
        },
        shimmer: {
          "100%": { transform: "translateX(100%)" }
        },
        "ember-flicker": {
          "0%, 100%": { opacity: "1", transform: "scaleY(1) translateY(0)" },
          "25%": { opacity: "0.82", transform: "scaleY(1.08) translateY(-1px)" },
          "50%": { opacity: "0.95", transform: "scaleY(0.94) translateY(0.5px)" },
          "75%": { opacity: "0.78", transform: "scaleY(1.05) translateY(-0.5px)" }
        },
        "spark-rise": {
          "0%": { opacity: "0", transform: "translateY(6px) scale(0.6)" },
          "30%": { opacity: "1" },
          "100%": { opacity: "0", transform: "translateY(-16px) scale(1)" }
        },
        "pulse-ring": {
          "0%": { transform: "scale(0.85)", opacity: "0.7" },
          "70%, 100%": { transform: "scale(1.6)", opacity: "0" }
        },
        "draw": {
          to: { strokeDashoffset: "0" }
        },
        "spin-slow": {
          to: { transform: "rotate(360deg)" }
        },
        "fade-up": {
          from: { opacity: "0", transform: "translateY(8px)" },
          to: { opacity: "1", transform: "translateY(0)" }
        },
        "fade-in": {
          from: { opacity: "0" },
          to: { opacity: "1" }
        },
        // The Team stage (the site's /cloud hero): the console settles onto a
        // tilted plane, then drifts.
        "stage-settle": {
          from: { opacity: "0", transform: "translate(-46%, -46%) rotateX(58deg) rotateZ(-30deg)" },
          to: { opacity: "1", transform: "translate(-46%, -50%) rotateX(54deg) rotateZ(-26deg)" }
        },
        "stage-drift": {
          to: { transform: "translate(-49%, -53%) rotateX(54deg) rotateZ(-24deg)" }
        },
        // Skeletons hold at zero for 300ms, so a fast load never shows one.
        "skeleton-in": {
          from: { opacity: "0" }
        },
        // Centered-modal pop that keeps translate(-50%,-50%) constant so it scales
        // in place (no slide) — paired with `origin-top-right` it grows out of its
        // top-right corner. tailwindcss-animate's zoom-in drops the centering and
        // slides from bottom-right, which is exactly what we don't want here.
        "dialog-pop-in": {
          from: { opacity: "0", transform: "translate(-50%, -50%) scale(0.96)" },
          to: { opacity: "1", transform: "translate(-50%, -50%) scale(1)" }
        },
        "dialog-pop-out": {
          from: { opacity: "1", transform: "translate(-50%, -50%) scale(1)" },
          to: { opacity: "0", transform: "translate(-50%, -50%) scale(0.96)" }
        },
        "caret-blink": {
          "0%, 70%, 100%": { opacity: "1" },
          "20%, 50%": { opacity: "0" }
        },
        "count-glow": {
          "0%, 100%": { textShadow: "0 0 0px hsl(142 69% 58% / 0)" },
          "50%": { textShadow: "0 0 18px hsl(142 69% 58% / 0.45)" }
        },
        "pixel-blink": {
          "0%, 100%": { opacity: "0.16" },
          "50%": { opacity: "1" }
        },
        "dot-rain": {
          "0%": { filter: "brightness(1.4)", transform: "scale(1.02)" },
          "12%": { filter: "brightness(1.18)", transform: "scale(1.01)" },
          "26%": { filter: "brightness(1.05)", transform: "scale(1)" },
          "36%, 100%": { filter: "brightness(1)", transform: "scale(1)" }
        },
        // Hero entrance: each dot types in with a brief phosphor flash that
        // decays to its final color, 80s-terminal style. Row-major delays in
        // the component paint the field top band → bottom band. Opacity +
        // filter only (on a wrapper span), so it never fights dot-rain's
        // transform on the dot itself. This is per-dot arrival, not a
        // travelling bright edge — the no-scan-lines law still holds.
        "dot-type": {
          "0%": { opacity: "0", filter: "brightness(2)" },
          "8%": { opacity: "1", filter: "brightness(1.9)" },
          "45%": { opacity: "1", filter: "brightness(1.2)" },
          "100%": { opacity: "1", filter: "brightness(1)" }
        },
        "pixel-pop": {
          "0%": { opacity: "0", transform: "scale(0.4)" },
          "60%": { opacity: "1", transform: "scale(1.08)" },
          "100%": { opacity: "1", transform: "scale(1)" }
        },
        "scan": {
          "0%": { transform: "translateY(-100%)" },
          "100%": { transform: "translateY(100%)" }
        },
        "flow": {
          to: { strokeDashoffset: "-16" }
        },
        "marquee-l": {
          from: { transform: "translateX(0)" },
          to: { transform: "translateX(-50%)" }
        },
        "marquee-r": {
          from: { transform: "translateX(-50%)" },
          to: { transform: "translateX(0)" }
        }
      },
      animation: {
        ...Object.fromEntries(entrances.map(([name, { duration }]) => [`${name}-in`, `${name}-in ${ms(duration)} ${snap} backwards`])),
        // Exits run at about two thirds of the entrance (STYLE.md §8).
        "accordion-down": `accordion-down ${ms("base")} ${snap}`,
        "accordion-up": `accordion-up ${ms("fast")} ${snap}`,
        shimmer: "shimmer 1.6s infinite",
        "ember-flicker": "ember-flicker 1.4s ease-in-out infinite",
        "spark-rise": "spark-rise 1.6s ease-out infinite",
        "pulse-ring": "pulse-ring 1.8s ease-in-out infinite",
        "spin-slow": "spin-slow 2.4s linear infinite",
        "fade-up": `fade-up ${ms("scene")} ${snap} both`,
        "fade-in": `fade-in ${ms("slow")} ${snap} both`,
        stage: `stage-settle 2.4s ${snap} both, stage-drift 28s ease-in-out 2.4s infinite alternate`,
        // Held at zero for 300ms, so a fast load never shows a skeleton.
        "skeleton-in": `skeleton-in ${ms("base")} ${snap} 300ms backwards`,
        "dialog-pop-in": `dialog-pop-in ${ms("base")} ${snap} both`,
        "dialog-pop-out": `dialog-pop-out ${ms("fast")} ${snap} both`,
        "caret-blink": "caret-blink 1.25s ease-out infinite",
        "pixel-blink": "pixel-blink 1s steps(1, end) infinite",
        "dot-rain": "dot-rain 12s linear infinite",
        "dot-type": "dot-type 0.55s ease-out both",
        "pixel-pop": `pixel-pop ${ms("slow")} ${snap} both`,
        "scan": "scan 2.2s linear infinite",
        "flow": "flow 0.7s linear infinite",
        "marquee-l": "marquee-l 90s linear infinite",
        "marquee-r": "marquee-r 90s linear infinite"
      }
    }
  },
  plugins: [
    require("tailwindcss-animate"),
    // `touch:` for a screen with no hover (a phone, a tablet): what shows on hover shows there from the start, or a
    // finger could never reach it. `hover:` itself waits for a real pointer (future.hoverOnlyWhenSupported).
    function touchVariant({ addVariant }) {
      addVariant("touch", "@media (hover: none)");
    },
    // The curves as --ease-* variables, for the hand-written CSS in the apps and src/styles.
    function motionVariables({ addBase }) {
      addBase({ ":root": Object.fromEntries(Object.entries(curves).map(([name, curve]) => [`--ease-${name}`, curve])) });
    }
  ]
};
