import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { ambientRoot, loadSqlite, purgeAmbientAccount } from "../scripts/ambient.mjs";

// Purging an identity out of the shared ambient root.
//
// The command deletes credentials and must make no call to Google, so the
// failure modes worth a test are not crashes: they are a dry run that mutates
// anyway, a delete that takes the neighbouring accounts with it, a refusal that
// arrives after the deletion, and a token that reaches the terminal through the
// report. Every one of those looks like success from the outside.
const CLI = join(import.meta.dirname, "..", "index.js");
const DatabaseSync = loadSqlite();

const LEAKED = "leaked@example.com";
const KEEPER = "owner@example.com";
const REFRESH_TOKEN = "1//0g-SECRET-REFRESH-TOKEN-NEVER-PRINTED";
const ACCESS_TOKEN = "ya29.SECRET-ACCESS-TOKEN-NEVER-PRINTED";

const base = mkdtempSync(join(tmpdir(), "devo-ambient-"));
after(() => rmSync(base, { recursive: true, force: true }));

// The module resolves its own root, so a test that forgets to point it at a
// fixture does not fail: it reads the developer's real ~/.config/gcloud, finds
// no trace of the invented account, and passes for the wrong reason. That is
// how this suite first came to read live credentials. Pinning the variable
// before any test runs is what makes forgetting harmless.
process.env.DEVO_GCLOUD_AMBIENT_DIR = base;

let scenarios = 0;

/** A stand-in shared root, shaped the way gcloud leaves one behind. */
function scenario({ activeAccount = KEEPER, credentialRows = "attributable" } = {}) {
  const root = join(base, `root-${scenarios++}`);
  process.env.DEVO_GCLOUD_AMBIENT_DIR = root;

  mkdirSync(join(root, "configurations"), { recursive: true });
  writeFileSync(join(root, "active_config"), "ragusa\n");
  writeFileSync(
    join(root, "configurations", "config_ragusa"),
    `[core]\naccount = ${activeAccount}\nproject = example-project\n\n[run]\nregion = europe-west1\n`,
  );

  mkdirSync(join(root, "legacy_credentials", LEAKED), { recursive: true });
  writeFileSync(
    join(root, "legacy_credentials", LEAKED, "adc.json"),
    JSON.stringify({ client_id: "example.apps.googleusercontent.com", refresh_token: REFRESH_TOKEN }),
  );
  writeFileSync(
    join(root, "application_default_credentials.json"),
    JSON.stringify({ client_id: "example.apps.googleusercontent.com", refresh_token: REFRESH_TOKEN }),
  );

  const credentials = new DatabaseSync(join(root, "credentials.db"));
  if (credentialRows === "attributable") {
    credentials.exec("CREATE TABLE credentials (account_id TEXT PRIMARY KEY, value TEXT)");
    credentials.prepare("INSERT INTO credentials (account_id, value) VALUES (?, ?)").run(LEAKED, REFRESH_TOKEN);
    credentials.prepare("INSERT INTO credentials (account_id, value) VALUES (?, ?)").run(KEEPER, "1//other");
  } else {
    // Rows that cannot be attributed to an account: the purge must refuse
    // rather than guess which ones belong to the identity being removed.
    credentials.exec("CREATE TABLE credentials (email TEXT PRIMARY KEY, blob TEXT)");
    credentials.prepare("INSERT INTO credentials (email, blob) VALUES (?, ?)").run(LEAKED, REFRESH_TOKEN);
  }
  credentials.close();

  const tokens = new DatabaseSync(join(root, "access_tokens.db"));
  tokens.exec("CREATE TABLE access_tokens (account_id TEXT PRIMARY KEY, access_token TEXT, token_expiry TIMESTAMP)");
  tokens
    .prepare("INSERT INTO access_tokens (account_id, access_token, token_expiry) VALUES (?, ?, ?)")
    .run(LEAKED, ACCESS_TOKEN, "2026-09-21T00:00:00Z");
  tokens.close();

  const configs = new DatabaseSync(join(root, "ragusa_configs.db"));
  configs.exec("CREATE TABLE config (section TEXT, property TEXT, value TEXT)");
  configs.prepare("INSERT INTO config (section, property, value) VALUES (?, ?, ?)").run("core", "account", LEAKED);
  configs.close();

  return root;
}

function count(path, sql, params = []) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return Number(db.prepare(sql).get(...params).n);
  } finally {
    db.close();
  }
}

function rowsFor(root, table, account) {
  return count(
    join(root, `${table}.db`),
    `SELECT count(*) AS n FROM ${table} WHERE account_id = ?`,
    [account],
  );
}

function run(root, args) {
  return spawnSync("node", [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, DEVO_GCLOUD_AMBIENT_DIR: root },
  });
}

