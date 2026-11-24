// This repo's own oxlint rules, which .oxlintrc.json loads as a JS plugin. Each is a upstream rule
// (oxlint-plugin-t3code) that catches something real in this code; the rest of upstream are product-specific.
import { definePlugin } from "@oxlint/plugins";

import noHooklessUseFunction from "./rules/no-hookless-use-function.ts";
import requireSuppressionReason from "./rules/require-suppression-reason.ts";

export default definePlugin({
  meta: {
    name: "caveman",
  },
  rules: {
    "no-hookless-use-function": noHooklessUseFunction,
    "require-suppression-reason": requireSuppressionReason,
  },
});
