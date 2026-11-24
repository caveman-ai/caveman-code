// ), apps/server/src/binCli.ts @ ab3a3cd1.
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Command } from "effect/cli";
import * as CliError from "effect/cli/CliError";

import * as NetService from "@caveman-app/shared/Net";
import { RUNTIME_VERSION } from "./runtimeVersion.ts";
import { acpMcpBridgeCommand, acpMcpCallCommand } from "./cli/acpMcpBridge.ts";
import { authCommand } from "./cli/auth.ts";
import { agentCommand, applyCommand, automationCommand, checkCommand, explainCommand } from "./cli/automation.ts";
import { appCommand } from "./cli/app.ts";
import { browserCommand } from "./cli/browser.ts";
import { extendConnectionAttemptTimeout, keepOutboundFetchOnHttp1 } from "./outboundHttp.ts";
import { sharedServerCommandFlags } from "./cli/config.ts";
import { projectCommand } from "./cli/project.ts";
import { runDefaultServerCommand, serveCommand, startCommand } from "./cli/server.ts";
import { claudeHistoryCommand } from "./cli/claudeHistory.ts";
import { themeCommand } from "./cli/theme.ts";
import { traceCommand } from "./cli/trace.ts";

const layerCliRuntime = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, NetService.layer);

export const makeCli = () =>
  Command.make("caveman-runtime", { ...sharedServerCommandFlags }).pipe(
    Command.withDescription("Run the Caveman Code runtime."),
    Command.withHandler(runDefaultServerCommand),
    Command.withSubcommands([
      Command.make("help").pipe(
        Command.withDescription("Show command help."),
        Command.withHandler(() =>
          Effect.fail(new CliError.ShowHelp({ commandPath: ["caveman-runtime"], errors: [] })),
        ),
      ),
      acpMcpBridgeCommand,
      acpMcpCallCommand,
      startCommand,
      serveCommand,
      appCommand,
      authCommand,
      browserCommand,
      projectCommand,
      claudeHistoryCommand,
      themeCommand,
      traceCommand,
      automationCommand,
      agentCommand,
      applyCommand,
      checkCommand,
      explainCommand,
    ]),
  );

export const cli = makeCli();

export function runCli() {
  extendConnectionAttemptTimeout();
  keepOutboundFetchOnHttp1();
  Command.run(cli, { version: RUNTIME_VERSION }).pipe(
    Effect.scoped,
    Effect.provide(layerCliRuntime),
    NodeRuntime.runMain,
  );
}
