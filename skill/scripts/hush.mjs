import { spawnSync } from "child_process";

/**
 * The names hush holds. Never a value.
 *
 * `hush list` is the only read this module makes, and it is a read of names by
 * construction: hush has no command that prints a secret -- `list` and `info`
 * answer with metadata, and the value reaches a process only through `hush run`,
 * which injects it into that process's environment. That is why a key can be
 * *used* from here without ever passing through this agent.
 */
const HUSH_TIMEOUT_MS = Number(process.env.DEVO_HUSH_TIMEOUT_MS || 20000);

export function hushBin() {
  return process.env.DEVO_HUSH_BIN || "hush";
}

export function hushNames() {
  const bin = hushBin();
  const result = spawnSync(bin, ["list", "--json"], {
    encoding: "utf8",
    timeout: HUSH_TIMEOUT_MS,
    maxBuffer: 8 * 1024 * 1024,
  });

  if (result.error) {
    return {
      ok: false,
      names: [],
      error:
        result.error.code === "ENOENT"
          ? `hush is not installed (${bin})`
          : `hush could not be started: ${result.error.message}`,
    };
  }

  if (result.status !== 0) {
    return {
      ok: false,
      names: [],
      error: (result.stderr || "").trim() || `hush list exited ${result.status}`,
    };
  }

  try {
    const parsed = JSON.parse(result.stdout);
    const secrets = Array.isArray(parsed?.secrets) ? parsed.secrets : [];
    return { ok: true, names: secrets.map((secret) => secret?.name).filter((name) => typeof name === "string" && name), error: "" };
  } catch {
    return { ok: false, names: [], error: "hush list did not return the JSON this expects" };
  }
}

/**
 * Whether a name is in the vault -- as three answers, not two.
 *
 * `present: null` means the vault could not be asked, and it is deliberately not
 * `false`: an uninitialized, locked or missing hush must never read as an absent
 * key, or a caller would start creating a second credential over one that is
 * already there, and the new key would be the one nobody knows about. It is the
 * same distinction the profile probe draws between a dead token and a timeout.
 */
export function secretPresence(name) {
  if (!name) return { present: null, error: "no secret name to look for" };

  const lookup = hushNames();
  if (!lookup.ok) return { present: null, error: lookup.error };
  return { present: lookup.names.includes(name), error: "" };
}
