#!/usr/bin/env node
// Stand-ins for the two official sign-ins "sign in once" runs (cloudLink/connectHere.ts), for tests: no Anthropic,
// no OpenAI, no one's login. They behave like the real CLIs where the runtime depends on it, and get every secret
// from the test Cloud's provider (cloudLink/testCloudEngine.ts), so a test never holds one.
//
//   node fake-plan-clis.mjs claude <provider-url> <log> setup-token
//     As `claude setup-token` (2.1.x): an Ink screen, redrawn in place and wrapped at the terminal's width, that
//     shows the sign-in link, waits for the person on the provider's page, then prints the token on a line of its
//     own above "Store this token securely". It keeps its state in CLAUDE_CONFIG_DIR, else in $HOME/.claude. With
//     FAKE_CLAUDE_PAGE_CODE=1 the page cannot reach this computer: it waits for the page's `code#state` at its prompt,
//     and refuses any other code as claude 2.1.322 does (an OAuth error, then Enter starts over on a new page).
//
//   node fake-plan-clis.mjs codex <provider-url> <log> [-c key=value]... login [--device-auth]
//     As `codex login` (0.165): prints the link (or the device page and a one-time code), waits, writes auth.json in
//     CODEX_HOME (else $HOME/.codex) and says "Successfully logged in". Only `-c cli_auth_credentials_store="file"`
//     makes it a file: without it this stand-in keeps the sign-in where a person's config may send it, the keyring.
//
//   node fake-plan-clis.mjs codex <provider-url> <log> [-c key=value]... exec <words>
//     One model request made as codex makes it: the sign-in from auth.json in CODEX_HOME, sent to the `base_url` of
// the model provider its `-c` arguments name. A 401 on a compact sign-in is refreshed as codex refreshes it (at
//     CODEX_REFRESH_TOKEN_URL_OVERRIDE, else the provider's own endpoint), written back and tried once more.
//
// <log> gets one JSON line per run: the arguments, the folders it was pointed at and the names (never the values) of
// its environment. No token is ever written there.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [cli, provider, logFile, ...args] = process.argv.slice(2);
const log = (entry) =>
  appendFileSync(
    logFile,
    `${JSON.stringify({ cli, args, home: process.env.HOME, env: Object.keys(process.env).sort(), ...entry })}\n`,
  );
const post = async (url, body) => {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** The person approving on the provider's page: asked for until they have. */
const approved = async (state) => {
  for (;;) {
    const { status, body } = await post(`${provider}/__provider/oauth/finish`, { state });
    if (status === 200) return body;
    if (status !== 202) process.exit(1);
    await sleep(150);
  }
};

/** Lines typed at the prompt, each once, as the terminal hands them over. */
const typedLines = () => {
  const lines = [];
  let wake;
  let typed = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    typed += chunk;
    for (let end = typed.search(/[\r\n]/); end !== -1; end = typed.search(/[\r\n]/)) {
      lines.push(typed.slice(0, end).trim());
      typed = typed.slice(end + 1);
    }
    wake?.();
  });
  return async () => {
    while (lines.length === 0) await new Promise((resolve) => (wake = resolve));
    return lines.shift();
  };
};

