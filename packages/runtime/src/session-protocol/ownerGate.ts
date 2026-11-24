// The methods that are the runtime's owner's alone, and the one check in front of them (handlers.ts puts its whole
// table behind `ownersAlone`).
//
// Other people can attach to a runtime: a teammate's device This Mac allowed on its own screen (devices.ts), another
// member of the org on a Cloud computer. They drive chats there. They never read, replace or remove the owner's keys
// and sign-ins, never change what runs with them, and never write what is the owner's own. So a method is here when it
//   - takes, keeps, removes or returns one of the owner's credentials, or a reference to one;
//   - signs this runtime in or out: of Caveman Cloud (which also names its owner), of a server, of GitHub;
//   - adds, removes or switches what runs with the owner's credentials attached: an MCP server, a marketplace, a
//     plugin and its hooks, an import of them, an automation;
//   - writes what the owner's later chats load, or reads it out of their home: a skill, their memory (rule.* checks
//     in rules.ts);
//   - changes the owner's list of projects, their shortcuts or any of their settings: a setting changes what runs here
//     or what leaves this computer, or is a pick of the person's that follows them to their other computers
//     (cloudLink/personSettings.ts). One answer in a chat writes a setting too, an app's Always allow, and is the
//     owner's alone to give (OWNERS_TO_SAY). A chat started in a folder that is not a project yet would add one to
//     their list, so only the owner starts one there (handlers.ts createWorkspace asks `ownersCall`);
//   - acts in Caveman Cloud as the owner: their Cloud computers, a chat started on one;
//   - moves a chat, or what a move brought, between computers: where a chat runs, and so where its history and its
//     work in progress go, is the owner's to say. A move the owner's own device signed is the owner's, whichever of
//     their devices asks; one Caveman Cloud passes on by mail never comes through this table, and This Mac checks its
//     signature itself (devices.ts queuedMoveAllowed);
//   - reads what Caveman Cloud or GitHub answers the owner's sign-in: their Cloud automations and published agents,
//     their repositories' Cloud setups and builds, their GitHub login and issues.
// A read is here too when its answer can hold a key as the owner typed it: a server's command line, a marketplace's
// URL, a webhook's path, a repository's origin. Reads that hold none stay open: plugin.list (the composer's mentions
// and a chat's cards read it), connector.list, github.status and github.issues, and an automation's files, runs and
// deliveries. So do the reads the chat screen itself makes: skill.list (the composer completes from it), project.list
// with project.logo.read (the image behind a project's logo) and project.branches, keybindings.get, settings.get, and
// cloud.status without a sign-in in progress (NOT_FOR_OTHERS).
// And what a chat they drive is made of: workspace.* (workspace.add_source adds only a source its project already
// has), session.fork, park and resume, the chat's own branch and pull request (git.*, pr.*), its files and terminals.
//
// On a Mac that names its owner none of this is reached by anyone else: its device check takes only the owner's
// devices (devices.ts). The gate still stands there, and is the only check on a Cloud computer, which has no device
// check, and on a Mac whose sign-in names nobody, whose screen still asks about any device.
//
// The owner is who handlers.ts `secretsAllowed` says: this computer's own clients, the runtime's own calls, and the
// Cloud user its enrollment names. secret.*, web.keys.*, engine.account.*, account.*, chief.*, rule.*, bug_report.*,
// dictation.*, the environment's calls as the person and a chat's preview check the same thing in their own files.
import type { MethodName, Params, Result } from "@caveman-app/session-protocol";
import * as Effect from "effect/Effect";

import { ProtocolError } from "./handlers.ts";
import { ALWAYS_ALLOW, isComputerAsk } from "./macDesktop/service.ts";

