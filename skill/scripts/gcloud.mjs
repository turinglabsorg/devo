import { spawnSync } from "child_process";

import { hushBin, secretPresence } from "./hush.mjs";
import { spawnIsolatedGcloud, withProfileLock } from "./isolate.mjs";
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

  const result = tty
    ? spawnIsolatedGcloud(profile, passthrough, { stdio: "inherit" })
    : spawnIsolatedGcloud(profile, passthrough, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

  if (tty) return result.status ?? 1;

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);

  if (result.status !== 0 && isStaleToken(result.stderr) && !identityScoped(args)) {
    process.stderr.write(
      `\nProfile ${profile.name} has stale credentials. Repair with:\n  ${repairCommand(profile.name)}\n`,
    );
  }

  return result.status ?? 1;
}

/** The variable hush injects the key into. Named here so the script below and
 *  the `--env` flag cannot drift apart. */
export const SERVICE_ACCOUNT_KEY_VAR = "DEVO_SERVICE_ACCOUNT_KEY";

/**
 * The shell that turns the injected key into a credential this root holds, and
 * then deletes the file it had to write.
 *
 * gcloud only reads a service account key from a path, so the value has to touch
 * the disk for the length of one command. The file is created under `umask 077`
 * in a mode-600 mktemp, and the trap removes it on every exit path -- including
 * the one where gcloud fails. The command is deliberately not `exec`ed: exec
 * replaces this shell, and the EXIT trap goes with it, which is exactly how a
 * key file survives the command it was written for.
 *
 * Nothing here ever prints the value. hush injects it into the environment, the
 * shell writes it to the file, gcloud reads the file, the file is removed. It
 * does not pass through this process, its argv, or its output.
 */
const ACTIVATION_SCRIPT = [
  "umask 077",
  'key_file="$(mktemp "${TMPDIR:-/tmp}/devo-sa-key.XXXXXX")"',
  'trap "rm -f $key_file" EXIT',
  'printf %s "$DEVO_SERVICE_ACCOUNT_KEY" > "$key_file"',
  'gcloud auth activate-service-account --key-file="$key_file"',
].join("\n");

/**
 * Activates the profile's declared service account from the hush secret.
 *
 * The key is read by hush, not by this process: devo spawns `hush run`, which
 * injects the value into the child environment and filters it out of the child's
 * output. There is no code path here that receives the value.
 */
export function activateFromHush(name) {
  const profile = requireProfile(name);

  const keyName = profile.serviceAccount?.keyName;
  if (!keyName) {
    throw new Error(
      `Profile ${profile.name} declares no serviceAccount.keyName, so there is no secret to activate from. Declare it in the devo registry first.`,
    );
  }

  process.stderr.write(
    `Activating profile ${profile.name} from hush secret ${keyName} (the value is never printed, and never reaches this process)\n`,
  );

  const result = withProfileLock(profile.name, () =>
    spawnSync(
      hushBin(),
      ["run", "--name", keyName, "--env", SERVICE_ACCOUNT_KEY_VAR, "--redact", "--", "/bin/sh", "-c", ACTIVATION_SCRIPT],
      // The root travels in the environment, so the `gcloud` inside the script
      // writes into the profile and nowhere else -- same guarantee the guard gives
      // every other call. The lock is the same one `devo gcloud` holds, so an
      // activation cannot refresh the store while another call has it open.
      { env: profileEnv(profile), stdio: "inherit" },
    ),
  );

  if (result.error) {
    process.stderr.write(`hush could not be started: ${result.error.message}\n`);
    return 1;
  }

  return result.status ?? 1;
}

/**
 * The sequence that creates the service account, for a human to run.
 *
 * Printed rather than executed, and that is deliberate: this branch needs the
 * human credential, and it needs two facts about the client's project that decide
 * whether a key can exist at all. Both are read-only checks, and neither has been
 * made yet. Running the sequence blind would either fail halfway or -- worse, if
 * the organisation forbids keys -- leave the impression that the identity is in
 * place when nothing was created.
 *
 * `devo auth bootstrap` runs this only to say what to type; when the key is in
 * the vault it activates instead, and when the vault cannot be read it refuses.
 */
