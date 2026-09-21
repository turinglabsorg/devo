import { spawnSync } from "child_process";
import { createHash } from "crypto";
import { existsSync, readFileSync, statSync } from "fs";
import { join } from "path";

/**
 * The copies install.sh wrote, and whether they are still the copies it wrote.
 *
 * The guard, the CLI and the skill documents are edited in the repository and
 * copied into place. An installed copy that is edited instead works immediately,
 * and the divergence is found much later, when it is no longer clear which copy
 * is the truth -- a guard that no longer matches its own tests, a refusal that
 * only exists on this machine. Nothing said so until this check existed: it
 * compares each installed file against the digest install.sh recorded for it, so
 * a hand-edited copy is named the next time the doctor runs.
 *
 * Three states, and they are different things:
 *   repo == installed == manifest   the copy is the one that was installed
 *   repo != installed == manifest   the repository has moved on: reinstall
 *   installed != manifest           the installed copy changed: edit the
 *                                   repository and reinstall, never the copy
 */
function codexHome() {
  return process.env.CODEX_HOME || join(process.env.HOME || "", ".codex");
}

export function manifestPath() {
  return process.env.DEVO_INSTALL_MANIFEST || join(codexHome(), "tools", "devo", "INSTALLED.json");
}

const TARGETS = {
  runtime: "runtime copies (tools/devo)",
  skill: "skill copies (skills/devo)",
  hook: "hook copy (claude/hooks)",
};

function digest(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** A manifest entry that points at anything other than a file is not comparable. */
function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function readManifest() {
  const path = manifestPath();
  if (!existsSync(path)) return null;
  try {
    return { path, ...JSON.parse(readFileSync(path, "utf8")) };
  } catch (error) {
    return { path, unreadable: error.message };
  }
}

function repoHead(repo) {
  if (!repo || !existsSync(join(repo, ".git"))) return null;
  const result = spawnSync("git", ["-C", repo, "rev-parse", "--short", "HEAD"], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

/**
 * A copy that differs from its own manifest, grouped by where it is installed.
 * Grouped rather than one check per file: a healthy install is three lines, and
 * a broken one still names every file it found.
 */
function copyChecks(manifest) {
  const checks = [];

  for (const [target, label] of Object.entries(TARGETS)) {
    const entries = (manifest.artifacts || []).filter((artifact) => artifact.target === target);
    if (entries.length === 0) continue;

    const diverged = [];
    const pending = [];
    const missing = [];

    for (const artifact of entries) {
      if (!isFile(artifact.installed)) {
        missing.push(artifact.installed);
        continue;
      }

      if (digest(artifact.installed) !== artifact.sha256) {
        diverged.push(artifact.installed);
        continue;
      }

      // The installed copy is the one that was installed, so a difference here
      // is the repository being ahead of the install: a pending reinstall, not a
      // defect. It happens on every uninstalled edit, which is why it is a
      // warning rather than a failure.
      const source = join(manifest.repo || "", artifact.source);
      if (manifest.repo && isFile(source) && digest(source) !== artifact.sha256) {
        pending.push(artifact.source);
      }
    }

    const ok = diverged.length === 0 && missing.length === 0;
    checks.push({
      name: label,
      ok,
      summary: ok
        ? `${entries.length} file${entries.length === 1 ? " matches" : "s match"} the manifest`
        : `${diverged.length + missing.length} of ${entries.length} differ from the manifest`,
      warning: pending.length
        ? `the repository copy is newer for ${pending.length} file(s): reinstall with skill/install.sh`
        : "",
      error: ok
        ? ""
        : [
            ...diverged.map((path) => `${path} was changed after it was installed`),
            ...missing.map((path) => `${path} is missing`),
            `edit the repository copy and reinstall: an installed copy is never the source`,
          ].join("\n       "),
    });
  }

  return checks;
}

export function installChecks() {
  const manifest = readManifest();

  if (!manifest) {
    // Absence is not drift: an install that predates the manifest left nothing
    // to compare against, and saying "ok" here would claim a check that could
    // not be made.
    return [
      {
        name: "install manifest",
        ok: true,
        skipped: true,
        summary: `no manifest at ${manifestPath()}: run skill/install.sh to start recording the installed copies`,
      },
    ];
  }

  if (manifest.unreadable) {
    return [
      {
        name: "install manifest",
        ok: false,
        summary: "unreadable",
        error: `${manifest.path}: ${manifest.unreadable}`,
      },
    ];
  }

  const head = repoHead(manifest.repo);
  const checks = [
    {
      name: "install manifest",
      ok: true,
      summary: `installed ${manifest.installedAt || "(no timestamp)"} from ${manifest.repoCommit || "(no commit recorded)"}`,
      warning:
        head && manifest.repoCommit && head !== manifest.repoCommit
          ? `the repository is at ${head} now: the install is behind it`
          : "",
    },
  ];

  return [...checks, ...copyChecks(manifest)];
}
