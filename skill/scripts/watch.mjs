import { spawnSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";

/**
 * The hourly credential watchdog.
 *
 * It is a detector, not a keep-alive: a gcloud refresh token is not expired by
 * short inactivity, so polling cannot stop it from dying. What the poll buys is
 * finding out within the hour instead of in the middle of a task, and the JSONL
 * history it writes shows whether failures arrive on a fixed interval, which is
 * what separates an admin session-length policy from a one-off.
 */
export const WATCH_LABEL = "com.zencrust.devo-auth-status";
export const WATCH_INTERVAL_SECONDS = 3600;

function home() {
  return process.env.HOME || "";
}

export function launchAgentsDir() {
  return join(home(), "Library", "LaunchAgents");
}

export function plistPath() {
  return join(launchAgentsDir(), `${WATCH_LABEL}.plist`);
}

export function logPath() {
  return join(home(), "Library", "Logs", "devo-auth-status.log");
}

export function historyDir() {
  return join(home(), ".devo", "auth-status");
}

/**
 * One file per profile, with the path derived from the profile -- the same rule
 * CLOUDSDK_CONFIG follows.
 *
 * The history used to be a single global JSONL for every identity, which is the
 * mistake the isolated roots exist to remove: two devo processes working on two
 * profiles held the same path. Append-only made that survivable rather than
 * fatal -- measured on this filesystem, 200 concurrent appends produced 200
 * intact lines -- but survivable is not isolated, and the file could not answer
 * the question the history is kept for at all: which identity was a run about.
 */
export function historyPath(profileName) {
  if (!profileName) {
    // Without the check this returns `undefined.jsonl`: a record that is written,
    // read back as a profile called "undefined", and never counted against the
    // identity it was about. Fail where the caller can see it instead.
    throw new Error("historyPath needs a profile name: the record path is per profile");
  }
  return join(historyDir(), `${profileName}.jsonl`);
}

/** The profile whose records predate the split, kept so nothing is lost silently. */
export function legacyHistoryPath() {
  return join(home(), ".devo", "auth-status.jsonl");
}

export function historyProfiles() {
  try {
    return readdirSync(historyDir())
      .filter((entry) => entry.endsWith(".jsonl"))
      .map((entry) => entry.slice(0, -".jsonl".length))
      .sort();
  } catch {
    return [];
  }
}

/** Every profile's records, oldest first. */
export function readHistory({ limit = 500 } = {}) {
  const records = [];

  for (const profile of historyProfiles()) {
    for (const line of readFileSync(historyPath(profile), "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line));
      } catch {
        // One torn line is dropped rather than fatal: the history is a
        // diagnostic, and a single bad line must not hide the rest of it.
      }
    }
  }

  return records.sort((a, b) => String(a.at).localeCompare(String(b.at))).slice(-limit);
}

function xmlEscape(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * launchd starts a job with a minimal PATH, where neither node nor gcloud
 * resolve. The job therefore runs through a login zsh, which reads ~/.zshenv and
 * picks up nvm and /usr/local/bin. It invokes the devo wrapper rather than a
 * baked node path, so switching node versions does not break the agent.
 */
export function renderPlist({ intervalSeconds = WATCH_INTERVAL_SECONDS } = {}) {
  const invocation = `exec ${join(home(), ".local", "bin", "devo")} auth status --record --notify`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${WATCH_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>-lc</string>
    <string>${xmlEscape(invocation)}</string>
  </array>
  <key>StartInterval</key>
  <integer>${intervalSeconds}</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xmlEscape(logPath())}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(logPath())}</string>
</dict>
</plist>
`;
}

function domainTarget() {
  const uid = typeof process.getuid === "function" ? process.getuid() : "";
  return `gui/${uid}`;
}

function launchctl(args) {
  const result = spawnSync("launchctl", args, { encoding: "utf8" });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: (result.stdout || "").trim(),
    stderr: (result.stderr || "").trim(),
  };
}

/** Loads the job. An already-loaded job is removed first, so a new interval applies. */
function bootstrap() {
  launchctl(["bootout", `${domainTarget()}/${WATCH_LABEL}`]);
  const result = launchctl(["bootstrap", domainTarget(), plistPath()]);
  if (!result.ok) {
    return { ok: false, error: result.stderr || `launchctl bootstrap exited ${result.status}` };
  }
  return { ok: true, error: "" };
}

export function installWatch({ intervalSeconds = WATCH_INTERVAL_SECONDS } = {}) {
  mkdirSync(launchAgentsDir(), { recursive: true });
  mkdirSync(dirname(logPath()), { recursive: true });
  mkdirSync(historyDir(), { recursive: true });
  writeFileSync(plistPath(), renderPlist({ intervalSeconds }), "utf8");

  const loaded = bootstrap();
  return {
    plist: plistPath(),
    log: logPath(),
    history: historyDir(),
    intervalSeconds,
    loaded: loaded.ok,
    error: loaded.error,
  };
}

export function uninstallWatch() {
  const booted = launchctl(["bootout", `${domainTarget()}/${WATCH_LABEL}`]);
  const existed = existsSync(plistPath());
  if (existed) rmSync(plistPath());

  return {
    plist: plistPath(),
    removed: existed,
    // A job that was not loaded cannot be booted out; that is not a failure.
    unloaded: booted.ok,
    note: booted.ok || !existed ? "" : booted.stderr,
  };
}

function readIntervalSeconds() {
  if (!existsSync(plistPath())) return null;
  const match = readFileSync(plistPath(), "utf8").match(
    /<key>StartInterval<\/key>\s*<integer>(\d+)<\/integer>/,
  );
  return match ? Number(match[1]) : null;
}

function tailLines(path, count) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").trimEnd().split("\n").slice(-count);
}

export function watchStatus() {
  const plist = plistPath();
  const exists = existsSync(plist);
  if (!exists) {
    return { installed: false, loaded: false, plist, log: logPath(), history: historyDir() };
  }

  const printed = launchctl(["print", `${domainTarget()}/${WATCH_LABEL}`]);
  const records = readHistory();
  const failures = records.filter((record) => record.ok !== true);
  const legacy = existsSync(legacyHistoryPath()) ? tailLines(legacyHistoryPath(), 500).length : 0;

  return {
    installed: true,
    loaded: printed.ok,
    plist,
    log: logPath(),
    history: historyDir(),
    intervalSeconds: readIntervalSeconds(),
    runs: records.length,
    failures: failures.length,
    lastRun: records.at(-1) || null,
    lastFailure: failures.at(-1) || null,
    // A count that silently dropped would read as "the failures went away".
    legacyRecords: legacy,
    legacyHistory: legacyHistoryPath(),
    logTail: tailLines(logPath(), 5),
  };
}
