import { spawnSync } from "child_process";

import {
  assertProjectAllowed,
  isStaleToken,
  listProfiles,
  profileEnv,
  repairCommand,
  requireProfile,
  selectedAccountOf,
} from "./profiles.mjs";

/**
 * gcloud subcommands that change authentication or configuration. They stay
 * blocked unless the caller states that the mutation is intended: a bare
 * `gcloud auth login` writes into whatever root happens to be ambient, and that
 * is how credentials ended up in the shared global config.
 */
const MUTATING_SUBCOMMANDS = [
  { matches: (args) => args[0] === "auth" && ["login", "application-default"].includes(args[1]), why: "it changes authentication" },
  { matches: (args) => args[0] === "config" && ["set", "unset", "configurations"].includes(args[1]), why: "it rewrites configuration" },
];

const IDENTITY_SCOPED = (args) => args[0] === "auth" || args[0] === "config";

export function guardMutation(args, { allowMutation }) {
  const mutation = MUTATING_SUBCOMMANDS.find((candidate) => candidate.matches(args));
  if (mutation && !allowMutation) {
    throw new Error(
      `Refusing a mutating gcloud command because ${mutation.why}. Re-run with --allow-mutation if this is intended, or use \`devo auth repair <profile>\` for a credential repair.`,
    );
  }
}

/**
 * Runs gcloud inside one profile root with the account and project pinned.
 *
 * The identity is never inferred: `--profile` is mandatory, the active account
 * inside the root must match the registry, and a project owned by another
 * profile is refused. Output is captured so a dead refresh token can be
 * rewritten into the exact repair command instead of the raw gcloud text.
 */
export function runGcloud({ profileName, projectId, account, allowMutation, tty, args }) {
  const profile = requireProfile(profileName);
  if (args.length === 0) throw new Error("Missing gcloud arguments. Usage: devo gcloud --profile <name> -- <gcloud args>");

  guardMutation(args, { allowMutation });
  assertProjectAllowed(profile, projectId);

  const effectiveAccount = account || profile.account;
  if (!effectiveAccount) {
    throw new Error(`Profile ${profile.name} declares no account; pass --account explicitly.`);
  }

  if (!IDENTITY_SCOPED(args)) {
    const identity = selectedAccountOf(profile);
    if (identity.ok && identity.account && identity.account !== effectiveAccount) {
      throw new Error(
        `Profile ${profile.name} currently has ${identity.account} active, but ${effectiveAccount} is expected. Repair it with:\n  ${repairCommand(profile.name)}`,
      );
    }
  }

  const passthrough = IDENTITY_SCOPED(args)
    ? args
    : [...(projectId ? ["--project", projectId] : []), "--account", effectiveAccount, ...args];

  const options = { env: profileEnv(profile) };

  if (tty) {
    const result = spawnSync("gcloud", passthrough, { ...options, stdio: "inherit" });
    return result.status ?? 1;
  }

  const result = spawnSync("gcloud", passthrough, {
    ...options,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);

  if (result.status !== 0 && isStaleToken(result.stderr) && !IDENTITY_SCOPED(args)) {
    process.stderr.write(
      `\nProfile ${profile.name} has stale credentials. Repair with:\n  ${repairCommand(profile.name)}\n`,
    );
  }

  return result.status ?? 1;
}

/**
 * The only sanctioned credential repair: it names the profile root and the
 * account, so it can never touch the shared global config.
 */
export function repairProfile(name) {
  if (!name) {
    throw new Error(
      `Missing profile name. Usage: devo auth repair <profile>. Known profiles: ${listProfiles()
        .map((profile) => profile.name)
        .join(", ")}`,
    );
  }

  const profile = requireProfile(name);
  if (!profile.account) {
    throw new Error(`Profile ${profile.name} declares no account; add it to the registry before repairing.`);
  }

  process.stderr.write(`Repairing profile ${profile.name}: CLOUDSDK_CONFIG=${profile.root}\n`);
  const result = spawnSync("gcloud", ["auth", "login", profile.account], {
    env: profileEnv(profile),
    stdio: "inherit",
  });
  return result.status ?? 1;
}