test("a dry run reports what it would remove and removes nothing", () => {
  const root = scenario();

  const report = purgeAmbientAccount({ account: LEAKED, apply: false });

  assert.equal(ambientRoot(), root, "the fixture must be the root under test");
  assert.equal(report.clean, false);
  assert.equal(report.legacy.exists, true);
  assert.equal(report.stores.find((store) => store.file === "credentials.db").rows, 1);
  assert.equal(report.stores.find((store) => store.file === "access_tokens.db").rows, 1);
  assert.equal(report.adc.exists, true, "the ADC file is part of the picture");
  assert.equal(report.configs.length, 1, "the configuration store still names the account");
  assert.equal(report.removed, null);

  assert.equal(existsSync(join(root, "legacy_credentials", LEAKED)), true, "a dry run must not delete");
  assert.equal(rowsFor(root, "credentials", LEAKED), 1);
  assert.equal(rowsFor(root, "access_tokens", LEAKED), 1);
});

test("the report never carries a token value", () => {
  const root = scenario();

  const report = purgeAmbientAccount({ account: LEAKED, apply: false });
  const serialized = JSON.stringify(report);

  assert.doesNotMatch(serialized, /SECRET-REFRESH-TOKEN/);
  assert.doesNotMatch(serialized, /SECRET-ACCESS-TOKEN/);

  // The printer is a second chance to leak one, so it is checked too.
  const result = run(root, ["auth", "purge", LEAKED]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Dry run: nothing was changed/);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /SECRET-(REFRESH|ACCESS)-TOKEN/);
});

test("applying removes the account and leaves the others in place", () => {
  const root = scenario();

  const report = purgeAmbientAccount({ account: LEAKED, apply: true });

  assert.equal(report.clean, false, "clean describes the state as found, which was not clean");
  assert.equal(report.finalClean, true);
  assert.equal(report.legacy.exists, false);
  assert.deepEqual(report.removed.stores, [
    { file: "credentials.db", rows: 1 },
    { file: "access_tokens.db", rows: 1 },
  ]);
  assert.equal(report.removed.legacy, true);

  assert.equal(existsSync(join(root, "legacy_credentials", LEAKED)), false);
  assert.equal(rowsFor(root, "credentials", LEAKED), 0);
  assert.equal(rowsFor(root, "access_tokens", LEAKED), 0);

  assert.equal(rowsFor(root, "credentials", KEEPER), 1, "the neighbour account stays");
  assert.equal(
    existsSync(join(root, "application_default_credentials.json")),
    true,
    "the ADC file is neither read nor deleted",
  );
  assert.equal(
    existsSync(join(root, "configurations", "config_ragusa")),
    true,
    "configurations are not rewritten",
  );
});

test("an applied purge does not also claim there was nothing to purge", () => {
  const root = scenario();

  const result = run(root, ["auth", "purge", LEAKED, "--yes"]);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Removed from the root for this identity:/);
  assert.match(result.stdout, /credentials\.db: 1 row\(s\)/);
  assert.match(result.stdout, /now holds nothing for this identity/);
  // The first version of the printer read the post-purge state for the summary
  // and the pre-purge state for the action, so it printed "nothing to purge"
  // directly above "removed 2 rows". Neither assertion below was in the suite.
  assert.doesNotMatch(result.stdout, /Nothing to purge/);
  assert.equal(existsSync(join(root, "legacy_credentials", LEAKED)), false);
});

test("refuses to purge the account the root is authenticating as", () => {
  const root = scenario({ activeAccount: LEAKED });

  const report = purgeAmbientAccount({ account: LEAKED, apply: true });

  assert.equal(report.blockers.length, 1);
  assert.match(report.blockers[0], /already authenticates as/);
  assert.equal(
    existsSync(join(root, "legacy_credentials", LEAKED)),
    true,
    "a refusal must land before any delete",
  );
  assert.equal(rowsFor(root, "credentials", LEAKED), 1);

  const result = run(root, ["auth", "purge", LEAKED, "--yes"]);
  assert.equal(result.status, 1, "a refusal must fail closed");
  assert.match(result.stdout, /Refused:/);
});

test("refuses to guess which rows belong to an identity", () => {
  const root = scenario({ credentialRows: "unattributable" });

  const report = purgeAmbientAccount({ account: LEAKED, apply: true });

  assert.match(report.blockers.join(" "), /no account column/);
  assert.equal(count(join(root, "credentials.db"), "SELECT count(*) AS n FROM credentials"), 1);
});

test("refuses an account that is not an address, so it cannot climb out of the root", () => {
  scenario();

  assert.throws(() => purgeAmbientAccount({ account: "../../etc/passwd" }), /Not an account address/);
  assert.throws(() => purgeAmbientAccount({}), /Missing account/);

  const result = run(base, ["auth", "purge", "../evil"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Not an account address/);
});

test("refuses --profile: a profile root is not this command's scope", () => {
  const root = scenario();

  const result = run(root, ["auth", "purge", "--profile", "credilex", LEAKED]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /takes no --profile/);
  assert.equal(existsSync(join(root, "legacy_credentials", LEAKED)), true);
});

test("reports a clean root instead of inventing work", () => {
  const root = scenario();
  purgeAmbientAccount({ account: LEAKED, apply: true });

  const result = run(root, ["auth", "purge", LEAKED]);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Nothing to purge/);
});
