import { spawnSync } from "child_process";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

/**
 * One gcloud at a time per profile, on the gcloud already installed here.
 *
 * The credential store is SQLite. Two gcloud processes writing it at once can
 * leave it unreadable, which looks like a dead login. The lock is what makes
 * that overlap impossible. The access token still refreshes on its own from the
 * stored refresh token; this module does not renew a refresh token Google has
 * rejected. Which profile is in use is `CLOUDSDK_CONFIG`, set to that profile's
 * own directory.
 */

const POLL_MS = 200;
const YOUNG_LOCK_MS = 1000;

const depth = new Map();

export class ProfileBusyError extends Error {
  constructor(name, holder) {
    super(
      `Profile ${name} already has gcloud running (pid ${holder}). A second one would share its credential store, so this call was not started.`,
    );
    this.name = "ProfileBusyError";
  }
}

export function lockDirectory() {
  if (process.env.DEVO_GCLOUD_LOCK_DIR) return process.env.DEVO_GCLOUD_LOCK_DIR;
  return join(process.env.HOME || homedir(), ".devo", "locks");
}

function lockWaitMs() {
  const raw = process.env.DEVO_GCLOUD_LOCK_WAIT_MS;
  if (raw === undefined || raw === "") return 120000;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`DEVO_GCLOUD_LOCK_WAIT_MS must be a non-negative number of milliseconds, not ${raw}.`);
  }
  return parsed;
}

function lockPath(name) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
    throw new Error(`Profile name ${name} cannot be used as a lock.`);
  }
  return join(lockDirectory(), `${name}.lock`);
}

function readHolder(dir) {
  try {
    const pid = Number(readFileSync(join(dir, "pid"), "utf8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function stale(dir, holder) {
  if (holder !== null) return !alive(holder);
  try {
    return Date.now() - statSync(dir).mtimeMs > YOUNG_LOCK_MS;
  } catch {
    return true;
  }
}

function sleep(ms) {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function releaseProfileLock(dir) {
  try {
    if (readHolder(dir) === process.pid) rmSync(dir, { recursive: true, force: true });
  } catch {
    // The holder already left. The next acquire treats a dead pid as free.
  }
}

/** Exclusive ownership of `name` until the returned function runs. */
export function acquireProfileLock(name) {
  const dir = lockPath(name);
  mkdirSync(lockDirectory(), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + lockWaitMs();

  for (;;) {
    try {
      mkdirSync(dir, { mode: 0o700 });
      writeFileSync(join(dir, "pid"), `${process.pid}\n`, { mode: 0o600 });
      return () => releaseProfileLock(dir);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const holder = readHolder(dir);
      if (stale(dir, holder)) {
        rmSync(dir, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) throw new ProfileBusyError(name, holder ?? "unknown");
      sleep(Math.min(POLL_MS, Math.max(deadline - Date.now(), 1)));
    }
  }
}

export function withProfileLock(name, fn) {
  const current = depth.get(name) || 0;
  if (current > 0) {
    depth.set(name, current + 1);
    try {
      return fn();
    } finally {
      depth.set(name, current);
    }
  }

  const release = acquireProfileLock(name);
  depth.set(name, 1);
  try {
    return fn();
  } finally {
    depth.delete(name);
    release();
  }
}

/**
 * Run gcloud for one profile. The lock is held for the whole process, including
 * a repair, and the child is the gcloud on this machine with `CLOUDSDK_CONFIG`
 * set to the profile root.
 */
export function spawnIsolatedGcloud(profile, args, options = {}) {
  return withProfileLock(profile.name, () => {
    const spawnOptions = {
      env: { ...process.env, CLOUDSDK_CONFIG: profile.root },
    };
    if (options.encoding) spawnOptions.encoding = options.encoding;
    if (options.timeout) spawnOptions.timeout = options.timeout;
    if (options.maxBuffer) spawnOptions.maxBuffer = options.maxBuffer;
    if (options.stdio) spawnOptions.stdio = options.stdio;
    return spawnSync("gcloud", args, spawnOptions);
  });
}
