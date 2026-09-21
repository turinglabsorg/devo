import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { pinnedEnv } from "../scripts/exec.mjs";

// The route pins a root for a process that is not gcloud. Nothing here reaches a
// cloud: the profile root is a temporary directory, and every command the route
// is asked to start is a refusal or a shell builtin.
const CLI = join(import.meta.dirname, "..", "index.js");

const root = mkdtempSync(join(tmpdir(), "devo-exec-"));
after(() => rmSync(root, { recursive: true, force: true }));
mkdirSync(join(root, "master"), { recursive: true });

function run(args, env = {}) {
  return spawnSync("node", [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, DEVO_GCLOUD_PROFILES_DIR: root, ...env },
  });
}

/** A command that prints one environment variable, so the child can be asked
 *  what it was given without a second tool in the loop. */
function printEnv(name) {
  return ["--", "node", "-e", `process.stdout.write(process.env.${name} || "")`];
}

test("refuses to run without a --profile", () => {
  const result = run(["exec", "--", "true"]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Missing --profile/);
  assert.doesNotMatch(result.stderr, /^\s+at /m, "a refusal must not print a stack trace");
});

test("refuses a command line with no command to run", () => {
  const separatorless = run(["exec", "--profile", "master"]);
  assert.equal(separatorless.status, 1);
  assert.match(separatorless.stderr, /Missing `--`/);

  const empty = run(["exec", "--profile", "master", "--"]);
  assert.equal(empty.status, 1);
  assert.match(empty.stderr, /Missing command\. Usage: devo exec/);
});

// The point of the route: the caller names a profile, and the process it starts
// finds the root already set. Nobody writes a directory down.
test("pins the profile root for the process it starts", () => {
  const result = run(["exec", "--profile", "master", ...printEnv("CLOUDSDK_CONFIG")]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, join(root, "master"));
});

test("exports the project and the account the profile declares", () => {
  const project = run(["exec", "--profile", "master", "--project", "example-project", ...printEnv("CLOUDSDK_CORE_PROJECT")]);
  const account = run(["exec", "--profile", "master", ...printEnv("CLOUDSDK_CORE_ACCOUNT")]);

  assert.equal(project.stdout, "example-project", project.stderr);
  assert.equal(account.stdout, "sebastiano.cataudo@gmail.com", account.stderr);
});

// Flags after the separator belong to the command being started. Reading a
// `--project` there as this route's own would pin a project the caller never
// asked this route for, and the command would inherit it as if it had.
test("reads its own flags before the separator only", () => {
  const result = run([
    "exec",
    "--profile",
    "master",
    "--",
    "sh",
    "-c",
    'printf %s "${CLOUDSDK_CORE_PROJECT:-none}"',
    "--project",
    "somewhere-else",
  ]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "none");
});

test("refuses to pass on any spelling of an identity root", async (t) => {
  const cases = [
    ["docker", "run", "-v", "/Users/someone/.config/gcloud:/gc", "img"],
    ["docker", "run", "-e", "CLOUDSDK_CONFIG=~/.config/gcloud-profiles/master", "img"],
    ["docker", "cp", "~/.config/gcloud/active_config", "ctr:/root/"],
    ["docker", "build", "-t", "img", "/Users/someone/.config/gcloud-profiles/master"],
    ["sh", "-c", "cat ~/.config/gcloud/credentials.db"],
  ];

  for (const command of cases) {
    await t.test(command.join(" ").slice(0, 48), () => {
      const result = run(["exec", "--profile", "master", "--", ...command]);
      assert.equal(result.status, 1, `expected a refusal for: ${command.join(" ")}`);
      assert.match(result.stderr, /Refusing to pass on/);
    });
  }
});

// The refusal cannot rest on how a root is written, because the roots are
// configuration and a directory has more than one spelling. A root relocated
// through the registry's own variable contains none of the letters of the
// default path; a parent hands the root over just as surely as the root itself;
// and a bind mount carries the path inside a larger argument. Each is judged by
// the path it denotes.
test("refuses a root spelled without any of its usual text", async (t) => {
  const relocated = mkdtempSync(join(tmpdir(), "devo-exec-relocated-"));
  t.after(() => rmSync(relocated, { recursive: true, force: true }));
  const relocatedRoot = join(relocated, "master");
  mkdirSync(relocatedRoot, { recursive: true });
  const alias = join(relocated, "alias");
  symlinkSync(relocatedRoot, alias);
  const env = { DEVO_GCLOUD_PROFILES_DIR: relocated };

  const spellings = [
    relocatedRoot, // the root the route itself pins
    join(relocatedRoot, "configurations"), // inside it: a configuration file or a store
    relocated, // above it: a mount of the parent
    alias, // another name for it, which only resolution can see through
    `type=bind,src=${relocatedRoot},dest=/gc`, // the shape `--mount` carries
  ];

  for (const spelling of spellings) {
    await t.test(spelling.slice(-32), () => {
      const result = run(["exec", "--profile", "master", "--", "stub", "--mount", spelling], env);
      assert.equal(result.status, 1, `expected a refusal for: ${spelling}`);
      assert.match(result.stderr, /Refusing to pass on/);
    });
  }
});