function printCreateSequence(profile) {
  const serviceAccount = profile.serviceAccount;
  const accountId = serviceAccount.email.split("@")[0];
  // The project the declaration names, which is not always the health project:
  // an account lives in one project, and a health probe may well point at
  // another. Falling back to the health project keeps a declaration that does
  // not say where its account lives from printing nothing usable.
  const project = serviceAccount.project || profile.healthProject || "<project>";

  process.stderr.write(
    [
      `Profile ${profile.name} has no service account key in hush yet (${serviceAccount.keyName}), so there is nothing to activate.`,
      "",
      "Bootstrapping it needs the human credential one time. If that credential is dead, repair it first:",
      `  devo auth repair ${profile.name}`,
      "",
      "Then, in the profile and only in the profile:",
      "",
      `  devo gcloud --profile ${profile.name} --project ${project} -- \\`,
      `    iam service-accounts create ${accountId} --display-name="Devo read-only audit"`,
      "",
      `  devo gcloud --profile ${profile.name} --project ${project} -- \\`,
      `    projects add-iam-policy-binding ${project} \\`,
      `      --member="serviceAccount:${serviceAccount.email}" --role=roles/viewer`,
      "",
      // A service account lives in one project and is read in another: the
      // health probe asks the health project for its description as this
      // account, so a binding on the account's own project alone leaves the
      // probe failing with a permission error that reads like a dead token.
      ...(profile.healthProject && profile.healthProject !== project
        ? [
            `  devo gcloud --profile ${profile.name} --project ${profile.healthProject} -- \\`,
            `    projects add-iam-policy-binding ${profile.healthProject} \\`,
            `      --member="serviceAccount:${serviceAccount.email}" --role=roles/viewer`,
            "",
            `The second binding is not decoration: the health probe reads ${profile.healthProject} as this`,
            "account, and without it every probe after the bootstrap reports a permission failure.",
            "",
          ]
        : []),
      `  devo gcloud --profile ${profile.name} --project ${project} -- \\`,
      `    iam service-accounts keys create ./${accountId}.json --iam-account=${serviceAccount.email}`,
      "",
      "Two read-only checks decide whether that can work at all, and both come first:",
      `  1. whether ${profile.account} may create service accounts and keys in ${project};`,
      "  2. whether the organisation enforces constraints/iam.disableServiceAccountKeyCreation,",
      "     which forbids keys outright and leaves only workload identity federation.",
      "",
      "Then hand the key to the vault by name. hush has no command that stores a value, so this",
      "step is the human's: share the key through a channel that is not this one and put it in",
      "hush as a file secret named:",
      "",
      `  ${serviceAccount.keyName}`,
      "",
      "and delete the downloaded key file. After that:",
      "",
      `  devo auth bootstrap ${profile.name}`,
      "",
      "activates it from the vault, and the human credential is never needed again -- it may die,",
      "and the profile keeps working, because it no longer authenticates as the human.",
      "",
    ].join("\n"),
  );
}

/**
 * The flow the profile follows: look for the key in hush, use it if it is there,
 * and say what to run if it is not.
 *
 * The three answers of `secretPresence` are kept apart on purpose. `present:
 * null` -- the vault could not be read -- is a refusal, not a missing key: taking
 * it for absent would start creating a second key over one that already exists,
 * and the second key is the one nobody would know about.
 */
export function bootstrapProfile(name) {
  const profile = requireProfile(name);

  if (!profile.serviceAccount?.keyName) {
    throw new Error(
      `Profile ${profile.name} declares no serviceAccount, so there is nothing to bootstrap. A human-identity profile has no non-interactive form to fall back on.`,
    );
  }

  const presence = secretPresence(profile.serviceAccount.keyName);
  if (presence.present === null) {
    throw new Error(
      `Refusing to bootstrap ${profile.name}: could not tell whether ${profile.serviceAccount.keyName} is in the vault (${presence.error}). Creating a key over an existing one would leave two credentials where the registry expects one.`,
    );
  }

  if (!presence.present) {
    printCreateSequence(profile);
    return 1;
  }

  return activateFromHush(profile.name);
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
  const result = spawnIsolatedGcloud(profile, ["auth", "login", profile.account], {
    stdio: "inherit",
  });
  return result.status ?? 1;
}