// What the gate says, in one shape: who can, and what. Never why it is built so.
const KEYS = "Only this computer's owner can change its plugin and server keys.";
const SECRET_PROVIDERS = "Only this computer's owner can see or change its secret providers.";
const SERVERS = "Only this computer's owner can see or change its MCP servers.";
const PLUGINS = "Only this computer's owner can see or change its plugins and marketplaces.";
const SIGN_INS = "Only this computer's owner can change its sign-ins.";
const IMPORTS = "Only this computer's owner can import into it.";
const AUTOMATIONS = "Only this computer's owner can see, change or run its automations.";
const CLOUD_SIGN_IN = "Only this computer's owner can sign it in to Caveman or out.";
const SKILLS = "Only this computer's owner can read or change its skills.";
const MEMORY = "Only this computer's owner can see or change its memory.";
const PROJECTS = "Only this computer's owner can see or change its projects.";
const SETTINGS = "Only this computer's owner can change its settings.";
const SHORTCUTS = "Only this computer's owner can change its shortcuts.";
const SPEND = "Only this computer's owner can see its usage.";
const CLOUD_COMPUTERS = "Only this computer's owner can use Cloud from it.";
const ALWAYS = "Only the owner can always allow an app. Allow it for this chat instead.";
const MOVES = "Only this computer's owner can move a chat.";
const CLOUD_SETUP = "Only this computer's owner can see its Cloud setup.";
const GITHUB = "Only this computer's owner can use its GitHub sign-in.";
/** What a chat in a folder that is not a project yet says to anyone but the owner: it would add one to their list. */
export const NOT_A_PROJECT =
  "Only this computer's owner can start a chat in a folder that is not a project yet.";

