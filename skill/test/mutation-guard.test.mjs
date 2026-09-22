import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { guardMutation } from "../scripts/gcloud.mjs";

// The router's mutation guard, judged where it is read: `guardMutation` is the
// function the router hands its own arguments to, so the readings below are the
// ones a `devo gcloud` call meets, with no cloud command started to find out.
// The two calls that do go through the CLI run a stub named gcloud on PATH, so
// the suite proves what the router refuses before it starts anything without ever
// reaching a real gcloud -- and the stub records that it was started, which is
// what makes "before" measurable rather than claimed.
//
// A batch of rules is verified against the guard it replaces, not only against
// itself: every case in "refuses a mutation behind a run of global flags" is
// allowed by the router this batch replaced, where the subcommand was read at the
// first argument alone. The cases that are green under both -- the mutations in
// their plain spelling, the allow-list, and the residual named as one -- measure
// nothing and are marked as controls.

const CLI = join(import.meta.dirname, "..", "index.js");

const root = mkdtempSync(join(tmpdir(), "devo-router-"));
after(() => rmSync(root, { recursive: true, force: true }));
mkdirSync(join(root, "master"), { recursive: true });

/** A `gcloud` that is not gcloud: it records that it was started, and with which
 *  arguments, so a refusal can be told from a call that went through. Its own
 *  directory per call, because the record is what one test asserts is absent and
 *  another asserts the content of. */
function stubPath() {
  const bin = mkdtempSync(join(root, "stub-bin-"));
  const recorded = join(bin, "argv");
  writeFileSync(join(bin, "gcloud"), `#!/bin/sh\nprintf '%s\\n' "$*" > ${recorded}\n`, {
    mode: 0o755,
  });
  return { bin, recorded };
}

function run(args, env = {}) {
  return spawnSync("node", [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, DEVO_GCLOUD_PROFILES_DIR: root, ...env },
  });
}

function refuses(args) {
  return assert.throws(
    () => guardMutation(args, { allowMutation: false }),
    /Refusing a mutating gcloud command/,
    `expected a refusal for: ${args.join(" ")}`,
  );
}

function allows(args) {
  assert.doesNotThrow(
    () => guardMutation(args, { allowMutation: false }),
    `expected no refusal for: ${args.join(" ")}`,
  );
}

// Control: the plain spelling, which the router this batch replaced refused too,
// so it is green under both and measures only that the guard is still wired in.
test("refuses a mutating subcommand (control)", () => {
  refuses(["auth", "login", "someone@example.com"]);
  refuses(["auth", "application-default", "login"]);
  refuses(["config", "set", "account", "someone@example.com"]);
});

// A run of global flags in front of the subcommand is not a different call:
// gcloud takes them between the command word and the group, each optionally with
// the value it needs -- `--verbosity debug` and `--project <id>` as well as the
// one-token `--project=<id>`, `-q` as well as `--quiet`. Reading the subcommand at
// the first argument recognised one spelling and judged every other one as a call
// that is not a mutation, so a flag in front of `auth login` was a mutation the
// guard could not see. Every case below is refused by this guard and allowed by
// the one it replaced.
test("refuses a mutation behind a run of global flags", () => {
  const spellings = [
    ["-q", "auth", "login", "someone@example.com"],
    ["--quiet", "auth", "login"],
    ["--project", "example-project", "auth", "login"],
    ["--project=example-project", "auth", "login"],
    ["--verbosity", "debug", "auth", "application-default", "login"],
    ["--account", "someone@example.com", "config", "set", "account", "other@example.com"],
    ["-q", "--project", "example-project", "config", "configurations", "activate", "default"],
    // A flag whose value happens to be the word the group is named with: the
    // value is stepped over, and the mutation after it is still the mutation.
    ["-q", "--verbosity", "auth", "auth", "login"],
    // A flag this guard does not know leaves the token after it unreadable -- it
    // is either that flag's value or the subcommand -- so both readings are kept
    // and the one that shows the mutation decides.
    ["--log-http", "auth", "login"],
    ["--log-http", "off", "auth", "login"],
    // The end of the flags is not the end of the reading.
    ["--", "auth", "login"],
  ];

  for (const spelling of spellings) refuses(spelling);
});

