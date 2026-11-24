import { describe, expect, test } from "vitest";
import { containsKnownSecret, createScrubber, detectSecrets, extractKnownSecrets, isHideable, isReservedEnvName, parseDotenv, repositoryKey, SECRET_NAME_PATTERN, secretsNotice } from "../src/secrets.ts";

const STRIPE = ("sk_" + "live_51Hx9QaZ8bYc7dWe6fVg5hUi4jTk3");
const DB = "postgres://app:Zq8vR2mW9xLp4tNs@db.internal:5432/app";

describe("detectSecrets", () => {
  test("an env file is env, with comments, export, quotes and a multi-line key", () => {
    const text = [
      "# stripe",
      `export STRIPE_SECRET_KEY=${STRIPE}`,
      `DATABASE_URL="${DB}" # prod`,
      "PEM=\"-----BEGIN PRIVATE KEY-----",
      "abc",
      "-----END PRIVATE KEY-----\"",
      "EMPTY=",
      "NODE_ENV=development # inline",
    ].join("\n");
    const d = detectSecrets(text);
    expect(d.kind).toBe("env");
    if (d.kind !== "env") return;
    expect(d.entries.map((e) => e.name)).toEqual(["STRIPE_SECRET_KEY", "DATABASE_URL", "PEM", "NODE_ENV"]);
    expect(d.entries[1]!.value).toBe(DB);
    expect(d.entries[2]!.value).toBe("-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----");
    expect(d.entries[3]!.value).toBe("development");
  });

  test("a bare known key is a token with a suggested name", () => {
    expect(detectSecrets(`  ${STRIPE}\n`)).toEqual({ kind: "token", entries: [{ name: "STRIPE_SECRET_KEY", value: STRIPE }] });
    expect(detectSecrets(("sk-" + "ant-api03-abcdefghijklmnopqrstuvwxyz012345"))).toMatchObject({
      kind: "token",
      entries: [{ name: "ANTHROPIC_API_KEY" }],
    });
  });

  test("an unknown random word is a token without a name", () => {
    expect(detectSecrets("Xk9fQ2mZ7vB4nL8pR3tW6yH1")).toMatchObject({ kind: "token", entries: [{ name: "" }] });
  });

  test("a long name made of words, sent on its own, is text and not a key", () => {
    for (const text of [
      "fix-calendar-sync-timezone",
      "feature-branch-for-calendar-sync",
      "fix-login-redirect-loop-now",
      "update-the-readme-with-install-steps",
      "snake_case_function_name_for_tests",
      "SOME_VERY_LONG_CONSTANT_NAME",
      "ThisIsMyFavoriteProjectName",
      "getUserProfileSettingsById",
      "useHTTPClientForAPIRequests",
      "release-2024-11-06-hotfix-rc1",
      "oauth2-callback-handler-for-google",
      "fix-pnpm-lockfile-for-ci-builds",
      "migrate-mysql-to-postgres-on-k8s",
      "handleWebSocketReconnectAttempt",
      "DATABASE_CONNECTION_POOL_SIZE",
    ]) {
      expect(detectSecrets(text), text).toEqual({ kind: "none" });
    }
    for (const key of [
      "Xk9fQ2mZ7vB4nL8pR3tW6yH1",
      "q7w2e9r4t1y8u3i6o5p0a2s7d4f9",
      "Q7W2E9R4T1Y8U3I6O5P0A2S7D4F9",
      "aB3_xY9-kLm2_Qr7-ZtW4_pV8-nHs6",
      "KRSXG5CTMVRXEZLUKN2XAZLSONSWG4TF",
      "MlwnhtZZZWa8ajJsyvwxnwRM",
      "pjEnoKnysbigDOKYrksl04jr",
      "cSjQfzHNzhuhydHFMNsZjmylcsHZEIsdpedmqdxt",
      "GAYBEZCHQZOOYWJIAELNMMJSZEQMSA4X",
    ]) {
      expect(detectSecrets(key), key).toEqual({ kind: "token", entries: [{ name: "", value: key }] });
    }
  });

  test("a random key stays a key whatever its letters happen to spell", () => {
    // Seeded (mulberry32), so a key it misses is missed again on every run.
    let seed = 0x5ec2e7;
    const random = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const letters = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const alphabets = {
      base62: `${letters}0123456789`,
      base64url: `${letters}0123456789-_`,
      base32: "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567",
      letters,
    };
    const missed: string[] = [];
    let checked = 0;
    for (const [shape, alphabet] of Object.entries(alphabets)) {
      for (let i = 0; i < 1000; i++) {
        const length = 24 + Math.floor(random() * 41);
        let key = "";
        for (let j = 0; j < length; j++) key += alphabet[Math.floor(random() * alphabet.length)];
        // Capitals alone are one kind of character, as a shouted word is: no key to tell apart.
        if (shape === "base32" && !/[2-7]/.test(key)) continue;
        checked++;
        if (detectSecrets(key).kind !== "token") missed.push(`${shape} ${key}`);
      }
    }
    expect(checked).toBeGreaterThan(3900);
    expect(missed).toEqual([]);
  });

  test("prose and code are not env; a key inside prose is embedded", () => {
    expect(detectSecrets("const x = 1\nfoo()")).toEqual({ kind: "none" });
    expect(detectSecrets("PORT=3000")).toEqual({ kind: "none" });
    expect(detectSecrets("PORT=3000\nHOST=localhost\nNODE_ENV=development")).toEqual({ kind: "none" });
    expect(detectSecrets("5f333f35d1a2b3c4d5e6f708192a3b4c5d6e7f80")).toEqual({ kind: "none" });
    expect(detectSecrets("6f1c2b9e-4d3a-4f7e-9a51-0c2d8e7b1a44")).toEqual({ kind: "none" });
    expect(detectSecrets("src/components/secrets/SecretSheet.tsx")).toEqual({ kind: "none" });
    expect(detectSecrets("please fix the login page")).toEqual({ kind: "none" });
    expect(detectSecrets("https://github.com/caveman-ai/caveman-code")).toEqual({ kind: "none" });
    expect(detectSecrets(`use ${STRIPE} for the test`)).toEqual({ kind: "embedded" });
  });

  test("one secret-looking assignment is env", () => {
    expect(detectSecrets("API_TOKEN=abc123def456").kind).toBe("env");
  });

  test("words that end in sk (task-, desk-, mask-, flask-) and kebab names are text, not keys", () => {
    for (const text of [
      "Fix the flaky test in task-scheduler-integration.test.ts",
      "git checkout -b fix/desk-booking-calendar-sync",
      "https://github.com/acme/mask-detection-model-training-pipeline",
      "the notes are in task-2024-11-06-weekly-sync-notes",
      "compare flask-or-django-for-the-admin-backend",
      ("read kiosk-" + "ant-colony-routing-experiment-notes first"),
      "scripts/sk-rotation-script-for-production.sh",
    ]) {
      expect({ contains: containsKnownSecret(text), detected: detectSecrets(text).kind, extracted: extractKnownSecrets(text) }, text).toEqual({
        contains: false,
        detected: "none",
        extracted: { entries: [], text },
      });
    }
  });

  test("OpenAI, Anthropic and OpenRouter keys are still caught wherever they sit", () => {
    const keys = {
      OPENAI_API_KEY: ["sk-Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4zAb3dEf6hIj9kLm2n", ("sk-" + "proj-Ab3dEf6hIj9_kLm2nOp5qRs8-tUv1wXy4z")],
      ANTHROPIC_API_KEY: [("sk-" + "ant-api03-Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4z-AA")],
      OPENROUTER_API_KEY: ["sk-or-v1-0123456789abcdef0123456789abcdef"],
    };
    for (const [name, values] of Object.entries(keys)) {
      for (const key of values) {
        expect(detectSecrets(key), key).toEqual({ kind: "token", entries: [{ name, value: key }] });
        for (const text of [`use ${key} here`, `OPENAI=${key}`, `Authorization: Bearer ${key}`, `"${key}"`, `line one\n${key}`]) {
          expect(extractKnownSecrets(text), text).toEqual({ entries: [{ name, value: key }], text: text.replace(key, `$${name}`) });
        }
      }
    }
  });
});