/** Every method this gate refuses to anyone but the owner, with what it says then. */
export const OWNERS_ALONE: { readonly [M in MethodName]?: string } = {
  // A plugin's or server's key: kept in the secret store, attached when its process starts.
  "credential.grant": KEYS,
  "credential.revoke": KEYS,
  // Secret managers (1Password) and the settings that point at them. `list` names the owner's vault items; `check`
  // reads one.
  "secret_provider.list": SECRET_PROVIDERS,
  "secret_provider.save": SECRET_PROVIDERS,
  "secret_provider.remove": SECRET_PROVIDERS,
  "secret_provider.check": SECRET_PROVIDERS,
  "secret_provider.refresh": SECRET_PROVIDERS,
  "secret_slot.set": SECRET_PROVIDERS,
  // Personal MCP servers. `list` answers each command line and URL as typed, which on a Mac may carry a key;
  // `tools` starts the server with the owner's keys.
  "mcp.list": SERVERS,
  "mcp.add": SERVERS,
  "mcp.remove": SERVERS,
  "mcp.set_enabled": SERVERS,
  "mcp.tools": SERVERS,
  // Marketplaces and plugins: their servers, hooks and commands run with the owner's keys. `marketplace.list` and
  // `plugin.read` answer a marketplace's source as typed, which may be a URL with a token.
  "marketplace.list": PLUGINS,
  "marketplace.add": PLUGINS,
  "marketplace.update": PLUGINS,
  "marketplace.remove": PLUGINS,
  "plugin.read": PLUGINS,
  "plugin.install": PLUGINS,
  "plugin.uninstall": PLUGINS,
  "plugin.set_enabled": PLUGINS,
  "plugin.set_trusted": PLUGINS,
  // Sign-ins the runtime (or Caveman Cloud, as the owner) then holds.
  "plugin.connect": SIGN_INS,
  "plugin.disconnect": SIGN_INS,
  "connector.connect": SIGN_INS,
  "connector.disconnect": SIGN_INS,
  "github.connect": SIGN_INS,
  // What the owner's other tools hold in their home (Claude Code, Codex, Cursor), and any folder on this computer:
  // the scans answer servers' command lines, and an import is the same add and install as above.
  "import.scan": IMPORTS,
  "import.apply": IMPORTS,
  "import.folder": IMPORTS,
  "mcp.import_scan": IMPORTS,
  "mcp.import": IMPORTS,
  // Automations run with nobody watching, as the owner. `list` answers a webhook's path with its secret token.
  "automation.list": AUTOMATIONS,
  "automation.create": AUTOMATIONS,
  "automation.file_write": AUTOMATIONS,
  "automation.save": AUTOMATIONS,
  "automation.set_enabled": AUTOMATIONS,
  "automation.allow": AUTOMATIONS,
  "automation.set_webhook_rules": AUTOMATIONS,
  "automation.rotate_url": AUTOMATIONS,
  "automation.delete": AUTOMATIONS,
  "automation.run": AUTOMATIONS,
  "automation.approve": AUTOMATIONS,
  "automation.run_cancel": AUTOMATIONS,
  "automation.run_apply": AUTOMATIONS,
  "automation.apply": AUTOMATIONS,
  "automation.cloud_answer": AUTOMATIONS,
  "agent.run": AUTOMATIONS,
  "agent.publish": AUTOMATIONS,
  // Who this runtime is signed in to Caveman Cloud as: an enrollment names the runtime's owner, so anyone who could
  // enroll it would make themselves that.
  "cloud.enroll": CLOUD_SIGN_IN,
  "cloud.signin": CLOUD_SIGN_IN,
  "cloud.signout": CLOUD_SIGN_IN,
  // Skills: `save` and `record` write where every engine loads them from the next chat on (the owner's home, a
  // project's checkout, a plugin's folder); `read` answers a file of the owner's home. skill.list stays open.
  "skill.read": SKILLS,
  "skill.save": SKILLS,
  "skill.record": SKILLS,
  // Memory: the owner's notes, which their chats start from. A write here counts as their own word.
  "memory.status": MEMORY,
  "memory.list": MEMORY,
  "memory.history": MEMORY,
  "memory.put": MEMORY,
  "memory.forget": MEMORY,
  "memory.undo": MEMORY,
  "memory.pin": MEMORY,
  "memory.keep": MEMORY,
  "memory.erase": MEMORY,
  "memory.import": MEMORY,
  // The owner's list of projects, and what a project gives every chat in it: its instructions, permissions and
  // actions (commands the owner's terminal runs). `discover` reads the folders of their home, `import_chats` their
  // Claude Code and Codex sessions, `repo.list` each origin as git holds it, which may carry a token, and
  // `logo.candidates` the images of a checkout (the logo itself shows to anyone in project.list).
  "project.create": PROJECTS,
  "project.update": PROJECTS,
  "project.remove": PROJECTS,
  "project.init_git": PROJECTS,
  "project.add_repo": PROJECTS,
  "project.remove_repo": PROJECTS,
  "project.import_chats": PROJECTS,
  "project.discover": PROJECTS,
  "project.logo.candidates": PROJECTS,
  "repo.list": PROJECTS,
  // A project's sources are what every chat in it may work in: the owner's to add and take out. workspace.add_source,
  // which gives a chat one its project already has, stays open.
  "project.add_source": PROJECTS,
  "project.remove_source": PROJECTS,
  // What the owner's other tools hold, as first run reads it.
  "setup.scan": IMPORTS,
  // Every setting: see the header. settings.get stays open.
  "settings.set": SETTINGS,
  "keybindings.set": SHORTCUTS,
  // What the owner's chats cost.
  "spend.summary": SPEND,
  // Caveman Cloud takes these as the member who signed this runtime in: their computers, a chat on a new one, and
  // the computer Cloud keeps standing for the chat they are about to start.
  "cloud.computers": CLOUD_COMPUTERS,
  "cloud.computer.set": CLOUD_COMPUTERS,
  "cloud.computer.delete": CLOUD_COMPUTERS,
  "cloud.workspace.create": CLOUD_COMPUTERS,
  "environment.warm": CLOUD_COMPUTERS,
  // Moves: a chat's history and work in progress go to another computer, or come here from one. `check` asks Caveman
  // Cloud as the owner and answers which of their logins a move would use; `held` answers the files a move held back,
  // this Mac's secret-shaped ones among them. (session.move.apply_held is this Mac's own screen's alone, in handlers.ts.)
  "session.move": MOVES,
  "session.move.check": MOVES,
  "session.move.held": MOVES,
  "session.adopt": MOVES,
  // What Caveman Cloud answers the owner's sign-in: their org's Cloud automations and runs, and the agents published there.
  "automation.cloud_list": AUTOMATIONS,
  "automation.cloud_runs": AUTOMATIONS,
  "agent.published": AUTOMATIONS,
  // GitHub as the owner's login sees it: who they are there, and a repository's issues.
  "github.status": GITHUB,
  "github.issues": GITHUB,
  // A repository's Cloud setup, its versions, builds and their logs, as Caveman Cloud answers the owner's sign-in
  // (the calls that change one check the owner in environments.ts).
  "environment.get": CLOUD_SETUP,
  "environment.draft": CLOUD_SETUP,
  "environment.list": CLOUD_SETUP,
  "environment.versions": CLOUD_SETUP,
  "environment.proposals": CLOUD_SETUP,
  "environment.ci": CLOUD_SETUP,
  "environment.build.get": CLOUD_SETUP,
  "environment.build.log": CLOUD_SETUP,
};

