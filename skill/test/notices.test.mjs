import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { clearNotice, noticePath, pendingNotices, raiseNotice, readNotice } from "../scripts/watch.mjs";

// A dead credential has to reach a human without depending on the desktop.
//
// The desktop notice is best effort and its failure is silent: macOS Focus
// suppresses the banner while osascript still exits 0, and the old code read
// nothing back from the spawn at all. A profile died in the small hours and was
// found by hand, mid-task, hours later, with three failures already in a log
// nobody had opened. These cases pin the half that cannot be suppressed -- the
// marker on disk and the command that prints it.
const CLI = join(import.meta.dirname, "..", "index.js");

const root = mkdtempSync(join(tmpdir(), "devo-notices-"));
after(() => rmSync(root, { recursive: true, force: true }));

/**
 * A gcloud that answers only for the accounts named in DEVO_TEST_OK_ACCOUNTS,
 * and refuses the rest the way a dead refresh token does. Pure shell, no
 * external tool: this machine's `grep` is not the one a stub would expect.
 */
const bin = join(root, "bin");
mkdirSync(bin, { recursive: true });
writeFileSync(
  join(bin, "gcloud"),
  `#!/bin/sh
if [ -n "$DEVO_TEST_OK_ACCOUNTS" ]; then
  for argument in "$@"; do
    for allowed in $DEVO_TEST_OK_ACCOUNTS; do
      if [ "$argument" = "$allowed" ]; then
        echo "$argument"
        exit 0
      fi
    done
  done
fi
echo 'Reauthentication failed. Please run: gcloud auth login' >&2
exit 1
`,
);
chmodSync(join(bin, "gcloud"), 0o755);

/** A desktop that refuses the notice, which is what a notice that failed looks like. */
const mutedBin = join(root, "muted-bin");
mkdirSync(mutedBin, { recursive: true });
writeFileSync(join(mutedBin, "osascript"), "#!/bin/sh\necho 'not authorized to send Apple events' >&2\nexit 1\n");
chmodSync(join(mutedBin, "osascript"), 0o755);

const ACCOUNTS = { master: "sebastiano.cataudo@gmail.com", acme: "human@acme.example" };

function scenario(name) {
  const home = join(root, name, "home");
  const profiles = join(root, name, "profiles");
  mkdirSync(home, { recursive: true });
  for (const profile of Object.keys(ACCOUNTS)) mkdirSync(join(profiles, profile), { recursive: true });
  // The second identity is declared here, not in the registry: the committed
  // registry carries generic identities only, and a profile that belongs to an
  // organisation is declared in the local file that sits next to its root.
  writeFileSync(
    join(profiles, "profiles.local.json"),
    JSON.stringify({
      acme: { account: ACCOUNTS.acme, healthProject: "acme-staging", projectPatterns: ["acme-*"] },
    }),
  );
  return { home, profiles };
}

function run(scn, args, { alive = [], muted = false } = {}) {
  return spawnSync("node", [CLI, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: scn.home,
      DEVO_GCLOUD_PROFILES_DIR: scn.profiles,
      DEVO_GCLOUD_LOCK_DIR: join(scn.home, "locks"),
      DEVO_TEST_OK_ACCOUNTS: alive.map((profile) => ACCOUNTS[profile]).join(" "),
      PATH: `${muted ? mutedBin : bin}:${process.env.PATH}`,
    },
  });
}

function alertFile(scn, profile) {
  return join(scn.home, ".devo", "auth-status", `${profile}.alert`);
}

test("a failing profile stands as an alert, with the repair it needs", () => {
  const scn = scenario("stand");
  assert.equal(run(scn, ["auth", "status", "--record"]).status, 1, "a dead profile must exit non-zero");

  for (const profile of Object.keys(ACCOUNTS)) {
    const standing = JSON.parse(readFileSync(alertFile(scn, profile), "utf8"));
    assert.equal(standing.profile, profile);
    assert.equal(standing.count, 1);
    assert.match(standing.summary, /stale credentials/);
    assert.match(standing.repair, new RegExp(`devo auth repair ${profile}`));
    assert.ok(standing.at, "the alert must carry the time it was raised");
  }
});

