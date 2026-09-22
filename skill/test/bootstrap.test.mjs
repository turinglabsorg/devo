import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { effectiveAccountOf, requireProfile } from "../scripts/profiles.mjs";

// The profile stops depending on a human credential.
//
// A user refresh token died twice in a week -- account-level revocation, not
// inactivity -- and no local call can prevent that. A service account key does
// not die. So the flow is: create the profile, look for the key in hush, use it
// if it is there, and say what to run if it is not.
//
// These cases pin the parts that carry a credential: the key reaches gcloud
// through a file that is deleted on every exit path, it never enters this
// process or its output, and a vault that cannot be read is never mistaken for
// an absent key -- because that reading is the one that creates a second key
// over the one already in place.
//
// Everything here is generic on purpose: an organisation's names live in the
// local declaration next to its root, not in the registry this repository ships.
const CLI = join(import.meta.dirname, "..", "index.js");

const FAKE_KEY = "FAKE-KEY-BODY-0123456789";
const HUMAN = "human@acme.example";
const SA_EMAIL = "devo-audit@acme-prod.iam.gserviceaccount.com";
const SA_KEY_NAME = "ACME_PROD_SA_KEY";
const SA_PROJECT = "acme-prod";

const root = mkdtempSync(join(tmpdir(), "devo-bootstrap-"));
after(() => rmSync(root, { recursive: true, force: true }));

const bin = join(root, "bin");
mkdirSync(bin, { recursive: true });

/**
 * A hush that injects a value the way the real one does: into the environment of
 * the command it starts, never onto its own output. `list` answers with names.
 */
writeFileSync(
  join(bin, "hush"),
  `#!/bin/sh
case "$1" in
  list)
    if [ -n "$DEVO_TEST_HUSH_LIST_FAIL" ]; then
      echo "$DEVO_TEST_HUSH_LIST_FAIL" >&2
      exit 1
    fi
    if [ -n "$DEVO_TEST_HUSH_ABSENT" ]; then
      echo '{"secrets":[{"name":"SOMETHING_ELSE"}]}'
    else
      echo '{"secrets":[{"name":"${SA_KEY_NAME}"},{"name":"OTHER"}]}'
    fi
    exit 0
    ;;
  run)
    var=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --env) var="$2"; shift 2 ;;
        --name) shift 2 ;;
        --redact) shift ;;
        --) shift; break ;;
        *) shift ;;
      esac
    done
    eval "$var='$FAKE_KEY'; export $var"
    exec "$@"
    ;;
esac
exit 1
`,
);
chmodSync(join(bin, "hush"), 0o755);

/**
 * A gcloud that writes down what it was called with. It records the size of the
 * key file because that is the one fact the real gcloud needs to be true: the
 * value arrived intact, and it arrived as a file rather than as an argument.
 */
writeFileSync(
  join(bin, "gcloud"),
  `#!/bin/sh
log="$DEVO_TEST_GCLOUD_LOG"
: > "$log"
keyfile=""
for argument in "$@"; do
  printf '%s\\n' "$argument" >> "$log"
  case "$argument" in
    --key-file=*) keyfile="\${argument#--key-file=}" ;;
  esac
done
if [ -n "$keyfile" ]; then
  if [ -f "$keyfile" ]; then
    printf 'keyfile-bytes=%s\\n' "$(wc -c < "$keyfile" | tr -d ' ')" >> "$log"
  else
    printf 'keyfile-missing\\n' >> "$log"
  fi
fi
printf 'cloudsdk-config=%s\\n' "$CLOUDSDK_CONFIG" >> "$log"
exit 0
`,
);
chmodSync(join(bin, "gcloud"), 0o755);

/**
 * The local declaration, the one the repository does not carry: the two
 * identities of this workstation, one of them with a service account to move
 * onto.
 */
const LOCAL_PROFILES = {
  acme: {
    account: HUMAN,
    healthProject: "acme-staging",
    projectPatterns: ["acme-*"],
    serviceAccount: { email: SA_EMAIL, keyName: SA_KEY_NAME, project: SA_PROJECT },
  },
  humanonly: {
    account: "someone@acme.example",
    healthProject: null,
    projectPatterns: [],
  },
};