/**
 * What the answer to a method anyone may call leaves out for a caller who is not the owner. The notification that
 * carries the same answer goes through it too (server.ts cloud.changed).
 */
const NOT_FOR_OTHERS: { readonly [M in MethodName]?: (result: Result<M>) => Result<M> } = {
  // A sign-in in progress: whoever approves its code enrolls this runtime as themselves, and so becomes its owner.
  "cloud.status": ({ signin: _code, ...status }) => status,
};

/**
 * What only the owner may say in a call anyone may make: for such params, what the gate says to anyone else.
 */
const OWNERS_TO_SAY: { readonly [M in MethodName]?: (params: Params<M>) => string | undefined } = {
  // Always allow on an app's approval (computer use) is kept in the owner's settings, computer_use_apps: every later
  // chat on this Mac then uses that app without asking. Allow in this chat and Deny are anyone's who drives the chat.
  "ask.respond": ({ ask_id, response }) =>
    isComputerAsk(ask_id) && response.kind === "approval" && response.option_id === ALWAYS_ALLOW
      ? ALWAYS
      : undefined,
};

/** `result`, the answer to `method`, as a caller who is not the owner gets it. */
export const forOthers = <M extends MethodName>(method: M, result: Result<M>): Result<M> => {
  const without = NOT_FOR_OTHERS[method] as ((result: Result<M>) => Result<M>) | undefined;
  return without === undefined ? result : without(result);
};

type Caller =
  | {
      readonly connectionId?: string;
      readonly principal?: string | undefined;
      readonly agent?: unknown;
    }
  | undefined;
type Call = (params: never, ctx?: Caller) => Effect.Effect<unknown, ProtocolError>;

/**
 * Whether a call is the owner's, as `allowed` (handlers.ts secretsAllowed) reads its principal. A call with no
 * principal is the runtime's own. An outside agent's call (`agent`, which server.ts sets from its connection) counts
 * too: it came through the agents' own gate (outsideAgents.ts), which names every method an agent may call and at
 * which level the owner gave it.
 */
export const ownersCall = (
  allowed: (principal: string | undefined) => boolean,
  ctx: Caller,
): boolean => ctx?.agent !== undefined || allowed(ctx?.principal);

/**
 * `handlers` with every method of OWNERS_ALONE, and every call OWNERS_TO_SAY names, refused (`forbidden`) to a caller
 * `allowed` does not pass, before its handler runs, and every answer NOT_FOR_OTHERS names cut for such a caller.
 * `allowed` is asked on each call: who the owner is can change while the runtime runs. A call with no principal is the
 * runtime's own. Every other method is the handler it was.
 *
 * An outside agent's call is not this gate's to refuse (ownersCall): one the owner raised to Full access adds a
 * project there.
 */
export const ownersAlone = <H extends object>(
  allowed: (principal: string | undefined) => boolean,
  handlers: H,
): H => {
  const owners = (ctx: Caller) => ownersCall(allowed, ctx);
  return Object.fromEntries(
    Object.entries(handlers).map(([method, handler]) => {
      if (Object.hasOwn(NOT_FOR_OTHERS, method)) {
        const cut: Call = (params, ctx) => {
          const answer = (handler as Call)(params, ctx);
          return owners(ctx)
            ? answer
            : Effect.map(answer, (result) => forOthers(method as MethodName, result as never));
        };
        return [method, cut];
      }
      if (Object.hasOwn(OWNERS_TO_SAY, method)) {
        const refusal = OWNERS_TO_SAY[method as MethodName] as (
          params: unknown,
        ) => string | undefined;
        const heard: Call = (params, ctx) => {
          const why = owners(ctx) ? undefined : refusal(params);
          return why === undefined
            ? (handler as Call)(params, ctx)
            : Effect.fail(new ProtocolError({ reason: "forbidden", message: why }));
        };
        return [method, heard];
      }
      if (!Object.hasOwn(OWNERS_ALONE, method)) return [method, handler];
      const forbidden = new ProtocolError({
        reason: "forbidden",
        message: OWNERS_ALONE[method as MethodName]!,
      });
      const gated: Call = (params, ctx) =>
        owners(ctx) ? (handler as Call)(params, ctx) : Effect.fail(forbidden);
      return [method, gated];
    }),
  ) as H;
};
