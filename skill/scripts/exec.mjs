import { spawnSync } from "child_process";
import { existsSync, realpathSync } from "fs";
import { basename, dirname, join, resolve, sep } from "path";

import { ambientRoot } from "./ambient.mjs";
import { guardMutation } from "./gcloud.mjs";
import {
  assertProjectAllowed,
  listProfiles,
  profileEnv,
  repairCommand,
  requireProfile,
  selectedAccountOf,
} from "./profiles.mjs";

/** The application-default credentials of a root, which gcloud looks for under
 *  CLOUDSDK_CONFIG and a client library looks for under the home directory. */
const ADC_FILE = "application_default_credentials.json";

/**
 * The spellings of an identity root and of the credential stores inside one.
 *
 * A first pass, not the judgement: it catches the argument that names identity
 * material at a path nothing can resolve -- a `~`, a store written with no file
 * behind it yet, a root belonging to another user -- and it refuses the
 * documented location whatever the command underneath does with it. The refusal
 * that does not depend on how a root is written is the resolution below; this
 * pass only ever adds refusals to it.
 */
const IDENTITY_MATERIAL = [
  ".config/gcloud",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "credentials.db",
  "access_tokens.db",
  ADC_FILE,
];

/**
 * One path, as a process on this machine would land on it rather than as it was
 * spelled.
 *
 * This route exists so that no caller ever writes a root down: `devo exec` pins
 * CLOUDSDK_CONFIG for the process it starts, and the command underneath reads
 * that root instead of being handed it. What keeps the route from becoming a
 * laundering route is a refusal -- it will not pass on an argument that names a
 * root, so it cannot be told to mount, copy or build from one, whatever the
 * command underneath happens to be.
 *
 * The refusal resolves the argument instead of matching its text, because the
 * roots are configuration and the same directory can be written down in more
 * than one way. A root relocated through `DEVO_GCLOUD_PROFILES_DIR` contains
 * none of the letters of the default path, and on a case-insensitive filesystem
 * another case names the same directory: both are a root, spelled without any of
 * its usual text.
 *
 * One argument can denote two directories, because the tools on this machine do
 * not agree on what `..` means when it follows a symlink. The kernel -- and so a
 * mount, an `open`, a `tar -C` -- follows the symlink and then applies `..` to
 * the directory it reached (`realpathSync.native`, which is that walk); the
 * JavaScript `realpathSync` and Node's `resolve` collapse `..` lexically first,
 * which is what BSD `ls` does. An argument like `<symlink to a root>/..` is the
 * root under the first reading and the symlink's own directory under the second,
 * and a route that judged only one of them would hand over the root to whichever
 * kind of process reads it the other way. Both are computed and both are judged:
 * a path that denotes a root under either reading is a root.
 *
 * `realpathSync` does not restore the case a directory is stored under, it
 * answers with the case it was asked in (measured on this Mac), so the fold below
 * is what brings the two spellings of one directory together. Folding can only
 * refuse a path that differs from a root by case alone, which is the safe answer.
 */
function kernelPath(value) {
  // The walk the kernel makes: each component is resolved where it stands, so a
  // `..` applies to the directory the walk has reached. Nothing is normalised
  // before the walk starts -- collapsing `..` textually first is exactly the
  // reading this one exists to disagree with.
  let path = value;
  const tail = [];
  for (;;) {
    try {
      return join(realpathSync.native(path), ...tail).toLowerCase();
    } catch {
      const parent = dirname(path);
      // Nothing of the path resolves: `resolve` is used only here, where there is
      // no symlink left to follow and the most the text can say is where the path
      // would be. The deepest ancestor that does exist is resolved normally, which
      // matters because a path that is not there yet -- a configuration file
      // inside a root -- still denotes a place inside the directory that would
      // hold it: on this filesystem `/var` is `/private/var`, so a tail appended
      // to the unresolved spelling would compare against a root it never matches.
      if (parent === path || parent === "." || parent === "") {
        return join(resolve(path), ...tail).toLowerCase();
      }
      tail.unshift(basename(path));
      path = parent;
    }
  }
}

/** The same argument read the way a text-first tool reads it: `..` collapsed
 *  before any symlink is followed. Kept because BSD `ls`, `find` and other
 *  utilities on this machine resolve paths that way, so a mount argument that
 *  reaches one of them denotes what this returns. */
function lexicalPath(value) {
  let path = resolve(value);
  const tail = [];
  for (;;) {
    try {
      return join(realpathSync(path), ...tail).toLowerCase();
    } catch {
      const parent = dirname(path);
      if (parent === path) return join(path, ...tail).toLowerCase();
      tail.unshift(basename(path));
      path = parent;
    }
  }
}

const READINGS = [kernelPath, lexicalPath];

/** Every directory whose contents are identity material: each profile root, and
 *  the shared ambient root an identity can land in by not being pinned. Both
 *  readings of each root are kept, so an argument is compared against what a root
 *  denotes under either of them. */
function identityRoots() {
  return [
    ...new Set(
      [...listProfiles().map((profile) => profile.root), ambientRoot()].flatMap((root) =>
        READINGS.map((reading) => reading(root)),
      ),
    ),
  ];
}

/**
 * The paths an argument denotes, when it denotes any. A mount carries one as
 * `-v <source>:<target>`, a bind mount as `--mount type=bind,src=<source>,dest=
 * <target>`, a copy as a bare word: reading each of those shapes is what makes
 * the refusal hold for the argument and not only for the spelling.
 */
function pathsIn(argument) {
  return [argument, ...argument.split(/[:=,]/)].filter(Boolean);
}

