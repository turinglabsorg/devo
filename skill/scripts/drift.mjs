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
  wrapper: "CLI wrapper (bin/devo)",
  config: "configuration example (~/.devo)",
};

/**
 * The copies an install writes, whether or not a manifest records them. Read
 * only when there is no manifest, and read because of what the absence would
 * otherwise mean: the manifest is the one file that can be deleted to make this
 * check disappear, and a deletion is a commoner accident than an edit. What an
 * install leaves behind is the evidence that one is there.
 */
function installedCopies() {
  const home = process.env.HOME || "";
  return [
    join(codexHome(), "tools", "devo"),
    join(codexHome(), "skills", "devo"),
    join(process.env.DEVO_HOOK_DIR || join(home, ".claude", "hooks"), "gcloud-guard.sh"),
  ];
}

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
 * The manifest's copies, grouped by the part of the install they belong to.
 *
 * Everything the manifest records is judged: an entry whose target is not one of
 * the known labels is grouped under the name it carries, because a manifest that
 * records a copy is a manifest claiming something about it, and dropping the
 * entry would report the install as verified by a check that never looked. A
 * manifest that records nothing at all, or an entry that is not a record, is
 * reported instead of being read as an install with nothing to say.
 */
function artifactGroups(manifest) {
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length === 0) {
    return { error: "the manifest records no copies" };
  }

  const groups = new Map();
  for (const artifact of manifest.artifacts) {
    const recorded =
      artifact !== null &&
      typeof artifact === "object" &&
      typeof artifact.target === "string" &&
      typeof artifact.source === "string" &&
      typeof artifact.installed === "string" &&
      typeof artifact.sha256 === "string";
    if (!recorded) {
      return { error: `the manifest has an entry that is not a recorded copy: ${JSON.stringify(artifact)}` };
    }

    if (!groups.has(artifact.target)) groups.set(artifact.target, []);
    groups.get(artifact.target).push(artifact);
  }

  return { groups };
}

/**
 * A copy that differs from its own manifest, grouped by where it is installed.
 * Grouped rather than one check per file: a healthy install is a handful of
 * lines, and a broken one still names every file it found.
 */
function copyChecks(manifest, parsed) {
  const checks = [];

  for (const target of [...new Set([...Object.keys(TARGETS), ...parsed.groups.keys()])]) {
    const label = TARGETS[target] || `copies recorded as "${target}"`;
    const entries = parsed.groups.get(target) || [];

    if (entries.length === 0) {
      // Nothing of this kind is recorded, so there is nothing to compare -- a
      // check that could not be made, which is never a pass. It is not a failure
      // either: an install that writes no copy of this kind has nothing to
      // diverge from.
      checks.push({
        name: label,
        ok: false,
        skipped: true,
        summary: `no ${target} copy is recorded in the manifest`,
      });
      continue;
    }

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
    const present = installedCopies().filter((path) => existsSync(path));

    // Nothing installed and nothing recorded is the one state where there is no
    // check to make: devo is not on this machine, and saying "ok" would claim a
    // verification of an installation that is not there. `ok: false` with
    // `skipped: true` is how this codebase says exactly that -- a tool that is
    // not installed is reported the same way (`doctor.mjs`) -- and `allOk` keeps
    // the provider green on a skipped check, so a machine without an install is
    // not a machine in failure.
    if (present.length === 0) {
      return [
        {
          name: "install manifest",
          ok: false,
          skipped: true,
          summary: `devo is not installed here (no manifest at ${manifestPath()}): run skill/install.sh to install it and start recording the copies`,
        },
      ];
    }

    // Copies on disk with nothing recording them. That is not an install to be
    // compared, it is an install that cannot be compared, and the missing file
    // is the one deletion that would otherwise turn this check green: report what
    // is there and what to run.
    return [
      {
        name: "install manifest",
        ok: false,
        summary: `this install records no manifest: ${manifestPath()} is missing`,
        error: [
          ...present.map((path) => `${path} is installed, but nothing records what was written into it`),
          "run skill/install.sh: an install that records nothing cannot be told apart from one that was edited in place",
        ].join("\n       "),
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

  // Read before the header line: a manifest that records nothing, or an entry
  // that is not a record, is a manifest that cannot say what was installed, and
  // the timestamp and commit it also carries would read as a healthy install
  // reported by a check that never compared a file.
  const parsed = artifactGroups(manifest);
  if (parsed.error) {
    return [
      {
        name: "install manifest",
        ok: false,
        summary: "the manifest does not say what was installed",
        error: `${manifest.path}: ${parsed.error}`,
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

  return [...checks, ...copyChecks(manifest, parsed)];
}
