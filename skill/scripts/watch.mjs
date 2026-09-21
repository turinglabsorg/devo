import { spawnSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
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

export function historyPath() {
  return join(home(), ".devo", "auth-status.jsonl");
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
  mkdirSync(dirname(historyPath()), { recursive: true });
  writeFileSync(plistPath(), renderPlist({ intervalSeconds }), "utf8");

  const loaded = bootstrap();
  return {
    plist: plistPath(),
    log: logPath(),
    history: historyPath(),
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
    return { installed: false, loaded: false, plist, log: logPath(), history: historyPath() };
  }

  const printed = launchctl(["print", `${domainTarget()}/${WATCH_LABEL}`]);
  const runs = tailLines(historyPath(), 200)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  const failures = runs.filter((run) => run.results?.some((result) => !result.ok));

  return {
    installed: true,
    loaded: printed.ok,
    plist,
    log: logPath(),
    history: historyPath(),
    intervalSeconds: readIntervalSeconds(),
    runs: runs.length,
    failures: failures.length,
    lastRun: runs.at(-1) || null,
    lastFailure: failures.at(-1) || null,
    logTail: tailLines(logPath(), 5),
  };
}