function namesIdentityMaterial(argument, roots) {
  if (IDENTITY_MATERIAL.some((spelling) => argument.includes(spelling))) return true;

  return pathsIn(argument).some((candidate) =>
    READINGS.some((reading) => denotesRoot(reading(candidate), roots)),
  );
}

/**
 * Whether one reading of a path denotes an identity root.
 *
 * The filesystem root holds every root there is, so mounting it hands the pinned
 * root over as surely as naming it does. It is also the one ancestor the test
 * below cannot see, because it is above all of them: the root of the filesystem
 * is its own parent.
 */
function denotesRoot(path, roots) {
  if (dirname(path) === path) return true;

  return roots.some(
    (root) =>
      // The root itself, anything inside it (a credential store, a configuration
      // file), and anything above it: mounting a parent hands over the root just
      // as surely as naming it.
      path === root || path.startsWith(root + sep) || root.startsWith(path + sep),
  );
}

/**
 * What the route pins for the process it starts, and what it cannot pin.
 *
 * `CLOUDSDK_CONFIG` is where gcloud looks for its own ADC, and where a client
 * library does not: Go, Node and Python resolve the well-known ADC file by the
 * home directory, so a child of this route would authenticate as the ambient
 * root's identity while the route reports the profile as pinned. Naming the
 * profile's own file for the child closes that, and it is named only when the
 * profile has one -- pointing a child at a file that is not there would fail a
 * process that works today through the profile's credential store (the docker
 * credential helper), and a profile with no ADC of its own is a state this route
 * reports rather than one it can repair.
 *
 * Returned rather than written, so the environment can be judged without starting
 * a process and without an argument that names the variable.
 */
export function pinnedEnv(profile, { projectId, account } = {}) {
  const env = profileEnv(profile);
  // Exported rather than appended: the command is not gcloud, so it has no
  // --project or --account flag to put them on.
  if (projectId) env.CLOUDSDK_CORE_PROJECT = projectId;
  if (account) env.CLOUDSDK_CORE_ACCOUNT = account;

  const adc = join(profile.root, ADC_FILE);
  if (existsSync(adc)) {
    env.GOOGLE_APPLICATION_CREDENTIALS = adc;
    return { env, warning: "" };
  }

  return {
    env,
    warning:
      `note: profile ${profile.name} has no application-default credentials of its own, so a child that resolves ADC by the well-known file reads the ambient root's. Set them with:\n` +
      `  CLOUDSDK_CONFIG=${profile.root} gcloud auth application-default login ${account || "<account>"}\n`,
  };
}

/**
 * Runs any command with one profile root pinned for it.
 *
 * `devo gcloud` cannot serve a caller that is not gcloud -- the docker CLI and
 * the credential helper it spawns, terraform, an ADC client library. Those need
 * the same root, and asking each caller to spell `CLOUDSDK_CONFIG=<root>` on its
 * own command line is how an environment pin became indistinguishable from a
 * handed-over root. Here the root is pinned once, from the registry, and the
 * caller names a profile instead of a directory.
 *
 * The account in the root is checked the way `devo gcloud` checks it: a root
 * whose active account is not the expected one is a drift detector firing, not a
 * working identity. When the profile declares no account there is nothing to
 * compare against -- a credential helper reads the root's own active account --
 * so the check steps aside instead of refusing a call it cannot judge.
 */
export function runExec({ profileName, projectId, account, allowMutation, args }) {
  const profile = requireProfile(profileName);
  if (args.length === 0) {
    throw new Error(
      "Missing command. Usage: devo exec --profile <name> [--project <id>] -- <command...>",
    );
  }

  // A gcloud mutation reached through this route is still a mutation: prefixing
  // a call with `devo exec` must not side-step the guard that asks for
  // --allow-mutation. The command word is read as the tool it names, the way the
  // harness guard reads a transfer verb, so a directory in front of the name
  // (`/usr/bin/gcloud`, `/opt/homebrew/bin/gcloud`) is the same program being
  // started. What is read is the gcloud call the route was asked to start, not one
  // a shell wrapper runs on its own -- a shell string has no end, and a text test
  // that pretended to follow it would only look like a boundary.
  // `skill/test/exec.test.mjs` records that boundary as a residual.
  if (basename(args[0]) === "gcloud") guardMutation(args.slice(1), { allowMutation });

  assertProjectAllowed(profile, projectId);

  const effectiveAccount = account || profile.account;
  const identity = selectedAccountOf(profile);
  if (identity.ok && identity.account && effectiveAccount && identity.account !== effectiveAccount) {
    throw new Error(
      `Profile ${profile.name} currently has ${identity.account} active, but ${effectiveAccount} is expected. Repair it with:\n  ${repairCommand(profile.name)}`,
    );
  }

  const roots = identityRoots();
  const named = args.filter((argument) => namesIdentityMaterial(argument, roots));
  if (named.length) {
    throw new Error(
      `Refusing to pass on ${named.join(", ")}: this route pins one profile root for the command it starts and never hands a root to anything else.\n` +
        "The child already has CLOUDSDK_CONFIG set, so a registry push or a credential helper needs no root of its own.",
    );
  }

  const { env, warning } = pinnedEnv(profile, { projectId, account: effectiveAccount });
  if (warning) process.stderr.write(warning);

  const result = spawnSync(args[0], args.slice(1), { env, stdio: "inherit" });
  if (result.error) {
    throw new Error(`Cannot run ${args[0]}: ${result.error.message}`);
  }

  return result.status ?? 1;
}
