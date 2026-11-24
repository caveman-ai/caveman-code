// Text sizes are written in px across the app (Tailwind `text-[13px]`, plain
// CSS). This pass rewrites px font sizes and line heights to rem, so Settings >
// Appearance > Text size scales all text from the root size. Layout stays px.
const px = /(-?\d*\.?\d+)px\b/g;
const fontPxToRem = {
  postcssPlugin: "font-px-to-rem",
  Declaration(decl) {
    if (decl.prop === "font-size" || decl.prop === "line-height" || decl.prop === "font") {
      decl.value = decl.value.replace(px, (_, n) => `${Number(n) / 16}rem`);
    }
  },
};

module.exports = { plugins: [require("tailwindcss"), fontPxToRem, require("autoprefixer")] };