function scenario(name) {
  const home = join(root, name, "home");
  const profiles = join(root, name, "profiles");
  const scratch = join(root, name, "tmp");
  const log = join(root, name, "gcloud.log");
  mkdirSync(home, { recursive: true });
  mkdirSync(scratch, { recursive: true });
  // `master` is declared in the committed registry, so its root is the one that
  // has to exist here too -- a local file adds identities, it does not replace
  // the ones the repository ships.
  for (const profile of [...Object.keys(LOCAL_PROFILES), "master"]) {
    mkdirSync(join(profiles, profile), { recursive: true });
  }
  writeFileSync(join(profiles, "profiles.local.json"), JSON.stringify(LOCAL_PROFILES));
  writeFileSync(log, "");
  return { name, home, profiles, scratch, log, root: join(profiles, "acme") };
}

function run(scn, args, env = {}) {
  return spawnSync("node", [CLI, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: scn.home,
      TMPDIR: scn.scratch,
      DEVO_GCLOUD_PROFILES_DIR: scn.profiles,
      DEVO_GCLOUD_LOCK_DIR: join(scn.home, "locks"),
      DEVO_HUSH_BIN: join(bin, "hush"),
      DEVO_TEST_GCLOUD_LOG: scn.log,
      DEVO_TEST_FAKE_KEY: FAKE_KEY,
      PATH: `${bin}:${process.env.PATH}`,
      ...env,
    },
  });
}

test("the key in hush is activated into the profile's own root", () => {
  const scn = scenario("present");
  const result = run(scn, ["auth", "bootstrap", "acme"]);

  assert.equal(result.status, 0, result.stderr);

  const log = readFileSync(scn.log, "utf8");
  assert.match(log, /^auth$/m, "the credential is activated");
  assert.match(log, /^activate-service-account$/m);
  assert.match(log, new RegExp(`^cloudsdk-config=${scn.profiles}/acme$`, "m"), "the activation must land in the profile root, never the shared one");
  assert.match(log, /^keyfile-bytes=\d+$/m);
  assert.doesNotMatch(log, /keyfile-missing/, "gcloud must find the key file it was pointed at");

  // The value travelled through hush's environment and into a file gcloud read;
  // it must not have travelled through this process, its arguments, or its
  // output. This is the assertion the whole module exists to keep true.
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(FAKE_KEY));
  assert.doesNotMatch(log, new RegExp(FAKE_KEY));
  assert.doesNotMatch(log, /--key-file=-/, "a key read from stdin is not a path gcloud can re-read");
});

test("the key file is gone once the activation is over", () => {
  const scn = scenario("trap");
  run(scn, ["auth", "bootstrap", "acme"]);

  // mktemp is pointed at this directory, so anything left behind is a key on
  // disk. `exec` in place of a plain call would have dropped the EXIT trap and
  // left exactly this.
  assert.deepEqual(readdirSync(scn.scratch), [], "the activation script must delete the key file on every exit path");
});

test("a key that is not in hush prints the sequence that creates it, and activates nothing", () => {
  const scn = scenario("absent");
  const result = run(scn, ["auth", "bootstrap", "acme"], { DEVO_TEST_HUSH_ABSENT: "1" });

  assert.equal(result.status, 1, "nothing was activated, so this is not a success");
  assert.match(result.stderr, /no service account key in hush yet/);
  assert.match(result.stderr, /iam service-accounts create devo-audit/);
  assert.match(result.stderr, new RegExp(`--project ${SA_PROJECT}`), "the account is created in the project its declaration names");
  assert.match(result.stderr, /roles\/viewer/);
  // The account lives in one project and the probe reads another, so one binding
  // would leave the profile reporting a permission error as a dead credential.
  assert.match(result.stderr, /--project acme-prod/, "the account's own project is read as this account");
  assert.match(result.stderr, /--project acme-staging/, "and so is the health project");
  assert.match(result.stderr, /iam\.disableServiceAccountKeyCreation/, "the check that can forbid keys outright has to be part of what it says");
  assert.match(result.stderr, new RegExp(SA_KEY_NAME), "the name the human has to store the key under");
  assert.equal(readFileSync(scn.log, "utf8"), "", "a missing key must not reach gcloud at all");
});

