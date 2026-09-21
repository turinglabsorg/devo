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
    for (const key of ["CODEX_HOME", "DEVO_INSTALL_MANIFEST", "DEVO_HOOK_DIR"]) {
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

// A machine devo was never installed on has no check to make. Saying "ok" would
// claim a verification of an installation that is not there, so the check is not
// ok at all -- `ok: false` with `skipped: true`, the shape `doctor.mjs` gives a
// tool that is not installed. `allOk` keeps the provider green on a skip, so the
// exit status still says "nothing failed", which is true: nothing was judged.
test("skips instead of claiming success where nothing is installed", () => {
  install();
  const empty = join(sandbox, "nothing-installed");
  const list = checks({
    DEVO_INSTALL_MANIFEST: join(sandbox, "nowhere", "INSTALLED.json"),
    CODEX_HOME: join(empty, "codex"),
    DEVO_HOOK_DIR: join(empty, "hooks"),
  });

  assert.equal(list.length, 1);
  assert.equal(list[0].skipped, true);
  assert.equal(list[0].ok, false, "a check that could not be made is never ok");
  assert.match(list[0].summary, /devo is not installed here/);
  assert.match(list[0].summary, /run skill\/install\.sh/);
});

// The one deletion that would otherwise turn this check green. Copies are on disk
// and nothing records what was written into them, which is not an install that
// was compared and came out matching -- it is an install that cannot be compared
// at all, and it has to read as a failure with the remedy, not as a skip.
test("fails when the copies are there and the manifest is not", () => {
  install();
  rmSync(manifestPath);
  const list = checks();

  assert.equal(list.length, 1);
  assert.equal(list[0].ok, false);
  assert.equal(list[0].skipped, undefined, "an install that is there is never a skip");
  assert.match(list[0].error, /nothing records what was written into it/);
  assert.match(list[0].error, /run skill\/install\.sh/);
  assert.match(list[0].error, /tools[/\\]devo/, "every copy it found is named");
});

// A manifest that records nothing verifies nothing, and the header line alone
// would read as a healthy install: it carries a timestamp and a commit.
test("fails on a manifest that records no copies", () => {
  install();
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  write(manifestPath, JSON.stringify({ ...manifest, artifacts: [] }, null, 2));
  const list = checks();

  assert.equal(list.length, 1);
  assert.equal(list[0].ok, false);
  assert.match(list[0].error, /records no copies/);
});

// An entry that is not a record is a manifest that cannot be read as one. Read
// as an entry to compare, it would throw on the first property and take the whole
// doctor down with it.
test("fails on a manifest entry that is not a recorded copy", () => {
  install();
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  write(manifestPath, JSON.stringify({ ...manifest, artifacts: [...manifest.artifacts, null] }, null, 2));
  const list = checks();

  assert.equal(list.length, 1);
  assert.equal(list[0].ok, false);
  assert.match(list[0].error, /not a recorded copy/);
});

// Every copy the manifest records is judged. A target this check does not know by
// name is grouped under the name it carries -- a copy the drift check dropped
// silently was a copy reported as verified by a check that never looked at it.
test("judges a copy recorded under a target it does not know", () => {
  const { installed } = install();
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  write(
    manifestPath,
    JSON.stringify(
      { ...manifest, artifacts: [...manifest.artifacts, { target: "runtme", source: "skill/index.js", installed, sha256: sha(installed) }] },
      null,
      2,
    ),
  );
  writeFileSync(installed, "edited after the install");
  const check = find(checks(), 'copies recorded as "runtme"');

  assert.ok(check, "a copy the manifest records must be reported");
  assert.equal(check.ok, false);
  assert.match(check.error, /was changed after it was installed/);
});

// A kind of copy nobody recorded is nothing to compare: skipped, because a skip
// is visibly not a pass, and not a failure, because an install that writes no
// copy of that kind has nothing to diverge from.
test("skips a kind of copy the manifest does not record", () => {
  install();
  const check = find(checks(), "configuration example (~/.devo)");

  assert.ok(check, "a kind of copy the install writes is still named");
  assert.equal(check.skipped, true);
  assert.equal(check.ok, false);
  assert.match(check.summary, /no config copy is recorded/);
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
