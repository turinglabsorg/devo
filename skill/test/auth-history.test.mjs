import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { historyPath, readHistory } from "../scripts/watch.mjs";

// The record path carries the profile.
//
// It used to be one global JSONL for every identity, which is the mistake the
// isolated roots exist to remove: two devo processes working on two profiles
// held the same path. Append-only made that survivable rather than fatal, so
// nothing crashed and nobody noticed -- which is exactly why it needs a test
// rather than a careful reader.
const CLI = join(import.meta.dirname, "..", "index.js");

const root = mkdtempSync(join(tmpdir(), "devo-history-"));
after(() => rmSync(root, { recursive: true, force: true }));

// A gcloud that fails instantly, so the suite stays offline and asserts nothing
// about what the probe concludes -- only about which file a run writes.
const bin = join(root, "bin");
mkdirSync(bin, { recursive: true });
writeFileSync(
  join(bin, "gcloud"),
  "#!/bin/sh\necho 'Reauthentication failed. Please run: gcloud auth login' >&2\nexit 1\n",
);
chmodSync(join(bin, "gcloud"), 0o755);

function scenario(name) {
  const home = join(root, name, "home");
  const profiles = join(root, name, "profiles");
  mkdirSync(home, { recursive: true });
  for (const profile of ["master", "credilex"]) {
    mkdirSync(join(profiles, profile), { recursive: true });
  }
  return { home, profiles };
}

function run(scn, args) {
  return spawnSync("node", [CLI, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: scn.home,
      DEVO_GCLOUD_PROFILES_DIR: scn.profiles,
      PATH: `${bin}:${process.env.PATH}`,
    },
  });
}

function records(scn, profile) {
  const path = join(scn.home, ".devo", "auth-status", `${profile}.jsonl`);
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf8")
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
}

test("writes each profile into its own file", () => {
  const scn = scenario("both");
  assert.equal(run(scn, ["auth", "status", "--record"]).status, 1, "a failing probe must exit non-zero");

  const master = records(scn, "master");
  const credilex = records(scn, "credilex");
  assert.equal(master.length, 1);
  assert.equal(credilex.length, 1);
  assert.equal(master[0].profile, "master");
  assert.equal(credilex[0].profile, "credilex");
  assert.equal(master[0].stale, true, "the refusal text must still be read as a stale credential");
  assert.equal(
    existsSync(join(scn.home, ".devo", "auth-status.jsonl")),
    false,
    "the single global history file must not be written any more",
  );
});

test("a run scoped to one profile cannot touch another profile's file", () => {
  const scn = scenario("scoped");

  assert.equal(run(scn, ["auth", "status", "--profile", "master", "--record"]).status, 1);
  assert.equal(records(scn, "master").length, 1);
  assert.equal(
    records(scn, "credilex"),
    null,
    "the other identity's file must not even be created by a scoped run",
  );

  assert.equal(run(scn, ["auth", "status", "--profile", "credilex", "--record"]).status, 1);
  assert.equal(records(scn, "master").length, 1, "the first identity's file must be untouched");
  assert.equal(records(scn, "credilex").length, 1);
});

test("refuses a profile it cannot probe instead of reporting an empty success", () => {
  const scn = scenario("refusal");

  const unknown = run(scn, ["auth", "status", "--profile", "does-not-exist"]);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /Unknown profile: does-not-exist/);
  assert.doesNotMatch(unknown.stderr, /^\s+at /m, "a refusal must not print a stack trace");

  const noHealthProject = run(scn, ["auth", "status", "--profile", "nobrainer"]);
  assert.equal(noHealthProject.status, 1);
  assert.match(noHealthProject.stderr, /no health project/);
});

test("reads the records back across profiles, oldest first", () => {
  const scn = scenario("read");
  run(scn, ["auth", "status", "--record"]);

  const previous = process.env.HOME;
  process.env.HOME = scn.home;
  try {
    const all = readHistory();
    assert.equal(all.length, 2);
    assert.deepEqual(
      all.map((record) => record.profile).sort(),
      ["credilex", "master"],
    );
    assert.ok(all[0].at <= all[1].at, "records must come back in time order");
    assert.equal(historyPath("master").endsWith(join("auth-status", "master.jsonl")), true);
    assert.notEqual(historyPath("master"), historyPath("credilex"));
    assert.throws(() => historyPath(), /needs a profile name/, "a nameless path would be undefined.jsonl");
  } finally {
    process.env.HOME = previous;
  }
});
