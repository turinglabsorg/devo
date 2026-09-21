import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import test from "node:test";

const CLI = join(import.meta.dirname, "..", "index.js");

function run(args, env = {}) {
  // These refusals happen before any cloud call, so the suite stays offline.
  return spawnSync("node", [CLI, ...args], { encoding: "utf8", env: { ...process.env, ...env } });
}

test("reports a missing --profile as a refusal, not as a crash", () => {
  const result = run(["gcloud", "--", "projects", "list"]);

  assert.equal(result.status, 1, "a refusal must still fail closed");
  assert.match(result.stderr, /Missing --profile/);
  assert.doesNotMatch(result.stderr, /^\s+at /m, "a refusal must not print a stack trace");
  assert.doesNotMatch(result.stderr, /index\.js:\d+/, "a refusal must not name internal paths");
});

test("reports an unknown profile without a stack trace", () => {
  const result = run(["gcloud", "--profile", "does-not-exist", "--", "projects", "list"]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown profile: does-not-exist/);
  assert.doesNotMatch(result.stderr, /^\s+at /m);
});

test("keeps the stack available when DEVO_DEBUG is set", () => {
  const result = run(["gcloud", "--", "projects", "list"], { DEVO_DEBUG: "1" });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /^\s+at /m, "debugging must still reach the stack");
});