test("a quiet run on a healthy profile still reports the other one dead", () => {
  const scn = scenario("quiet");
  run(scn, ["auth", "status", "--record"]);

  // Nothing is wrong with acme, and the caller asked for silence -- which
  // must not be able to hide a credential that is dead. This is the run that
  // happens the next morning, before any work starts.
  const quiet = run(scn, ["auth", "status", "--profile", "acme", "--quiet"], { alive: ["acme"] });
  assert.equal(quiet.status, 0, "the profile that answers is not a failure");
  assert.match(quiet.stdout, /unacknowledged credential alert/);
  assert.match(quiet.stdout, /master: dead since/);
  assert.match(quiet.stdout, /devo auth repair master/);
});

test("an alert is cleared by a probe that answers, and only for that profile", () => {
  const scn = scenario("clear");
  run(scn, ["auth", "status", "--record"]);
  assert.ok(existsSync(alertFile(scn, "master")));

  run(scn, ["auth", "status", "--record"], { alive: ["master"] });
  assert.equal(existsSync(alertFile(scn, "master")), false, "a working profile must not keep an alert");
  assert.ok(existsSync(alertFile(scn, "acme")), "the other profile's alert must survive");
});

test("a desktop notice that was not delivered is reported, not swallowed", () => {
  const scn = scenario("muted");
  const muted = run(scn, ["auth", "status", "--record", "--notify"], { muted: true });

  assert.equal(muted.status, 1);
  assert.match(muted.stdout, /the desktop notice was not delivered/);
  assert.match(muted.stdout, /not authorized to send Apple events/);
  assert.ok(existsSync(alertFile(scn, "master")), "the alert must survive a notice that never arrived");
});

test("the json report carries both the standing alert and the delivery", () => {
  const scn = scenario("json");
  run(scn, ["auth", "status", "--record", "--notify"], { muted: true });

  const parsed = JSON.parse(run(scn, ["auth", "status", "--json", "--notify"], { muted: true }).stdout);
  assert.equal(parsed.delivery.delivered, false);
  assert.ok(parsed.delivery.error);
  assert.equal(parsed.pending.length, 2);
  assert.deepEqual(
    parsed.pending.map((notice) => notice.profile).sort(),
    ["acme", "master"],
  );
});

test("a standing alert keeps the first failure's time and counts the runs", () => {
  const scn = scenario("count");
  const previous = process.env.HOME;
  process.env.HOME = scn.home;
  try {
    const first = raiseNotice("master", { summary: "stale", repair: "devo auth repair master", at: "2026-09-22T03:44:19Z" });
    const second = raiseNotice("master", { summary: "stale", repair: "devo auth repair master", at: "2026-09-22T04:44:23Z" });

    assert.equal(first.count, 1);
    assert.equal(second.count, 2, "a standing alert must count the runs that failed");
    assert.equal(second.at, "2026-09-22T03:44:19Z", "moving `at` forward would answer 'an hour ago' forever");
    assert.equal(second.lastSeenAt, "2026-09-22T04:44:23Z");
    assert.throws(() => noticePath(), /needs a profile name/, "a nameless path would be `.alert`");
    assert.notEqual(noticePath("master"), noticePath("acme"));
    assert.equal(clearNotice("master"), true);
    assert.equal(readNotice("master"), null);
  } finally {
    process.env.HOME = previous;
  }
});

test("a marker torn mid-write is skipped, never fatal", () => {
  const scn = scenario("torn");
  const previous = process.env.HOME;
  process.env.HOME = scn.home;
  try {
    raiseNotice("master", { summary: "stale", at: "2026-09-22T03:44:19Z" });
    writeFileSync(join(scn.home, ".devo", "auth-status", "acme.alert"), '{"profile":"acm');

    const pending = pendingNotices();
    assert.equal(pending.length, 1, "one bad file must not hide the alerts that are intact");
    assert.equal(pending[0].profile, "master");
  } finally {
    process.env.HOME = previous;
  }
});
