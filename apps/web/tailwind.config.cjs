/** @type {import('tailwindcss').Config} */
module.exports = {
  presets: [require("@caveman-app/ui/tailwind-preset")],
  content: [
    "./index.html",
    "./notch.html",
    "./src/**/*.{ts,tsx}",
    "../../packages/ui/src/**/*.{ts,tsx}",
  ],
};