// `auth activate-service-account` writes a credential into the root and `config
// set account` changes which identity an unprefixed call uses, so both are
// mutations of the same class as `auth login`. The first was not on the list, and
// a flag in front of the second hid it: both are refused now.
test("refuses the mutations of the same class, and behind a flag", () => {
  refuses(["auth", "activate-service-account", "someone@example.com"]);
  refuses(["auth", "activate-service-account", "--key-file=/tmp/key.json"]);
  refuses(["--project", "example-project", "auth", "activate-service-account"]);
  refuses(["--project", "example-project", "config", "set", "account", "someone@example.com"]);
});

// The consent path is unchanged: --allow-mutation is what the caller passes to
// state that the change is intended, and it is read for every spelling above.
test("allows the same mutations when the caller states they are intended", () => {
  const spellings = [
    ["auth", "login"],
    ["-q", "auth", "login"],
    ["--project", "example-project", "auth", "application-default", "login"],
    ["--verbosity", "debug", "config", "set", "account", "someone@example.com"],
  ];

  for (const spelling of spellings) {
    assert.doesNotThrow(
      () => guardMutation(spelling, { allowMutation: true }),
      `expected --allow-mutation to permit: ${spelling.join(" ")}`,
    );
  }
});

// Control: reads and resource calls are not mutations, and a guard that refused
// them would be useless. Green under both routers by construction.
test("allows reads, resource calls and flags that name neither (control)", () => {
  const calls = [
    ["auth", "list"],
    ["auth", "print-access-token"],
    ["config", "get-value", "account"],
    ["config", "list"],
    ["compute", "instances", "list"],
    ["--project", "example-project", "compute", "instances", "list"],
    ["--format=json", "auth", "list"],
    ["logging", "read", "--project", "example-project"],
    ["--flatten=a,b", "projects", "list"],
  ];

  for (const call of calls) allows(call);
});

// Residual, deliberately left open: the guard refuses a mutation at any position
// the subcommand may occupy, so a call whose leading flag takes a value and whose
// group is named `auth` can only be read as a mutation when the flag is one this
// guard knows. `--project auth` steps over `auth` as its value, and no group named
// `login` exists in gcloud, so nothing is refused here -- and nothing needs to be:
// gcloud rejects the call itself. Named as a residual rather than left to read as
// intended behaviour, because the guard does not refuse it.
test("does not refuse a flag value that is the word the group is named with (residual)", () => {
  allows(["--project", "auth", "login"]);
});

// The reading also decides whether a call is identity-scoped, which is what keeps
// the project and the account off an `auth` or `config` call and lets the account
// drift check step aside. Read at the first argument, `--quiet auth list` was a
// resource call: the account was pinned onto it and the drift check ran against
// the root. Both are visible in what the router starts, which is what the stub
// records, so the call is judged where it is made.
test("pins nothing onto an identity call reached behind a flag", () => {
  const { bin, recorded } = stubPath();
  const result = run(["gcloud", "--profile", "master", "--", "--quiet", "auth", "list"], {
    PATH: `${bin}:${process.env.PATH}`,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    existsSync(recorded) ? readFileSync(recorded, "utf8").trim() : "",
    "--quiet auth list",
    "an identity call is passed on as the caller wrote it, with no --account and no --project",
  );
});

// The hole the batch exists for, judged where it was: a mutation behind a flag,
// reached through the CLI. The mutation is refused, and the stub shows that
// nothing was started -- a refusal after the program ran would be no refusal.
test("refuses a mutation behind a flag, and starts nothing", () => {
  const { bin, recorded } = stubPath();
  const result = run(["gcloud", "--profile", "master", "--", "-q", "auth", "login", "someone@example.com"], {
    PATH: `${bin}:${process.env.PATH}`,
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Refusing a mutating gcloud command/);
  assert.doesNotMatch(result.stderr, /^\s+at /m, "a refusal must not print a stack trace");
  assert.equal(existsSync(recorded), false, "the refusal must come before anything is started");
});
