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
 *
 * `auth activate-service-account` and `config set account` are here for the
 * reason the harness guard names them: the first stores a credential in that
 * root, the second changes which identity an unprefixed call will silently use.
 */
const MUTATING_SUBCOMMANDS = [
  {
    group: "auth",
    subcommands: ["login", "application-default", "activate-service-account"],
    why: "it changes authentication",
  },
  {
    group: "config",
    subcommands: ["set", "unset", "configurations"],
    why: "it rewrites configuration",
  },
];

/**
 * The global flags of gcloud whose value is the token after them. The pair is
 * read from gcloud's own flag list because nothing in the command text says
 * which flag takes a value, and reading a value as the subcommand is how
 * `gcloud --project <id> auth login` was judged as a call that is not a mutation.
 */
const GLOBAL_FLAGS_TAKING_A_VALUE = new Set([
  "--account",
  "--access-token-file",
  "--billing-project",
  "--configuration",
  "--credential-file-override",
  "--filter",
  "--flags-file",
  "--flatten",
  "--format",
  "--impersonate-service-account",
  "--project",
  "--trace-token",
  "--verbosity",
]);

/** A flag rather than a word of the call. `-` alone is a word (the conventional
 *  stdin argument) and ends the walk; `--` ends the flags and is stepped over
 *  like a flag whose value is not known, so what follows it is judged either way. */
function isFlag(token) {
  return token.length > 1 && token.startsWith("-");
}

/**
 * Every position at which the subcommand of a gcloud call may begin, leftmost
 * reading first.
 *
 * The command word is followed by a run of global flags -- `gcloud -q auth
 * login`, `gcloud --project <id> --verbosity debug auth login` -- and each flag
 * may carry its value as the token after it. Reading the subcommand at `args[0]`
 * recognised one spelling of a mutation and judged every other one as a
 * different call, so a flag in front of `auth login` was a mutation this guard
 * could not see at all.
 *
 * A flag written as `--name=value` carries its own value and steps over nothing.
 * A flag whose name is known to take a value steps over the token after it --
 * that token is its value, not the subcommand. A flag whose name is not known
 * (`--log-http`, or one a later gcloud adds) leaves the token after it unreadable
 * from the text: it is either that flag's value or the subcommand, so that token
 * is a candidate and the walk continues past it as though it were the value,
 * which keeps both readings. A mutation is refused if it sits at any candidate,
 * so the reading that shows the mutation is the one that decides.
 */
function subcommandCandidates(args) {
  const candidates = [];
  let index = 0;

  while (index < args.length && isFlag(args[index])) {
    const token = args[index];
    index += 1;
    if (token.includes("=")) continue;
    if (index < args.length && isFlag(args[index])) continue;
    if (GLOBAL_FLAGS_TAKING_A_VALUE.has(token)) {
      index += 1;
      continue;
    }
    candidates.push(index);
    index += 1;
  }

  candidates.push(index);
  return [...new Set(candidates)].sort((left, right) => left - right);
}

/** The position the subcommand is read from: the leftmost one it may occupy. */
function subcommandIndex(args) {
  return subcommandCandidates(args)[0];
}

/**
 * Which mutating pair the call carries, if any. Judged at every candidate
 * position, because a call whose leading flag this guard does not know is read
 * both ways: the mutation is found under the reading that shows it, and a
 * spelling that only hides it under the other one is refused all the same.
 */
function mutationIn(args) {
  for (const index of subcommandCandidates(args)) {
    const [group, subcommand] = [args[index], args[index + 1]];
    const mutation = MUTATING_SUBCOMMANDS.find(
      (candidate) => candidate.group === group && candidate.subcommands.includes(subcommand),
    );
    if (mutation) return mutation;
  }

  return undefined;
}

export function guardMutation(args, { allowMutation }) {
  const mutation = mutationIn(args);
  if (mutation && !allowMutation) {
    throw new Error(
      `Refusing a mutating gcloud command because ${mutation.why}. Re-run with --allow-mutation if this is intended, or use \`devo auth repair <profile>\` for a credential repair.`,
    );
  }
}

/**
 * Whether the call is about the identity rather than about resources. An `auth`
 * or `config` group reads and writes the root itself, so the project and the
 * account are not pinned onto it and the account drift check steps aside. Read
 * past the same run of flags, for the same reason: `gcloud -q config set account
 * <email>` is a configuration change with a flag in front of it.
 */
function identityScoped(args) {
  const group = args[subcommandIndex(args)];
  return group === "auth" || group === "config";
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

  if (!identityScoped(args)) {
    const identity = selectedAccountOf(profile);
    if (identity.ok && identity.account && identity.account !== effectiveAccount) {
      throw new Error(
        `Profile ${profile.name} currently has ${identity.account} active, but ${effectiveAccount} is expected. Repair it with:\n  ${repairCommand(profile.name)}`,
      );
    }
  }

  const passthrough = identityScoped(args)
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

  if (result.status !== 0 && isStaleToken(result.stderr) && !identityScoped(args)) {
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