// The broadest spelling of a parent. The filesystem root holds every root there
// is, and it is the one ancestor the inside/above test cannot see, because it is
// above all of them -- the root of the filesystem is its own parent.
test("refuses the filesystem root as a mount source", async (t) => {
  for (const spelling of ["/", "//"]) {
    await t.test(`-v ${spelling}:/host`, () => {
      const result = run(["exec", "--profile", "master", "--", "true", "-v", `${spelling}:/host`]);
      assert.equal(result.status, 1, `expected a refusal for a mount of ${spelling}`);
      assert.match(result.stderr, /Refusing to pass on/);
    });
  }

  const bind = run(["exec", "--profile", "master", "--", "stub", "--mount", "type=bind,src=/,dest=/host"]);
  assert.equal(bind.status, 1, "the shape --mount carries is a spelling like any other");
  assert.match(bind.stderr, /Refusing to pass on/);
});

// The filesystem decides this one, so it is only asserted where the other case
// really is the same directory -- the check must not depend on which filesystem
// the suite runs on. The two are the same directory when they are the same inode,
// which is what the filesystem itself answers; comparing resolved paths would ask
// the wrong question, because `realpathSync` returns the case it was asked for
// rather than the case the directory is stored under (measured on this Mac: it
// answers `/tmp/.../MASTER` for a path spelled that way).
test("refuses a root written in another case, where that is the same directory", (t) => {
  const other = join(root, "MASTER");
  let sameDirectory = false;
  try {
    const one = statSync(other);
    const stored = statSync(join(root, "master"));
    sameDirectory = one.dev === stored.dev && one.ino === stored.ino;
  } catch {
    sameDirectory = false;
  }
  if (!sameDirectory) return t.skip("this filesystem tells the two cases apart");

  const result = run(["exec", "--profile", "master", "--", "stub", "--mount", other]);

  assert.equal(result.status, 1, "the same directory in another case is the same root");
  assert.match(result.stderr, /Refusing to pass on/);
});

// One argument can denote two directories, because the tools on this machine do
// not agree about `..` after a symlink: the kernel follows the link and applies
// `..` to the directory it reached, and a text-first tool collapses `..` before
// following anything. `<link to a directory inside the root>/..` is the root to a
// mount, to an `open` and to `tar -C`, and only the symlink's own directory to
// the other reading. Judging one reading would hand the root over to whichever
// kind of process reads it the other way, so both are judged. Found by packing
// the root out through exactly this argument.
test("refuses an argument that only the kernel reading resolves to a root", (t) => {
  const decoy = mkdtempSync(join(tmpdir(), "devo-exec-decoy-"));
  t.after(() => rmSync(decoy, { recursive: true, force: true }));
  const relocatedRoot = join(decoy, "profiles", "master");
  mkdirSync(join(relocatedRoot, "sub"), { recursive: true });
  const escape = join(decoy, "escape");
  symlinkSync(join(relocatedRoot, "sub"), escape);

  const env = { DEVO_GCLOUD_PROFILES_DIR: join(decoy, "profiles") };
  // Written as text, not through `join`: joining a `..` would collapse it here,
  // in the test, and the argument under test would never reach the route.
  const spellings = [
    `${escape}/..`, // the root to the kernel, the symlink's directory to a text tool
    `${escape}/../..`, // and above the root under the same reading
  ];

  for (const spelling of spellings) {
    for (const command of [["stub", "--mount", spelling], ["tar", "-czf", "out.tgz", "-C", spelling, "."]]) {
      const result = run(["exec", "--profile", "master", "--", ...command], env);
      assert.equal(result.status, 1, `expected a refusal for ${command[0]} ${spelling}`);
      assert.match(result.stderr, /Refusing to pass on/);
    }
  }
});

// The other half of the rule, and the reason the check resolves instead of
// refusing every path: an ordinary mount, an ordinary flag value and an ordinary
// image name are none of them identity material, and must still pass.
test("lets ordinary paths and words through", () => {
  const result = run([
    "exec",
    "--profile",
    "master",
    "--",
    "true",
    "-v",
    "/tmp/devo-exec-not-identity:/data",
    "--format=id",
    "myapp:latest",
  ]);

  assert.equal(result.status, 0, result.stderr);
});

// Residual, deliberately left open: the mutation guard reads the command word,
// so a shell wrapper is not inspected -- `sh -c 'gcloud config set ...'` would
// reach gcloud with the pinned root, and no text test can bound what a shell
// string does. A heuristic that looked like one would be worse than this
// boundary being visible: the harness guard judges that call, this route does
// not. The payload here is inert (printf, never gcloud) because the suite runs
// no cloud command at all; it shows the boundary instead of exercising it.
test("does not inspect a shell wrapper that runs gcloud itself (residual)", () => {
  const result = run([
    "exec",
    "--profile",
    "master",
    "--",
    "sh",
    "-c",
    'printf %s "gcloud config set project other"',
  ]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "gcloud config set project other");
});

