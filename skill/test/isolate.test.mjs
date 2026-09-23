import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

import { acquireProfileLock, ProfileBusyError, spawnIsolatedGcloud } from "../scripts/isolate.mjs";

const CLI = join(import.meta.dirname, "..", "index.js");
const root = mkdtempSync(join(tmpdir(), "devo-isolate-"));
const locks = join(root, "locks");
const profiles = join(root, "profiles");

after(() => rmSync(root, { recursive: true, force: true }));
mkdirSync(join(profiles, "master"), { recursive: true });
mkdirSync(join(profiles, "other"), { recursive: true });

function lockedEnv(extra = {}) {
  return {
    ...process.env,
    DEVO_GCLOUD_PROFILES_DIR: profiles,
    DEVO_GCLOUD_LOCK_DIR: locks,
    DEVO_GCLOUD_LOCK_WAIT_MS: "0",
    ...extra,
  };
}

function withLocks(name, fn) {
  const dir = join(root, "case", name);
  mkdirSync(dir, { recursive: true });
  const previous = process.env.DEVO_GCLOUD_LOCK_DIR;
  const previousWait = process.env.DEVO_GCLOUD_LOCK_WAIT_MS;
  process.env.DEVO_GCLOUD_LOCK_DIR = dir;
  process.env.DEVO_GCLOUD_LOCK_WAIT_MS = "0";
  try {
    return fn(dir);
  } finally {
    if (previous === undefined) delete process.env.DEVO_GCLOUD_LOCK_DIR;
    else process.env.DEVO_GCLOUD_LOCK_DIR = previous;
    if (previousWait === undefined) delete process.env.DEVO_GCLOUD_LOCK_WAIT_MS;
    else process.env.DEVO_GCLOUD_LOCK_WAIT_MS = previousWait;
  }
}

describe("profile isolation", { concurrency: false }, () => {
test("devo gcloud runs the host gcloud inside the profile root", () => {
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const gcloudLog = join(root, "gcloud-argv");
  writeFileSync(
    join(bin, "gcloud"),
    `#!/bin/sh\nprintf '%s\\n' "$@" > ${gcloudLog}\nprintf '%s\\n' "$CLOUDSDK_CONFIG" >> ${gcloudLog}\n`,
    { mode: 0o755 },
  );

  const result = spawnSync("node", [CLI, "gcloud", "--profile", "master", "--", "projects", "list"], {
    encoding: "utf8",
    env: lockedEnv({ PATH: `${bin}:${process.env.PATH}` }),
  });

  assert.equal(result.status, 0, result.stderr);
  const recorded = readFileSync(gcloudLog, "utf8");
  assert.match(recorded, /projects\nlist\n/);
  assert.match(recorded, new RegExp(`${join(profiles, "master")}\\n`));
  assert.equal(recorded.includes(join(profiles, "other")), false);
});

test("without a TTY, stdin still reaches gcloud (e.g. --data-file=-)", () => {
  const bin = join(root, "bin-stdin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "gcloud"), "#!/bin/sh\nprintf 'got:'\ncat\n", { mode: 0o755 });

  const result = spawnSync(
    "node",
    [CLI, "gcloud", "--profile", "master", "--", "secrets", "versions", "add", "demo", "--data-file=-"],
    { encoding: "utf8", input: "piped-value", env: lockedEnv({ PATH: `${bin}:${process.env.PATH}` }) },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "got:piped-value");
});

test("two profiles lock independently, and a live holder blocks its own profile", () => {
  withLocks("independent", () => {
    const releaseMaster = acquireProfileLock("master");
    const releaseOther = acquireProfileLock("other");
    assert.throws(() => acquireProfileLock("master"), ProfileBusyError);
    releaseOther();
    releaseMaster();
    const releaseAgain = acquireProfileLock("master");
    releaseAgain();
  });
});

test("a dead holder is replaced", () => {
  withLocks("stale", (dir) => {
    mkdirSync(join(dir, "stale.lock"), { recursive: true });
    writeFileSync(join(dir, "stale.lock", "pid"), "2147483647\n");
    const release = acquireProfileLock("stale");
    release();
  });
});

test("a held profile does not start a second gcloud", () => {
  withLocks("held", () => {
    const release = acquireProfileLock("master");
    try {
      assert.throws(
        () => spawnIsolatedGcloud({ name: "master", root: join(profiles, "master") }, ["version"]),
        ProfileBusyError,
      );
    } finally {
      release();
    }
  });
});
});
