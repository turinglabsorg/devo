import { spawnSync } from "child_process";
import { existsSync, readFileSync, readdirSync } from "fs";
import { join, resolve } from "path";

/**
 * Registry of the isolated gcloud identity roots.
 *
 * This workstation keeps one CLOUDSDK_CONFIG directory per identity instead of
 * named configurations inside a shared root. A process that forgets the prefix
 * does not fail: it silently uses the shared global config and the wrong
 * identity, which is how a Credilex call once ended up authenticated as an
 * unrelated account. Every gcloud invocation must therefore be derived from
 * this registry, never from the ambient environment.
 *
 * Adding a profile here is not optional decoration: the project guard, the
 * health probe and the repair command are all computed from these fields.
 */
export const PROFILE_DEFINITIONS = {
  master: {
    label: "PrismaNews and general GCP operations",
    account: "sebastiano.cataudo@gmail.com",
    healthProject: "calcium-alchemy-400213",
    projectPatterns: [],
  },
  nobrainer: {
    label: "Nobrainer identity",
    account: "seer@nobraineragency.com",
    healthProject: null,
    projectPatterns: [],
  },
  credilex: {
    label: "Credilex GCP (gstaging, gprod)",
    account: "seba@credilex.it",
    healthProject: "credilex-gstaging",
    projectPatterns: ["credilex-*", "linear-analyst-*"],
  },
};

export const PROFILE_FIELD = "gcloudProfile";
export const LEGACY_PROFILE_FIELD = "gcloudConfiguration";
/** The legacy field names a configuration inside a shared root, not an isolated root. */
export const LEGACY_FIELD_NOTE =
  "it names a configuration inside the shared global root, not an isolated identity root";

export function gcloudProfilesDir() {
  return resolve(
    process.env.DEVO_GCLOUD_PROFILES_DIR ||
      join(process.env.HOME || "", ".config", "gcloud-profiles"),
  );
}

export function profileRoot(name) {
  return join(gcloudProfilesDir(), name);
}