describe("extractKnownSecrets", () => {
  test("keys inside prose become $NAME; a repeated value keeps one name", () => {
    const other = ("sk_" + "live_99Hx9QaZ8bYc7dWe6fVg5hUi4jTk");
    const r = extractKnownSecrets(`use ${STRIPE} here, ${STRIPE} again and ${other} there`);
    expect(r.text).toBe("use $STRIPE_SECRET_KEY here, $STRIPE_SECRET_KEY again and $STRIPE_SECRET_KEY_2 there");
    expect(r.entries).toEqual([
      { name: "STRIPE_SECRET_KEY", value: STRIPE },
      { name: "STRIPE_SECRET_KEY_2", value: other },
    ]);
  });
});

describe("parseDotenv", () => {
  test("counts lines that are not assignments", () => {
    expect(parseDotenv("A=1\nnot an assignment\nB='x # y'").rest).toBe(1);
    expect(parseDotenv("B='x # y'").entries).toEqual([{ name: "B", value: "x # y" }]);
  });
});

describe("createScrubber", () => {
  const s = createScrubber([
    { name: "STRIPE_SECRET_KEY", value: STRIPE },
    { name: "DATABASE_URL", value: DB },
    { name: "NODE_ENV", value: "development" },
  ]);

  test("raw, JSON-escaped, URL-encoded and base64 forms all go", () => {
    expect(s.scrub(`key=${STRIPE}`)).toBe("key=[secret:STRIPE_SECRET_KEY]");
    expect(s.scrub(JSON.stringify({ url: DB }))).toBe('{"url":"[secret:DATABASE_URL]"}');
    expect(s.scrub(encodeURIComponent(DB))).toBe("[secret:DATABASE_URL]");
    for (const prefix of ["", "u:", "us:"]) {
      const encoded = btoa(prefix + STRIPE);
      expect(s.scrub(encoded)).not.toContain(btoa(STRIPE).slice(4, 20));
      expect(s.scrub(`Authorization: Basic ${encoded}`)).toContain("[secret:STRIPE_SECRET_KEY]");
    }
  });

  test("the password inside a URL goes on its own", () => {
    expect(s.scrub("password authentication failed: Zq8vR2mW9xLp4tNs")).toBe(
      "password authentication failed: [secret:DATABASE_URL]",
    );
  });

  test("plain words are never scrubbed", () => {
    expect(isHideable("development")).toBe(false);
    expect(s.scrub("NODE_ENV=development")).toBe("NODE_ENV=development");
  });

  test("a value split across chunks is caught", () => {
    const st = s.stream();
    const text = `before ${STRIPE} after`;
    let out = "";
    for (let i = 0; i < text.length; i += 5) out += st.push(text.slice(i, i + 5));
    out += st.flush();
    expect(out).toBe("before [secret:STRIPE_SECRET_KEY] after");
  });

  test("only a tail that could start a value is held back", () => {
    const st = s.stream();
    expect(st.push("listening on :3000\n")).toBe("listening on :3000\n");
    expect(st.push(`key ${STRIPE.slice(0, 9)}`)).toBe("key ");
    expect(st.push(`${STRIPE.slice(9)} ok`) + st.flush()).toBe("[secret:STRIPE_SECRET_KEY] ok");
  });

  test("scrubDeep walks objects and counts hits", () => {
    const fresh = createScrubber([{ name: "STRIPE_SECRET_KEY", value: STRIPE }]);
    expect(fresh.scrubDeep({ cmd: ["echo", STRIPE], n: 1 })).toEqual({ cmd: ["echo", "[secret:STRIPE_SECRET_KEY]"], n: 1 });
    expect(fresh.hits().get("STRIPE_SECRET_KEY")).toBe(1);
  });

  test("no secrets scrubs nothing", () => {
    const none = createScrubber([]);
    expect(none.scrub(STRIPE)).toBe(STRIPE);
    expect(none.stream().push("abc")).toBe("abc");
    expect(none.mayChangeJson!(JSON.stringify({ text: STRIPE }))).toBe(false);
  });

  test("mayChangeJson is true for JSON whenever scrubDeep of its value would change it", () => {
    // Its lines are too short to be scrubbed alone, so only its escaped forms can match.
    const quoted = 'p"a\\s\ns"w\\d-Zq8vR2"m';
    const wrapped = ("sk_" + "live_51Hx9QaZ8bYc7dWe6fVg5hUi4jTk3QaZ8bYc7dWe6");
    const sc = createScrubber([
      { name: "STRIPE_SECRET_KEY", value: STRIPE },
      { name: "DB_PASSWORD", value: quoted },
      { name: "K", value: wrapped },
      // A control character JSON escapes and a .env file does not.
      { name: "BELL_TOKEN", value: "Zq8v\u0007R2mW9xLp4" },
    ]);
    const b64 = btoa(`A=${wrapped}\n`).match(/.{1,64}/g)!;
    const strings = [STRIPE, quoted, wrapped, JSON.stringify(quoted), JSON.stringify(JSON.stringify(quoted)), quoted.replace(/\n/g, "\r\n"), encodeURIComponent(quoted), b64.join("\n"), JSON.stringify(b64.join("\n")), b64.join("\r\n"), JSON.stringify(JSON.stringify("Zq8v\u0007R2mW9xLp4"))];
    for (const s of strings) {
      for (const value of [{ text: `before ${s} after` }, { input: { [s]: 1 } }, [`x${s}`]]) {
        expect(JSON.stringify(sc.scrubDeep(value)), s).not.toBe(JSON.stringify(value));
        expect(sc.mayChangeJson!(JSON.stringify(value)), s).toBe(true);
      }
    }
    expect(sc.mayChangeJson!(JSON.stringify({ text: "nothing secret here", n: 1 }))).toBe(false);
  });
});

