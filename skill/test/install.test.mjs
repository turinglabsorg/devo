import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

/**
 * The installer is run, not read: what it writes into a sandbox is the thing
 * under test. HOME is the whole redirection -- every destination is derived from
 * it -- so nothing here reaches the real installation, and the `devo` commands
 * the suite builds on are not the ones being measured.
 */
const skill = dirname(dirname(fileURLToPath(import.meta.url)));
const installer = join(skill, "install.sh");

const sandbox = mkdtempSync(join(tmpdir(), "devo-install-"));
after(() => rmSync(sandbox, { recursive: true, force: true }));

/** Every file under a directory, at any depth. */
function walk(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

/** Runs the installer with the given shell, into the given home. */
function installWith(shell, home) {
  const result = spawnSync(shell, [installer], {
    encoding: "utf8",
    // Explicit rather than inherited: an ambient CODEX_HOME, DEVO_BIN_DIR or
    // DEVO_HOOK_DIR is honoured by the installer, and one of them would put the
    // run outside the sandbox this test compares.
    env: {
      ...process.env,
      HOME: home,
      CODEX_HOME: join(home, ".codex"),
      DEVO_BIN_DIR: join(home, ".local", "bin"),
      DEVO_HOOK_DIR: join(home, ".claude", "hooks"),
    },
  });
  const manifest = join(home, ".codex", "tools", "devo", "INSTALLED.json");
  const read = () =>
    readFileSync(manifest, "utf8")
      .split(home)
      .join("<home>");
  return { home, result, manifest, read };
}

/**
 * The installer is bash -- the first line says so -- and `sh install.sh` is a
 * spelling it still has to survive, because of *where* a shell that cannot parse
 * it stops: past the copies, before the manifest. The files are new, the manifest
 * is the previous one, and the drift check reports every copy as changed after it
 * was installed -- the divergence the manifest is recorded to make visible,
 * produced by the install. Found by running it: the error arrives at the line
 * that lists a tree's files.
 */
test("runs under sh and records every copy it writes", (t) => {
  const syntax = spawnSync("sh", ["-n", installer], { encoding: "utf8" });
  assert.equal(syntax.status, 0, `sh cannot parse the installer: ${syntax.stderr.trim()}`);

  const { result, read } = installWith("sh", join(sandbox, "under-sh"));
  assert.equal(result.status, 0, result.stderr);
  if (/shasum not found/.test(result.stdout)) {
    t.skip("no shasum on this machine: the installer writes no manifest");
    return;
  }
  const recorded = JSON.parse(read());

  // Every file of a copied tree, at any depth. Recording only the first level
  // left the deeper files editable in place with nothing to compare them to.
  for (const [target, area] of [
    ["runtime", "scripts"],
    ["skill", "agents"],
    ["skill", "references"],
  ]) {
    const expected = walk(join(skill, area))
      .map((path) => `skill/${relative(skill, path)}`)
      .sort();
    const found = recorded.artifacts
      .filter((artifact) => artifact.target === target && artifact.source.startsWith(`skill/${area}/`))
      .map((artifact) => artifact.source)
      .sort();
    assert.deepEqual(found, expected, `every file of ${area} must be recorded`);
  }

  // The copies that are not in a tree are recorded too: they are written by this
  // script rather than copied, and an edit in place is the same divergence.
  for (const target of ["runtime", "skill", "hook", "wrapper", "config"]) {
    assert.ok(
      recorded.artifacts.some((artifact) => artifact.target === target),
      `a ${target} copy is installed and must be recorded`,
    );
  }
});

// The shell a caller happens to use is not a difference in what is installed.
// Compared field by field apart from the timestamp and the sandbox path, so a
// change made to satisfy one shell cannot pass by changing the install.
test("installs the same copies under sh as under bash", () => {
  // One directory, emptied between the two runs: the wrapper is generated rather
  // than copied and names the directory it was written for, so two sandboxes
  // would differ in that file's digest for a reason that is not the shell.
  const home = join(sandbox, "either-shell");
  const under = (shell) => {
    rmSync(home, { recursive: true, force: true });
    const run = installWith(shell, home);
    assert.equal(run.result.status, 0, run.result.stderr);
    const manifest = JSON.parse(run.read());
    delete manifest.installedAt;
    return manifest;
  };

  assert.deepEqual(under("sh"), under("bash"));
});
