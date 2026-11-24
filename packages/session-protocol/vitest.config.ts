// `pnpm -r test` runs this package from its own directory, where vitest would otherwise use its defaults (a 5 s test
// timeout, the developer's own home) instead of the repo's.
import baseConfig from "../../vitest.config.ts";

export default baseConfig;