if (cli === "claude") {
  if (args[0] !== "setup-token") process.exit(2);
  const configDir = process.env.CLAUDE_CONFIG_DIR ?? join(process.env.HOME ?? "", ".claude");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, ".claude.json"),
    JSON.stringify({ firstStartTime: new Date().toISOString() }),
  );
  const columns = process.stdout.columns || 80;
  log({ configDir, columns, tty: process.stdout.isTTY === true });
  // Ink: each frame replaces the one before it, a frame the same as the last is not drawn again, and a line longer
  // than the terminal is broken there. `only`: as Ink's incremental redraw, only these lines are printed.
  let drawn = 0;
  let last = "";
  const frame = (lines, only) => {
    const wrapped = lines.flatMap((line) =>
      line.length <= columns ? [line] : (line.match(new RegExp(`.{1,${columns}}`, "g")) ?? []),
    );
    const out = wrapped.map((line) => `\x1b[38;5;246m${line}\x1b[39m`).join("\r\n");
    if (out === last) return;
    last = out;
    process.stdout.write(
      only === undefined
        ? `${"\x1b[2K\x1b[1A".repeat(drawn)}\x1b[2K\x1b[G${out}\r\n`
        : `\x1b[2K\x1b[G${only.map((line) => `\x1b[38;5;246m${line}\x1b[39m`).join("\r\n")}\r\n`,
    );
    drawn = wrapped.length;
  };
  frame(["Opening browser to sign in with your Claude account…"]);
  const begin = async () =>
    (await post(`${provider}/__provider/oauth/start`, { kind: "claude" })).body.state;
  const waitingOn = (state, first = "Opening browser to sign in with your Claude account…") => [
    first,
    "",
    "Browser didn't open? Use the url below to sign in",
    "",
    `https://claude.ai/oauth/authorize?code=true&client_id=fake-client&response_type=code&scope=user%3Ainference&state=${state}`,
    "",
    "Paste code here if prompted > ",
  ];
  let state = await begin();
  let shown = waitingOn(state);
  frame(shown);
  const spinner = setInterval(() => frame(shown), 200);
  // A browser that cannot reach this computer (FAKE_CLAUDE_PAGE_CODE, set by a test's wrapper): the page shows
  // `code#state`, and only that, typed at the prompt, finishes the sign-in. As claude 2.1.322: any other code is an
  // OAuth error and "Press Enter to retry"; Enter starts the sign-in over on a new page (a new state), and from then
  // on only that page's code is taken.
  if (process.env.FAKE_CLAUDE_PAGE_CODE === "1") {
    const next = typedLines();
    for (
      let line = await next();
      !(line.length > state.length + 1 && line.endsWith(`#${state}`));
      line = await next()
    ) {
      shown = shown.concat([
        "",
        "OAuth error: That code wasn't accepted. It may be incomplete, expired, already used, or from an earlier sign-in attempt. Sign in again to get a new code.",
        "",
        "Press Enter to retry.",
      ]);
      frame(shown);
      await next();
      state = await begin();
      shown = waitingOn(state, "Retrying…");
      // Only what changed is printed again: "Retrying…" and the new page, not the prompt under it.
      frame(shown, shown.slice(0, 5));
    }
    process.stdin.pause();
  }
  const { token } = await approved(state);
  clearInterval(spinner);
  frame([
    "✓ Long-lived authentication token created successfully!",
    "",
    "Your OAuth token (valid for 1 year):",
    "",
    token,
    "",
    "Store this token securely. You won't be able to see it again.",
    "",
    "Use this token by setting: export CLAUDE_CODE_OAUTH_TOKEN=<token>",
    "",
  ]);
  process.exit(0);
}

if (cli !== "codex") process.exit(2);
if (args.includes("--version")) {
  process.stdout.write("codex-cli 0.165.0\n");
  process.exit(0);
}
const overrides = args.flatMap((arg, i) => (args[i - 1] === "-c" ? [arg] : []));
const rest = args.filter((arg, i) => arg !== "-c" && args[i - 1] !== "-c");
const home = process.env.CODEX_HOME ?? join(process.env.HOME ?? "", ".codex");
const authFile = join(home, "auth.json");

if (rest[0] === "login") {
  const device = rest.includes("--device-auth");
  const file = overrides.includes('cli_auth_credentials_store="file"');
  log({ codexHome: home, store: file ? "file" : "keyring", device });
  const { body: started } = await post(`${provider}/__provider/oauth/start`, { kind: "chatgpt" });
  if (device) {
    process.stdout.write(
      `\r\nFollow these steps to sign in with ChatGPT using device code authorization:\r\n\r\n1. Open this link in your browser and sign in to your account\r\n   \x1b[94mhttps://auth.openai.com/codex/device\x1b[0m\r\n\r\n2. Enter this one-time code \x1b[90m(expires in 15 minutes)\x1b[0m\r\n   \x1b[94mF4KE-C0DE9\x1b[0m\r\n\r\n`,
    );
  } else {
    process.stdout.write(
      `Starting local login server on http://localhost:1455.\r\nIf your browser did not open, navigate to this URL to authenticate:\r\n\r\nhttps://auth.openai.com/oauth/authorize?response_type=code&client_id=fake-client&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&state=${started.state}\r\n\r\nOn a remote or headless machine? Use \`codex login --device-auth\` instead.\r\n`,
    );
  }
  const tokens = await approved(started.state);
  if (file) {
    mkdirSync(home, { recursive: true });
    writeFileSync(
      authFile,
      JSON.stringify({
        auth_mode: "chatgpt",
        OPENAI_API_KEY: null,
        tokens: {
          id_token: tokens.id_token,
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          account_id: tokens.account_id,
        },
        last_refresh: new Date().toISOString(),
      }),
      { mode: 0o600 },
    );
  }
  process.stdout.write("Successfully logged in\r\n");
  process.exit(0);
}

if (rest[0] === "exec") {
  const base = /base_url = "([^"]+)"/.exec(overrides.join("\n"))?.[1];
  if (base === undefined || !existsSync(authFile)) {
    log({ codexHome: home, said: "not signed in" });
    process.stdout.write("codex: not signed in\n");
    process.exit(1);
  }
  const read = () => JSON.parse(readFileSync(authFile, "utf8"));
  const ask = async () => {
    const auth = read();
    const headers = auth.tokens
      ? {
          authorization: `Bearer ${auth.tokens.access_token}`,
          "chatgpt-account-id": auth.tokens.account_id ?? "",
        }
      : { authorization: `Bearer ${auth.OPENAI_API_KEY}` };
    const response = await fetch(`${base}/responses`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({ model: "gpt-fake", stream: true, input: rest.slice(1).join(" ") }),
    });
    return { status: response.status, text: await response.text() };
  };
  let answer = await ask();
  let refreshed = false;
  const refreshAt =
    process.env.CODEX_REFRESH_TOKEN_URL_OVERRIDE ?? `${provider}/__provider/oauth/token`;
  if (answer.status === 401 && read().tokens) {
    const auth = read();
    const fresh = await post(refreshAt, {
      client_id: "fake-client",
      grant_type: "refresh_token",
      refresh_token: auth.tokens.refresh_token,
    });
    if (fresh.status === 200) {
      refreshed = true;
      writeFileSync(
        authFile,
        JSON.stringify({
          ...auth,
          tokens: {
            ...auth.tokens,
            ...(fresh.body.access_token ? { access_token: fresh.body.access_token } : {}),
            ...(fresh.body.refresh_token ? { refresh_token: fresh.body.refresh_token } : {}),
            ...(fresh.body.id_token ? { id_token: fresh.body.id_token } : {}),
          },
          last_refresh: new Date().toISOString(),
        }),
        { mode: 0o600 },
      );
      answer = await ask();
    }
  }
  log({
    codexHome: home,
    status: answer.status,
    refreshed,
    refreshOverridden: process.env.CODEX_REFRESH_TOKEN_URL_OVERRIDE !== undefined,
  });
  if (answer.status !== 200) {
    let message = "";
    try {
      message = JSON.parse(answer.text).error?.message ?? "";
    } catch {
      message = "";
    }
    process.stdout.write(`codex error ${answer.status}: ${message}\n`);
    process.exit(1);
  }
  const said = [...answer.text.matchAll(/^data: (.*)$/gm)]
    .map((line) => JSON.parse(line[1]))
    .filter((event) => event.type === "response.output_text.delta")
    .map((event) => event.delta)
    .join("");
  process.stdout.write(`codex said: ${said}\n`);
  process.exit(0);
}
process.exit(2);