test("a vault that cannot be read is a refusal, never a missing key", () => {
  const scn = scenario("unreadable");
  const failing = run(scn, ["auth", "bootstrap", "acme"], { DEVO_TEST_HUSH_LIST_FAIL: "the vault is locked" });

  assert.equal(failing.status, 1);
  assert.match(failing.stderr, new RegExp(`could not tell whether ${SA_KEY_NAME} is in the vault`));
  assert.match(failing.stderr, /two credentials where the registry expects one/);
  assert.doesNotMatch(failing.stderr, /iam service-accounts create/, "an unreadable vault must not be answered by creating a second key");
  assert.equal(readFileSync(scn.log, "utf8"), "", "an unreadable vault must not reach gcloud");

  // The same refusal when hush is not installed at all: a missing tool is not
  // evidence that a secret is absent.
  const missing = run(scn, ["auth", "bootstrap", "acme"], { DEVO_HUSH_BIN: join(bin, "no-such-hush") });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /hush is not installed/);
  assert.doesNotMatch(missing.stderr, /iam service-accounts create/);
});

test("a profile with no service account has no non-interactive form to fall back on", () => {
  const scn = scenario("human");
  const result = run(scn, ["auth", "bootstrap", "humanonly"]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /declares no serviceAccount/);
  assert.equal(readFileSync(scn.log, "utf8"), "");
});

/**
 * Which account a call will use, read from the root rather than from a flag, so
 * declaring a service account cannot break a profile that has not been
 * bootstrapped yet.
 */
test("the effective account follows the root, not the declaration", () => {
  const scn = scenario("effective");
  const previous = process.env.DEVO_GCLOUD_PROFILES_DIR;
  process.env.DEVO_GCLOUD_PROFILES_DIR = scn.profiles;
  try {
    const profile = requireProfile("acme");
    mkdirSync(join(profile.root, "configurations"), { recursive: true });
    writeFileSync(join(profile.root, "active_config"), "default\n");

    const configure = (account) =>
      writeFileSync(join(profile.root, "configurations", "config_default"), `[core]\naccount = ${account}\n`);

    configure(HUMAN);
    assert.equal(effectiveAccountOf(profile), HUMAN, "before the bootstrap the human is the identity");

    configure(SA_EMAIL);
    assert.equal(effectiveAccountOf(profile), SA_EMAIL, "after it, the profile calls as the service account");

    // Neither of the two: a root holding some third identity is not quietly
    // accepted as either one.
    configure("someone@else.example");
    assert.equal(effectiveAccountOf(profile), HUMAN);
  } finally {
    process.env.DEVO_GCLOUD_PROFILES_DIR = previous;
  }
});

/**
 * A local entry is merged onto the registry's own shape, not swapped for it: it
 * may say what it knows and must leave alone what it does not, or a file added
 * for one field would silently drop a profile's account.
 */
test("a local declaration merges onto the committed one", () => {
  const scn = scenario("merge");
  const previous = process.env.DEVO_GCLOUD_PROFILES_DIR;
  process.env.DEVO_GCLOUD_PROFILES_DIR = scn.profiles;
  try {
    writeFileSync(join(scn.profiles, "profiles.local.json"), JSON.stringify({ master: { healthProject: "example-staging" } }));

    const master = requireProfile("master");
    assert.equal(master.healthProject, "example-staging", "a local entry may override a field it names");
    assert.ok(master.account, "and must not be read as dropping the fields it does not name");
    assert.equal(master.declared, true);
  } finally {
    process.env.DEVO_GCLOUD_PROFILES_DIR = previous;
  }
});
