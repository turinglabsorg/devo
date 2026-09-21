import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { installChecks } from "../scripts/drift.mjs";

/**
 * The check reads a manifest, so the fixture is a whole installation: a
 * repository tree, the copies install.sh would have written, and the manifest
 * recording their digests. Nothing here touches the real install.
 */
const sandbox = mkdtempSync(join(tmpdir(), "devo-drift-"));
after(() => rmSync(sandbox, { recursive: true, force: true }));

const repo = join(sandbox, "repo");
const tools = join(sandbox, "home", ".codex", "tools", "devo");
const hooks = join(sandbox, "home", ".claude", "hooks");
const manifestPath = join(tools, "INSTALLED.json");

function write(path, text) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
  return path;
}

function sha(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** The state install.sh leaves behind: identical copies, digests recorded. */
function install({ runtime = "runtime at install time", guard = "guard at install time" } = {}) {
  const source = write(join(repo, "skill", "index.js"), runtime);
  const installed = write(join(tools, "index.js"), runtime);
  const guardSource = write(join(repo, "skill", "hooks", "gcloud-guard.sh"), guard);
  const guardInstalled = write(join(hooks, "gcloud-guard.sh"), guard);

  const manifest = {
    installedAt: "2026-09-21T21:35:15Z",
    repo,
    repoCommit: "abc1234",
    artifacts: [
      { target: "runtime", source: "skill/index.js", installed, sha256: sha(installed) },
      { target: "hook", source: "skill/hooks/gcloud-guard.sh", installed: guardInstalled, sha256: sha(guardInstalled) },
    ],
  };

  write(manifestPath, JSON.stringify(manifest, null, 2));
  return { source, installed, guardSource, guardInstalled };
}

function checks(env = {}) {
  const previous = { ...process.env };
  Object.assign(process.env, { CODEX_HOME: join(sandbox, "home", ".codex") }, env);
  try {
    return installChecks();
  } finally {
    for (const key of ["CODEX_HOME", "DEVO_INSTALL_MANIFEST"]) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

function find(list, name) {
  return list.find((check) => check.name === name);
}

test("an installation that matches its manifest is ok and says nothing more", () => {
  install();
  const list = checks();

  for (const name of ["runtime copies (tools/devo)", "hook copy (claude/hooks)"]) {
    const check = find(list, name);
    assert.ok(check, `${name} must be reported`);
    assert.equal(check.ok, true, check.error);
    assert.equal(check.warning, "");
    assert.match(check.summary, /match(es)? the manifest/);
  }
});

// The failure the check exists for: an installed copy edited in place. It works
// immediately, and until the digest is compared nothing says the repository is no
// longer the source of what is running.
test("reports an installed copy that changed after it was installed", () => {
  const { guardInstalled } = install();
  writeFileSync(guardInstalled, "guard edited in place");
  const check = find(checks(), "hook copy (claude/hooks)");

  assert.equal(check.ok, false);
  assert.match(check.error, /gcloud-guard\.sh was changed after it was installed/);
  assert.match(check.error, /edit the repository copy and reinstall/);
});

// The ordinary state between an edit and the reinstall that publishes it. It is
// not a defect, and reporting it as one would make the check noise on every
// uninstalled change.
test("treats a newer repository copy as a pending reinstall, not a defect", () => {
  const { source } = install();
  writeFileSync(source, "repository moved on");
  const check = find(checks(), "runtime copies (tools/devo)");

  assert.equal(check.ok, true, check.error);
  assert.match(check.warning, /repository copy is newer/);
});

test("reports an installed copy that is gone", () => {
  const { installed } = install();
  rmSync(installed);
  const check = find(checks(), "runtime copies (tools/devo)");

  assert.equal(check.ok, false);
  assert.match(check.error, /index\.js is missing/);
});

// An install that predates the manifest left nothing to compare against. Saying
// "ok" would claim a check that could not be made, so it is a skip instead.
test("skips instead of claiming success when there is no manifest", () => {
  install();
  const list = checks({ DEVO_INSTALL_MANIFEST: join(sandbox, "nowhere", "INSTALLED.json") });

  assert.equal(list.length, 1);
  assert.equal(list[0].skipped, true);
  assert.equal(list[0].ok, true);
});

test("reports an unreadable manifest rather than an empty one", () => {
  install();
  write(manifestPath, "{ this is not json");
  const list = checks();

  assert.equal(list.length, 1);
  assert.equal(list[0].ok, false);
  assert.match(list[0].error, /INSTALLED\.json/);
});

// The commit is what makes "the install is behind the repository" visible
// without a diff: the manifest records what was installed, and the repository
// says where it is now.
test("warns when the repository has moved on since the install", (t) => {
  // A manifest of its own: the test before this one left an unreadable one on
  // disk on purpose.
  install();

  const git = (args) => spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  const commit = (message) =>
    spawnSync(
      "git",
      ["-C", repo, "-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-q", "--allow-empty", "-m", message],
      { encoding: "utf8" },
    );

  spawnSync("git", ["-C", repo, "init", "-q"], { encoding: "utf8" });
  commit("fixture");
  const installedAt = git(["rev-parse", "--short", "HEAD"]).stdout.trim();

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  write(manifestPath, JSON.stringify({ ...manifest, repoCommit: installedAt }, null, 2));
  assert.equal(find(checks(), "install manifest").warning, "", "the install is current");

  commit("a later commit");
  const moved = find(checks(), "install manifest");
  assert.match(moved.warning, /the repository is at .* now: the install is behind it/);

  t.after(() => rmSync(join(repo, ".git"), { recursive: true, force: true }));
});
