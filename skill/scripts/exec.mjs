import { spawnSync } from "child_process";

import { guardMutation } from "./gcloud.mjs";
import {
  assertProjectAllowed,
  profileEnv,
  repairCommand,
  requireProfile,
  selectedAccountOf,
} from "./profiles.mjs";

/**
 * Spellings of an identity root, and of the credential stores inside one.
 *
 * This route exists so that no caller ever writes a root down: `devo exec` pins
 * CLOUDSDK_CONFIG for the process it starts, and the command underneath reads
 * that root instead of being handed it. The list below is what keeps the route
 * from becoming a laundering route -- the route refuses to pass on any argument
 * that names a root or a store, so `devo exec` cannot be told to mount, copy or
 * build from one, whatever the command underneath happens to be.
 *
 * `.config/gcloud` also covers the profile roots, which live in
 * `.config/gcloud-profiles`: the same prefix, so the same judgement.
 */
const IDENTITY_MATERIAL = [
  ".config/gcloud",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "credentials.db",
  "access_tokens.db",
  "application_default_credentials.json",
];

function namesIdentityMaterial(argument) {
  return IDENTITY_MATERIAL.some((spelling) => argument.includes(spelling));
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
  // --allow-mutation.
  if (args[0] === "gcloud") guardMutation(args.slice(1), { allowMutation });

  assertProjectAllowed(profile, projectId);

  const effectiveAccount = account || profile.account;
  const identity = selectedAccountOf(profile);
  if (identity.ok && identity.account && effectiveAccount && identity.account !== effectiveAccount) {
    throw new Error(
      `Profile ${profile.name} currently has ${identity.account} active, but ${effectiveAccount} is expected. Repair it with:\n  ${repairCommand(profile.name)}`,
    );
  }

  const named = args.filter(namesIdentityMaterial);
  if (named.length) {
    throw new Error(
      `Refusing to pass on ${named.join(", ")}: this route pins one profile root for the command it starts and never hands a root to anything else.\n` +
        "The child already has CLOUDSDK_CONFIG set, so a registry push or a credential helper needs no root of its own.",
    );
  }

  const env = profileEnv(profile);
  // Exported rather than appended: the command is not gcloud, so it has no
  // --project or --account flag to put them on.
  if (projectId) env.CLOUDSDK_CORE_PROJECT = projectId;
  if (effectiveAccount) env.CLOUDSDK_CORE_ACCOUNT = effectiveAccount;

  const result = spawnSync(args[0], args.slice(1), { env, stdio: "inherit" });
  if (result.error) {
    throw new Error(`Cannot run ${args[0]}: ${result.error.message}`);
  }

  return result.status ?? 1;
}