test("the notice carries names only", () => {
  expect(secretsNotice(["A", "B"])).toContain("2 secrets to this project: A, B");
});

test("repositoryKey gives Cloud's key for every remote form", () => {
  for (const remote of [
    "https://github.com/Acme/App.git",
    "https://github.com/acme/app",
    "git@github.com:Acme/App.git",
    "ssh://git@github.com/acme/app.git",
    "https://token@github.com/acme/app/",
  ]) {
    expect(repositoryKey(remote), remote).toBe("github.com/acme/app");
  }
  expect(repositoryKey("git@gitlab.com:group/sub/proj.git")).toBe("gitlab.com/group/sub/proj");
  expect(repositoryKey("/Users/me/app")).toBeUndefined();
  expect(repositoryKey("https://github.com/acme")).toBeUndefined();
  expect(repositoryKey("file:///tmp/x/y")).toBeUndefined();
});

describe("review fixes", () => {
  const body = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7\nVJTUt9Us8cKjMzEfYyjiWA4R4/M2bS1GB4t7NXp98C3SC6dVMvDuictGeurT8jNbvJZHtCSuYEvu";
  const dotenv = `APP=1\nFIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\\n${body.replace(/\n/g, "\\n")}\\n-----END PRIVATE KEY-----\\n"\nDB_PASSWORD="Zq8\\"w2Lm9!xK"\n`;
  const entries = parseDotenv(dotenv).entries;
  const s = createScrubber(entries);

  test("a dotenv-escaped PEM and password read from the file are scrubbed inside a request body", () => {
    const req = s.scrub(JSON.stringify({ type: "tool_result", content: dotenv }));
    expect(req).not.toContain("MIIEvQIBADANBgkq");
    expect(req).not.toContain("VJTUt9Us8cKjMz");
    expect(req).not.toContain("Zq8");
    // Twice escaped: a tool result quoted inside another JSON string.
    expect(s.scrub(JSON.stringify(JSON.stringify({ content: dotenv })))).not.toContain("MIIEvQIBADANBgkq");
  });

  test("a multi-line value printed with CRLF line ends, or re-indented, is scrubbed", () => {
    const pem = entries.find((e) => e.name === "FIREBASE_PRIVATE_KEY")!.value;
    expect(s.scrub(pem.replace(/\n/g, "\r\n"))).not.toContain("MIIEvQ");
    expect(s.scrub(pem.split("\n").map((l) => `    ${l}`).join("\n"))).not.toContain("VJTUt9Us8");
  });

  test("base64 wrapped at 64 or 76 columns is scrubbed, raw or inside JSON", () => {
    const value = ("sk_" + "live_51Hx9QaZ8bYc7dWe6fVg5hUi4jTk3QaZ8bYc7dWe6");
    const sc = createScrubber([{ name: "K", value }]);
    for (const width of [64, 76]) {
      for (const prefix of ["", "A=", "LONGER_PREFIX_TEXT_HERE_TO_SHIFT_THE_WRAP="]) {
        const encoded = btoa(prefix + value + "\n");
        const wrapped = encoded.match(new RegExp(`.{1,${width}}`, "g"))!.join("\n");
        const middle = btoa(value).slice(8, 24);
        expect(sc.scrub(wrapped).replace(/\n/g, ""), `${width} ${prefix}`).not.toContain(middle.slice(4, 12));
        expect(sc.scrub(JSON.stringify(wrapped))).toContain("[secret:K]");
      }
    }
  });

  test("overlapping values are both hidden", () => {
    const o = createScrubber([
      { name: "A", value: "PREFIXabcd1234" },
      { name: "B", value: "abcd1234ZYXWVUTS9876" },
    ]);
    expect(o.scrub("x PREFIXabcd1234ZYXWVUTS9876 y")).toBe("x [secret:A,B] y");
  });

  test("names that are object machinery are not secret names", () => {
    for (const n of ["__proto__", "constructor", "prototype"]) expect(SECRET_NAME_PATTERN.test(n)).toBe(false);
    expect(SECRET_NAME_PATTERN.test("STRIPE_SECRET_KEY")).toBe(true);
  });

  test("reserved names: process-wide always, the engines' own only for engines", () => {
    expect(isReservedEnvName("PATH", "process")).toBe(true);
    expect(isReservedEnvName("BASH_ENV", "process")).toBe(true);
    expect(isReservedEnvName("GIT_SSH_COMMAND", "process")).toBe(true);
    expect(isReservedEnvName("ANTHROPIC_API_KEY", "process")).toBe(false);
    expect(isReservedEnvName("ANTHROPIC_API_KEY", "engine")).toBe(true);
    expect(isReservedEnvName("CAVEMAN_API_KEY", "process")).toBe(false);
    expect(isReservedEnvName("CAVEMAN_PORT_WEB", "process")).toBe(true);
    expect(isReservedEnvName("STRIPE_SECRET_KEY", "engine")).toBe(false);
  });

  test("reserved names: where an interpreter or a package manager loads code from (cloud-computers CONTRACT §2, S7)", () => {
    // The contract's list, name for name: Cloud's reservedNames holds the same.
    const listed = [
      "PYTHONPATH",
      "NODE_OPTIONS",
      "NODE_PATH",
      "NPM_CONFIG_REGISTRY",
      "NPM_CONFIG_USERCONFIG",
      "PIP_INDEX_URL",
      "PIP_EXTRA_INDEX_URL",
      "PIP_CONFIG_FILE",
      "UV_INDEX_URL",
      "BUNDLE_GEMFILE",
      "RUBYOPT",
      "LD_PRELOAD",
      "LD_LIBRARY_PATH",
      "DYLD_INSERT_LIBRARIES",
      "GIT_SSH_COMMAND",
      "GIT_CONFIG_GLOBAL",
    ];
    for (const name of listed) {
      expect([name, isReservedEnvName(name, "process")]).toEqual([name, true]);
      expect([name, isReservedEnvName(name, "engine")]).toEqual([name, true]);
      // npm and pip read their variables in lower case too.
      expect([name, isReservedEnvName(name.toLowerCase(), "process")]).toEqual([name, true]);
    }
    // Whole names only: a project's own variable that merely starts or ends like one stays a secret it may set.
    for (const name of ["PYTHONPATH_EXTRA", "MY_NODE_PATH", "PIP_INDEX_URL_MIRROR", "NPM_CONFIG_REGISTRY_TOKEN", "RUBYOPTS", "UV_INDEX", "PIP_TOKEN", "NPM_TOKEN"]) {
      expect([name, isReservedEnvName(name, "process")]).toEqual([name, false]);
    }
  });

  test("a wrapped base64 value split across stream chunks is still caught", () => {
    const value = ("sk_" + "live_51Hx9QaZ8bYc7dWe6fVg5hUi4jTk3QaZ8bYc7dWe6");
    const sc = createScrubber([{ name: "K", value }]);
    const wrapped = btoa(value).match(/.{1,20}/g)!.join("\n");
    const st = sc.stream();
    let out = "";
    for (let i = 0; i < wrapped.length; i += 7) out += st.push(wrapped.slice(i, i + 7));
    out += st.flush();
    // Only the final partial group (padding, a few bits of the value) can remain.
    expect(out).toMatch(/^\[secret:K\][A-Za-z0-9+/=]{0,4}$/);
  });

  test("wrapped base64 inside a JSON string is caught at every stream cut, inside an escaped line break too", () => {
    const value = ("sk_" + "live_51Hx9QaZ8bYc7dWe6fVg5hUi4jTk3QaZ8bYc7dWe6fVg5hUi4jTk3Xy");
    const b64 = btoa(value);
    const sc = createScrubber([{ name: "K", value }]);
    for (const lineEnd of ["\n", "\r\n"]) {
      const text = `{"data":${JSON.stringify(b64.match(/.{1,76}/g)!.join(lineEnd))}}\n`;
      const leaking: number[] = [];
      for (let cut = 1; cut < text.length; cut++) {
        const st = sc.stream();
        const out = st.push(text.slice(0, cut)) + st.push(text.slice(cut)) + st.flush();
        if (!out.includes("[secret:K]") || out.includes(b64.slice(0, 40))) leaking.push(cut);
      }
      expect(leaking, JSON.stringify(lineEnd)).toEqual([]);
    }
  });

  test("a value with a lone surrogate is hidden as it is stored and as a process prints it (U+FFFD)", () => {
    // What JSON.parse makes of a secret.set value sent as "correct-horse-battery\ud83d".
    const value = JSON.parse('"correct-horse-battery\\ud83d"') as string;
    const printed = value.toWellFormed();
    const sc = createScrubber([{ name: "API_KEY", value }]);
    for (const form of [value, printed, JSON.stringify(value), JSON.stringify(printed), encodeURIComponent(printed), btoa(String.fromCharCode(...new TextEncoder().encode(printed)))]) {
      const out = sc.scrub(`key=${form};`);
      expect(out, form).toContain("[secret:API_KEY]");
      expect(out, form).not.toContain(form.slice(0, 12));
    }
    const st = sc.stream();
    expect(st.push(`key=${printed.slice(0, 10)}`) + st.push(`${printed.slice(10)};`) + st.flush()).toBe("key=[secret:API_KEY];");
  });
});

test("public-by-design names are stored but never scrubbed", () => {
  const s = createScrubber([
    { name: "NEXT_PUBLIC_APP_URL", value: "http://localhost:3000/app" },
    { name: "STRIPE_SECRET_KEY", value: ("sk_" + "live_51Hx9QaZ8bYc7dWe6fVg5hUi4jTk3") },
  ]);
  expect(s.scrub(("open http://localhost:3000/app and use sk_" + "live_51Hx9QaZ8bYc7dWe6fVg5hUi4jTk3"))).toBe(
    "open http://localhost:3000/app and use [secret:STRIPE_SECRET_KEY]",
  );
});
