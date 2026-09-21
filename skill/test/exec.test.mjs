import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

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

// Prefixing a call with `devo exec` must not side-step the router's guard: a
// mutation reached through this route is still a mutation.
test("keeps the router's mutation guard", () => {
  const result = run(["exec", "--profile", "master", "--", "gcloud", "auth", "login", "someone@example.com"]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Refusing a mutating gcloud command/);
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