// Prefixing a call with `devo exec` must not side-step the router's guard: a
// mutation reached through this route is still a mutation.
test("keeps the router's mutation guard", () => {
  const result = run(["exec", "--profile", "master", "--", "gcloud", "auth", "login", "someone@example.com"]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Refusing a mutating gcloud command/);
});

// The guard reads the command word as the tool it names, so a directory in front
// of the name is not a way around it: `/usr/bin/gcloud` is gcloud. The refusal
// happens before anything is started, so the path does not have to exist for the
// rule to be exercised.
test("keeps the router's mutation guard for gcloud reached by a path", () => {
  const result = run(["exec", "--profile", "master", "--", "/usr/local/bin/gcloud", "auth", "login", "someone@example.com"]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Refusing a mutating gcloud command/);
});

// CLOUDSDK_CONFIG is where gcloud looks for its own ADC; it is not where a client
// library looks, because Go, Node and Python resolve the well-known ADC file by
// the home directory. Without naming the profile's own file, a child of this
// route authenticates as the ambient root's identity while the route reports the
// profile as pinned.
test("names the profile's own application-default credentials for the child", (t) => {
  const other = mkdtempSync(join(tmpdir(), "devo-exec-adc-"));
  t.after(() => rmSync(other, { recursive: true, force: true }));
  const profileRoot = join(other, "master");
  mkdirSync(profileRoot, { recursive: true });
  writeFileSync(join(profileRoot, "application_default_credentials.json"), "not a credential\n");

  const { env, warning } = pinnedEnv({ name: "master", root: profileRoot });

  assert.equal(env.CLOUDSDK_CONFIG, profileRoot);
  assert.equal(env.GOOGLE_APPLICATION_CREDENTIALS, join(profileRoot, "application_default_credentials.json"));
  assert.equal(warning, "");
});

// Residual, deliberately left open: a profile with no ADC file of its own leaves
// the route with nothing to name, and the child that resolves ADC by the
// well-known file reads the ambient root. Pointing it at a file that is not there
// would fail the docker credential helper, which works today through the profile's
// credential store, so the route reports the state instead of refusing it.
test("reports a profile with no application-default credentials instead of refusing (residual)", (t) => {
  const other = mkdtempSync(join(tmpdir(), "devo-exec-noadc-"));
  t.after(() => rmSync(other, { recursive: true, force: true }));
  const profileRoot = join(other, "master");
  mkdirSync(profileRoot, { recursive: true });

  const { env, warning } = pinnedEnv({ name: "master", root: profileRoot }, { account: "someone@example.com" });

  assert.equal(env.GOOGLE_APPLICATION_CREDENTIALS, undefined, "a file that is not there is not named");
  assert.match(warning, /has no application-default credentials of its own/);
  assert.match(warning, /gcloud auth application-default login someone@example\.com/);

  // And the route still runs the command: the state is reported, not refused.
  const result = run(["exec", "--profile", "master", "--", "true"], { DEVO_GCLOUD_PROFILES_DIR: other });
  assert.equal(result.status, 0, result.stderr);
});

// A shell cannot be asked for one variable by name when that name is identity
// material -- the route refuses the argument that spells it, which is the point of
// the refusal -- so the environment is judged where it is built.
test("refuses an argument that spells the ADC variable", () => {
  const result = run(["exec", "--profile", "master", "--", "stub", "-e", "GOOGLE_APPLICATION_CREDENTIALS=/tmp/adc.json"]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Refusing to pass on/);
});

test("propagates the exit status of the command", () => {
  const result = run(["exec", "--profile", "master", "--", "sh", "-c", "exit 7"]);

  assert.equal(result.status, 7, "the caller must see the failure of what it started");
});

// A root whose active account is not the one the registry expects is the drift
// detector firing, not a working identity -- the same judgement `devo gcloud`
// makes before it runs anything.
test("refuses a root whose active account is not the expected one", (t) => {
  const other = mkdtempSync(join(tmpdir(), "devo-exec-drift-"));
  t.after(() => rmSync(other, { recursive: true, force: true }));
  const profileRoot = join(other, "master");
  mkdirSync(join(profileRoot, "configurations"), { recursive: true });
  writeFileSync(join(profileRoot, "active_config"), "default");
  writeFileSync(join(profileRoot, "configurations", "config_default"), "[core]\naccount = someone.else@example.com\n");

  const result = run(["exec", "--profile", "master", "--", "true"], { DEVO_GCLOUD_PROFILES_DIR: other });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /currently has someone\.else@example\.com active/);
  // The same repair line `devo gcloud` prints for the same drift: the exact
  // command to paste, with the root spelled out.
  assert.match(result.stderr, /gcloud auth login sebastiano\.cataudo@gmail\.com/);
});