function rootsOnDisk() {
  try {
    return readdirSync(gcloudProfilesDir(), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

export function listProfiles() {
  const declared = Object.entries(PROFILE_DEFINITIONS).map(([name, definition]) => ({
    name,
    ...definition,
    root: profileRoot(name),
    declared: true,
    rootExists: existsSync(profileRoot(name)),
  }));

  const undeclared = rootsOnDisk()
    .filter((name) => !PROFILE_DEFINITIONS[name])
    .map((name) => ({
      name,
      label: "undeclared: no project guard, no health probe",
      account: null,
      healthProject: null,
      projectPatterns: [],
      root: profileRoot(name),
      declared: false,
      rootExists: true,
    }));

  return [...declared, ...undeclared];
}

export function findProfile(name) {
  return listProfiles().find((profile) => profile.name === name) || null;
}

/**
 * Fail closed: an omitted profile is an error, never a fallback to the shared
 * global config. This is the whole point of the guard.
 */
export function requireProfile(name) {
  if (!name) {
    throw new Error(
      `Missing --profile. Refusing to guess: a gcloud call without an explicit profile silently uses the shared global config. Known profiles: ${listProfiles()
        .map((profile) => profile.name)
        .join(", ")}`,
    );
  }

  const profile = findProfile(name);
  if (!profile) {
    throw new Error(
      `Unknown profile: ${name}. Known profiles: ${listProfiles()
        .map((candidate) => candidate.name)
        .join(", ")}`,
    );
  }

  if (!profile.rootExists) {
    throw new Error(
      `Profile ${name} has no configuration root at ${profile.root}. Create it with:\n  ${repairCommand(name)}`,
    );
  }

  return profile;
}

function matchesPattern(pattern, value) {
  if (pattern === "*") return true;
  if (pattern.endsWith("*")) return value.startsWith(pattern.slice(0, -1));
  return pattern === value;
}

/**
 * A project that belongs to another profile's scope must not be reachable with
 * this identity, even when this profile declares no patterns of its own.
 */
export function assertProjectAllowed(profile, projectId) {
  if (!projectId) return;

  const foreignOwner = listProfiles().find(
    (candidate) =>
      candidate.name !== profile.name &&
      (candidate.projectPatterns || []).some((pattern) => matchesPattern(pattern, projectId)),
  );
  if (foreignOwner) {
    throw new Error(
      `Project ${projectId} belongs to profile ${foreignOwner.name} (${foreignOwner.label}); refusing to use profile ${profile.name}.`,
    );
  }

  const patterns = profile.projectPatterns || [];
  if (patterns.length && !patterns.some((pattern) => matchesPattern(pattern, projectId))) {
    throw new Error(
      `Project ${projectId} is outside the scope of profile ${profile.name} (${patterns.join(", ")}).`,
    );
  }
}

export function profileEnv(profile) {
  return { ...process.env, CLOUDSDK_CONFIG: profile.root };
}

export function repairCommand(name) {
  const profile = findProfile(name);
  const account = profile?.account || "<account>";
  return `CLOUDSDK_CONFIG=${profileRoot(name)} gcloud auth login ${account}`;
}

/**
 * gcloud is slow from a cold start, so the probe gets a generous budget: a
 * killed probe would otherwise be reported as a credential failure, which is a
 * false signal of the same family as the one this registry exists to remove.
 */
const PROBE_TIMEOUT_MS = Number(process.env.DEVO_GCLOUD_PROBE_TIMEOUT_MS || 60000);

function gcloudIn(profile, args) {
  const result = spawnSync("gcloud", args, {
    env: profileEnv(profile),
    encoding: "utf8",
    timeout: PROBE_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
  });

  return {
    status: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    timedOut: result.error?.code === "ETIMEDOUT",
    missing: result.error?.code === "ENOENT",
    spawnError: result.error?.message || "",
  };
}

/**
 * The account a call in this root will use, read from the root's own config
 * file rather than by asking gcloud.
 *
 * Asking gcloud costs a full process start -- about as much as the call being
 * guarded -- and the answer sits in a plain INI file. The guard is a drift
 * detector, not an authentication check, so an absent value is not a failure.
 *
 * Takes a root rather than a profile, because the ambient shared root has to be
 * read the same way: purging an identity out of it is only safe once we know
 * which account that root authenticates as.
 */
export function accountInRoot(root) {
  let configuration = "default";
  try {
    configuration = readFileSync(join(root, "active_config"), "utf8").trim() || "default";
  } catch {
    // No active_config file: the default configuration is the one in use.
  }

  try {
    const text = readFileSync(join(root, "configurations", `config_${configuration}`), "utf8");
    const core = text.split(/^\[/m).find((chunk) => chunk.startsWith("core]")) || text;
    const match = core.match(/^\s*account\s*=\s*(.+)$/m);
    return { ok: true, configuration, account: match ? match[1].trim() : "" };
  } catch {
    return { ok: false, configuration, account: "" };
  }
}

export function selectedAccountOf(profile) {
  return accountInRoot(profile.root);
}

const STALE_TOKEN = /Reauthentication failed|Please run:\s*\n?\s*\$? ?gcloud auth login/i;

export function isStaleToken(text) {
  return STALE_TOKEN.test(String(text || ""));
}

/**
 * A read-only API call is the only honest way to know whether the stored
 * refresh token still works; `auth list` answers from the local store and
 * reports green on a dead token.
 */
export function probeProfile(profile) {
  if (!profile.declared) {
    return {
      name: profile.name,
      ok: null,
      skipped: true,
      summary: "undeclared profile: declare it in the devo registry to enable the probe",
    };
  }

  if (!profile.healthProject) {
    return {
      name: profile.name,
      ok: null,
      skipped: true,
      summary: "no health project configured",
    };
  }

  const probeArgs = [
    "--account",
    profile.account,
    "--project",
    profile.healthProject,
    "projects",
    "describe",
    profile.healthProject,
    "--format=value(projectId)",
  ];

  let result = gcloudIn(profile, probeArgs);
  let attempts = 1;

  // A timeout is a stalled start or a stalled request, not a verdict on the
  // token. Retrying once turns most of those into a real answer, so a timeout
  // reaches the record only when the profile failed to answer twice.
  if (result.timedOut) {
    result = gcloudIn(profile, probeArgs);
    attempts = 2;
  }

  if (result.status === 0) {
    return {
      name: profile.name,
      ok: true,
      skipped: false,
      summary: `${profile.account} -> ${profile.healthProject}`,
    };
  }

  if (result.missing) {
    return {
      name: profile.name,
      ok: false,
      skipped: true,
      summary: "gcloud not installed on this workstation",
      error: "",
    };
  }

  // A killed probe says nothing about the credential. Never dress it up as a
  // dead token: that would send the user to re-authenticate for nothing.
  if (result.timedOut) {
    return {
      name: profile.name,
      ok: false,
      skipped: false,
      timedOut: true,
      attempts,
      summary: `probe timed out twice, after ${Math.round(PROBE_TIMEOUT_MS / 1000)}s each: identity unknown, not necessarily broken`,
      error: `gcloud did not answer in time (${PROBE_TIMEOUT_MS}ms) on either attempt. Re-run, or raise DEVO_GCLOUD_PROBE_TIMEOUT_MS.`,
    };
  }

  const stderr = (result.stderr || "").trim();
  const stale = isStaleToken(stderr);

  return {
    name: profile.name,
    ok: false,
    skipped: false,
    stale,
    summary: stale ? `stale credentials for ${profile.account}` : `probe failed for ${profile.healthProject}`,
    error: stale
      ? `the stored refresh token for ${profile.account} is no longer accepted by Google`
      : stderr.split("\n").slice(-2).join(" ").slice(0, 300) || result.spawnError || "no output from gcloud",
    repair: repairCommand(profile.name),
  };
}
