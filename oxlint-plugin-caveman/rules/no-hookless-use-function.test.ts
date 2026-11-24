// ), oxlint-plugin-t3code/rules/no-hookless-use-function.test.ts @ 67eebaca23.
import { describe, expect, it } from "vitest";

import { lintFixture } from "../test/lint.ts";

const RULE = "caveman/no-hookless-use-function";

describe(RULE, () => {
  it.each([
    [
      "a hook that calls useState",
      `function useCount() { const [count] = useState(0); return count; }`,
    ],
    ["a hook that only calls use()", `const useTheme = () => { return use(ThemeContext); };`],
    ["a hook that calls a member hook", `const useStore = () => React.useContext(StoreContext);`],
    ["a plain function", `function formatLabel(value) { return String(value); }`],
    ["names that only start with use", `function user() { return null; }`],
  ])("allows %s", (_name, source) => {
    const result = lintFixture(RULE, source);
    expect(result.failed, result.output).toBe(false);
  });

  it.each([
    [
      "a hook-less function declaration",
      `function useFontFamily(weight) { return FONT_FAMILIES[weight]; }`,
    ],
    [
      "a hook-less arrow returning a closure",
      `const useUpdateSettings = () => (patch) => persist(patch);`,
    ],
    [
      "a hook-less function expression",
      `const useCompleteOnboarding = function () { return completeOnboarding; };`,
    ],
    [
      "a hook call that only happens inside a nested callback",
      `function useHandler() { return () => useState(0); }`,
    ],
    [
      "an event handler named like a hook",
      `const useKey = (e) => { e.preventDefault(); submit(); };`,
    ],
  ])("reports %s", (_name, source) => {
    const result = lintFixture(RULE, source);
    expect(result.failed, result.output).toBe(true);
    expect(result.output).toMatch(/caveman\(no-hookless-use-function\)/);
    expect(result.output).toMatch(/calls no hooks/);
  });
});
