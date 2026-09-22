import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

// HOME is redirected with the rest: two of the copies an install writes are
// located from it (the CLI wrapper and the configuration example), so a suite
// that left it alone would read the real machine's installation while the
// manifest under test described a sandbox -- and would pass or fail depending on
// whether devo happens to be installed on the machine running it.
function checks(env = {}) {
  const previous = { ...process.env };
  Object.assign(
    process.env,
    {
      HOME: join(sandbox, "home"),
      CODEX_HOME: join(sandbox, "home", ".codex"),
      DEVO_BIN_DIR: join(sandbox, "home", ".local", "bin"),
    },
    env,
  );
  try {
    return installChecks();
  } finally {
    for (const key of ["HOME", "CODEX_HOME", "DEVO_BIN_DIR", "DEVO_INSTALL_MANIFEST", "DEVO_HOOK_DIR"]) {
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

// Every kind of copy an install writes is evidence that one is there, including
// the two it writes rather than copies -- the CLI wrapper outside CODEX_HOME and
// the configuration example under the config directory. Scanning only the trees
// left a machine with the wrapper and nothing else to be reported as "devo is not
// installed here", which is the state a deleted manifest has to be caught in: the
// check must name the copy it found, whatever kind it is. Each kind is exercised
// on its own, so dropping one from the scan turns this test red.
//
// It is a control for the batch it travels with, and it says so because that is
// what it is: the scan already read all five kinds before this batch, so the case
// is green on both trees and measures nothing the batch changes. What it measures
// is a scan narrowed later -- which is the mistake it was written after.
test("names an unrecorded copy of every kind, not only a runtime tree", () => {
  const kinds = [
    ["the CLI wrapper", [".local", "bin", "devo"]],
    ["the configuration example", [".devo", "config.example.json"]],
  ];
  for (const [kind, parts] of kinds) {
    const root = join(sandbox, "unrecorded", kind.replace(/\W+/g, "-"));
    const home = join(root, "home");
    const copy = write(join(home, ...parts), "a copy with nothing recording it");
    const list = checks({
      HOME: home,
      CODEX_HOME: join(home, ".codex"),
      DEVO_BIN_DIR: join(home, ".local", "bin"),
      DEVO_HOOK_DIR: join(root, "hooks"),
      DEVO_INSTALL_MANIFEST: join(home, ".codex", "tools", "devo", "INSTALLED.json"),
    });

    assert.equal(list.length, 1, `${kind} is one check`);
    assert.equal(list[0].skipped, undefined, `${kind} on disk is never "nothing installed"`);
    assert.equal(list[0].ok, false, `${kind} with nothing recording it is a failure`);
    assert.match(list[0].error, new RegExp(copy.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `${kind} is named`);
    assert.match(list[0].error, /run skill\/install\.sh/, `${kind} comes with the remedy`);
  }
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

// A target name is a name from a file, and a file can write any name at all.
// Read through an object, one of them answers with a function the object
// inherited rather than with a label, and the check would carry that as its own
// name -- a function where every other check has a string.
test("reads a target named after an inherited property as the name it is", () => {
  const { installed } = install();
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  write(
    manifestPath,
    JSON.stringify(
      { ...manifest, artifacts: [{ target: "constructor", source: "skill/index.js", installed, sha256: sha(installed) }] },
      null,
      2,
    ),
  );
  const list = checks();
  const recorded = list.filter((check) => typeof check.name === "string" && check.name.includes("constructor"));

  assert.equal(recorded.length, 1, "the entry is judged under the name it carries");
  assert.equal(recorded[0].name, 'copies recorded as "constructor"');
  assert.equal(recorded[0].ok, true, recorded[0].error);
});

// A path the manifest records without a directory is not a path this check can
// resolve: it is read against whatever directory the doctor was started from, so
// the same entry names a different file in each one. Resolving it is how an
// edited copy reads as untouched from the directory the doctor happens to run in.
test("fails on a copy recorded as a relative path instead of resolving it", () => {
  const { installed } = install();
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  write(
    manifestPath,
    JSON.stringify(
      {
        ...manifest,
        artifacts: [
          { target: "runtime", source: "skill/index.js", installed: "index.js", sha256: sha(installed) },
        ],
      },
      null,
      2,
    ),
  );
  const check = find(checks(), "runtime copies (tools/devo)");

  assert.equal(check.ok, false, "a path that resolves differently in every directory is not a comparison");
  assert.match(check.error, /index\.js is recorded as a relative path/);
  assert.match(check.error, /names a different file in every directory/);
});

// A copy that is there and cannot be read is a copy that was not compared. Left
// to the digest alone the check would read it as changed -- and it is not known
// to be changed; it is unknown either way, and saying which is the difference
// between a report someone can act on and one they cannot.
test("reports a copy it cannot read instead of calling it changed", (t) => {
  const { installed } = install();
  chmodSync(installed, 0o000);
  t.after(() => chmodSync(installed, 0o644));
  try {
    readFileSync(installed);
    t.skip("this user can read any file");
    return;
  } catch {
    // unreadable, which is the state under test
  }

  const check = find(checks(), "runtime copies (tools/devo)");

  assert.equal(check.ok, false);
  assert.match(check.error, /could not be read, so it was not compared/);
  assert.doesNotMatch(check.error, /was changed after it was installed/);
});

// The header is read as the strings it is meant to hold. A field of another type
// is not a value to print: `join` throws on it, which would take the whole
// provider down instead of reporting the manifest that cannot be read.
test("reports a manifest header that is not a string instead of failing on it", () => {
  install();
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  write(manifestPath, JSON.stringify({ ...manifest, repo: { path: repo } }, null, 2));
  const list = checks();

  assert.equal(list.length, 1);
  assert.equal(list[0].ok, false);
  assert.match(list[0].error, /repo is not a string/);
});

// `path` is the field every failure line names, and `unreadable` is the reason a
// read is reported as failed -- both are the check's own fields, not the
// manifest's to set. Read by spreading the file over them, a manifest wrote the
// report: it could state that it was unreadable, and an object in either field
// took the whole provider down with "Cannot convert object to primitive value"
// instead of being reported as the defect it is.
test("reads its own two fields as its own, not the manifest's", () => {
  install();
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

  write(manifestPath, JSON.stringify({ ...manifest, repo: 5, path: { toString: "spoofed" } }, null, 2));
  const malformed = checks();
  assert.equal(malformed.length, 1);
  assert.equal(malformed[0].ok, false);
  assert.match(malformed[0].error, /repo is not a string/);
  assert.match(malformed[0].error, /INSTALLED\.json/, "the line names the manifest, not what the manifest said");
  assert.doesNotMatch(malformed[0].error, /spoofed/);

  // A readable manifest declaring itself unreadable is a manifest being
  // described by a field it set, so the copies are compared as they are.
  write(manifestPath, JSON.stringify({ ...manifest, unreadable: { toString: "spoofed" } }, null, 2));
  const list = checks();
  const header = find(list, "install manifest");
  assert.ok(header, "a readable manifest is read, whatever it claims about itself");
  assert.equal(header.ok, true, header.error);
  const hook = find(list, "hook copy (claude/hooks)");
  assert.equal(hook.ok, true, hook.error);
});

// A manifest that records fewer copies than are installed is a manifest with the
// one entry that would have held a copy left out of it, and the copy on disk is
// what tells that apart from an install that writes none of that kind. Nothing of
// another kind is recorded either, so the state being tested is the hook's alone:
// the copy is there, and the manifest has stopped saying so.
test("fails on a manifest that records fewer copies than are installed", () => {
  install();
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  write(
    manifestPath,
    JSON.stringify({ ...manifest, artifacts: manifest.artifacts.filter((a) => a.target !== "hook") }, null, 2),
  );
  const check = find(checks(), "hook copy (claude/hooks)");

  assert.ok(check, "the kind of copy the install writes is still named");
  assert.equal(check.ok, false);
  assert.equal(check.skipped, undefined, "a copy that is on disk is not a check that could not be made");
  assert.match(check.summary, /nothing records it/);
  assert.match(check.error, /gcloud-guard\.sh is installed, but the manifest records no hook copy/);
  assert.match(check.error, /run skill\/install\.sh/);
});

// An absolute path is not yet the copy it is recorded as: it has to be the path
// that kind of copy is installed at. Spelled through `..` it reached the
// repository source -- which is the file whose digest was recorded, because the
// source is what the digest was taken from -- while the installed copy was a
// different file, and the entry was reported as matching.
test("fails on an absolute path that reaches something other than the copy it records", () => {
  const { guardSource, guardInstalled } = install();
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  // From the hook directory up to the sandbox, then into the repository.
  const elsewhere = `${hooks}/../../../repo/skill/hooks/gcloud-guard.sh`;
  assert.equal(sha(elsewhere), sha(guardSource), "the spelling reaches the repository source");
  writeFileSync(guardInstalled, "guard edited in place");
  assert.notEqual(sha(guardInstalled), sha(guardSource), "and that is not the copy that is installed");

  write(
    manifestPath,
    JSON.stringify(
      {
        ...manifest,
        artifacts: manifest.artifacts.map((a) => (a.target === "hook" ? { ...a, installed: elsewhere } : a)),
      },
      null,
      2,
    ),
  );
  const check = find(checks(), "hook copy (claude/hooks)");

  assert.equal(check.ok, false, "a path that is not where the copy is installed is not a comparison");
  assert.match(check.error, /is not where a hook copy is installed/);
  assert.match(check.error, /reinstall/);
  assert.doesNotMatch(check.error, /was changed after it was installed/);
});

// The installer writes a regular file, so a link at that path is a copy that is
// not there. Read through the link the digest is the target's, so a symlink into
// the repository source was digested as the installed copy and reported as
// matching -- an install whose real copy is gone, reported as intact.
test("reports a symlink at the installed path instead of digesting what it points at", (t) => {
  const { guardSource, guardInstalled } = install();
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  rmSync(guardInstalled);
  symlinkSync(guardSource, guardInstalled);
  // The fixture is put back: the next install() writes a file at that path, and a
  // link left there would have it write through to the repository source.
  t.after(() => rmSync(guardInstalled, { force: true }));
  assert.equal(readFileSync(guardInstalled, "utf8"), readFileSync(guardSource, "utf8"), "the link reads as the source");

  write(
    manifestPath,
    JSON.stringify(
      {
        ...manifest,
        artifacts: manifest.artifacts.map((a) =>
          a.target === "hook" ? { ...a, installed: guardInstalled, sha256: sha(guardSource) } : a,
        ),
      },
      null,
      2,
    ),
  );
  const check = find(checks(), "hook copy (claude/hooks)");

  assert.equal(check.ok, false);
  assert.match(check.error, /gcloud-guard\.sh is not a regular file/);
  assert.doesNotMatch(check.error, /was changed after it was installed/);
});

// A directory at the installed path is named as what is there. Asked whether the
// path is a file, a directory answers no -- and the check read that as "missing",
// which is a different state with a different remedy.
test("reports a directory at the installed path as not a regular file, not as missing", (t) => {
  const { guardInstalled } = install();
  rmSync(guardInstalled);
  mkdirSync(guardInstalled);
  t.after(() => rmSync(guardInstalled, { recursive: true, force: true }));
  const check = find(checks(), "hook copy (claude/hooks)");

  assert.equal(check.ok, false);
  assert.match(check.error, /gcloud-guard\.sh is not a regular file/);
  assert.doesNotMatch(check.error, /is missing/);
});

// An install writes files into the directories it creates, so an empty one is a
// directory and not an install. Read as the evidence of one it reports a copy
// that is not there -- a failure the check invented, on a machine where nothing
// was installed at that path.
test("does not read an empty directory as an installed copy", () => {
  install();
  const empty = join(sandbox, "home", ".codex", "skills", "devo");
  mkdirSync(empty, { recursive: true });

  const recorded = find(checks(), "skill copies (skills/devo)");
  assert.equal(recorded.ok, false, "a copy that is not there is not a check that was made");
  assert.equal(recorded.skipped, true);
  assert.match(recorded.summary, /no skill copy is recorded/);

  // The same rule where the manifest is the thing that is gone: what is there is
  // what a manifest is missing for, and an empty directory is not among it.
  rmSync(manifestPath);
  const unrecorded = checks();
  assert.equal(unrecorded.length, 1);
  assert.equal(unrecorded[0].ok, false);
  assert.match(unrecorded[0].error, /tools[/\\]devo/);
  assert.doesNotMatch(unrecorded[0].error, /skills[/\\]devo/);
});
