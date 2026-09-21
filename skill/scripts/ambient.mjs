import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

import { accountInRoot } from "./profiles.mjs";

/**
 * Removing an identity from the shared ambient root.
 *
 * `gcloud auth login` without CLOUDSDK_CONFIG writes into ~/.config/gcloud --
 * the root every unprefixed call falls back to -- and that is how a Credilex
 * identity came to sit there next to four unrelated accounts. The obvious
 * remedy, `gcloud auth revoke`, is the wrong one: it asks Google to invalidate
 * the refresh token, which would also break the isolated profile that holds the
 * same identity legitimately. This removes the local copy and stops.
 *
 * The no-network guarantee is structural rather than a promise: this module
 * imports nothing that can reach gcloud or the network. Read it and see.
 */

export function ambientRoot() {
  return resolve(
    process.env.DEVO_GCLOUD_AMBIENT_DIR || join(process.env.HOME || "", ".config", "gcloud"),
  );
}

/**
 * The stores gcloud keeps credential material in, and the table each one uses.
 * Both are keyed by account, so a purge deletes by account and never reads a
 * value: no token is selected, and none can reach a terminal or a log.
 */
const CREDENTIAL_STORES = [
  { file: "credentials.db", table: "credentials", holds: "refresh token" },
  { file: "access_tokens.db", table: "access_tokens", holds: "cached access token" },
];

/** Older and newer gcloud releases disagree on the column name. */
const ACCOUNT_COLUMNS = ["account_id", "account"];

let cachedSqlite;

/**
 * node:sqlite is still flagged experimental and says so on load. Every verdict
 * this tool prints goes to stderr, and the notice would land in the middle of
 * the report, so it is swallowed for the load alone -- not globally, and not
 * for anything the caller does afterwards.
 */
export function loadSqlite() {
  if (cachedSqlite !== undefined) return cachedSqlite;

  const require = createRequire(import.meta.url);
  const emitWarning = process.emitWarning;
  process.emitWarning = () => {};
  try {
    cachedSqlite = require("node:sqlite").DatabaseSync;
  } catch {
    // Node older than 22.5. Reported as a blocker by the caller, never as a
    // silent half-purge.
    cachedSqlite = null;
  } finally {
    process.emitWarning = emitWarning;
  }
  return cachedSqlite;
}

/**
 * Table and column names come out of the store being read, so they are checked
 * against an identifier shape instead of being escaped and trusted.
 */
function quoteIdent(name) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(String(name))) {
    throw new Error(`unexpected identifier in a gcloud store: ${JSON.stringify(String(name))}`);
  }
  return `"${name}"`;
}

function openStore(DatabaseSync, path, { readOnly = false } = {}) {
  if (readOnly) {
    try {
      return new DatabaseSync(path, { readOnly: true });
    } catch {
      // Older releases take no such option; a read-only intent still holds,
      // because this tool only ever reads without writing.
    }
  }
  return new DatabaseSync(path);
}

function tablesOf(db) {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((row) => row.name);
}

function columnsOf(db, table) {
  return db.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all();
}

function inspectStore(DatabaseSync, root, definition, account) {
  const path = join(root, definition.file);
  const entry = {
    file: definition.file,
    path,
    table: definition.table,
    holds: definition.holds,
    exists: existsSync(path),
    rows: 0,
    accounts: [],
    column: null,
    blocked: null,
    note: "",
  };

  if (!entry.exists) return entry;

  const db = openStore(DatabaseSync, path, { readOnly: true });
  try {
    if (!tablesOf(db).includes(definition.table)) {
      entry.note = `no ${definition.table} table`;
      return entry;
    }

    const column = ACCOUNT_COLUMNS.find((candidate) =>
      columnsOf(db, definition.table).some((row) => row.name === candidate),
    );

    if (!column) {
      const found = columnsOf(db, definition.table).map((row) => row.name);
      entry.blocked = `${definition.file} has a ${definition.table} table with no account column (found: ${
        found.join(", ") || "none"
      }); refusing to guess which rows belong to an identity`;
      return entry;
    }

    entry.column = column;
    entry.rows = Number(
      db
        .prepare(`SELECT count(*) AS n FROM ${quoteIdent(definition.table)} WHERE ${quoteIdent(column)} = ?`)
        .get(account).n,
    );
    entry.accounts = db
      .prepare(`SELECT DISTINCT ${quoteIdent(column)} AS account FROM ${quoteIdent(definition.table)}`)
      .all()
      .map((row) => row.account);
  } finally {
    db.close();
  }

  return entry;
}

/**
 * gcloud keeps configuration in *_configs.db as well as in the plain INI files
 * under configurations/. A row naming the purged account there is a dangling
 * pointer rather than a credential, so it is reported and left alone:
 * repointing a configuration decides what the shared root authenticates as,
 * which is not part of removing an identity from it.
 */
function scanConfigStores(DatabaseSync, root, account) {
  const hits = [];

  let files = [];
  try {
    files = readdirSync(root).filter((name) => name.endsWith("_configs.db"));
  } catch {
    return hits;
  }

  for (const file of files) {
    const db = openStore(DatabaseSync, join(root, file), { readOnly: true });
    try {
      for (const table of tablesOf(db)) {
        for (const column of columnsOf(db, table)) {
          if (!/TEXT/i.test(String(column.type || ""))) continue;
          const rows = Number(
            db
              .prepare(
                `SELECT count(*) AS n FROM ${quoteIdent(table)} WHERE ${quoteIdent(column.name)} LIKE ?`,
              )
              .get(`%${account}%`).n,
          );
          if (rows > 0) hits.push({ file, table, column: column.name, rows });
        }
      }
    } catch {
      // An unreadable or unrecognised configuration store says nothing about
      // the identity; the credential stores above decide the verdict.
    } finally {
      db.close();
    }
  }

  return hits;
}

/**
 * Reports what the shared root holds for one account, and -- only with apply --
 * removes it. Without apply this is a dry run that changes nothing.
 */
export function purgeAmbientAccount({ account, apply = false }) {
  const root = ambientRoot();

  if (!account) {
    throw new Error("Missing account. Usage: devo auth purge <account> [--yes]");
  }

  // The account becomes a path segment below the root, so it is validated as an
  // address rather than trusted as a path: `..` and `/` are not address
  // characters, which is what keeps the purge inside the root.
  if (!/^[^\s/@]+@[^\s/@]+$/.test(account)) {
    throw new Error(`Not an account address: ${account}. Usage: devo auth purge <account> [--yes]`);
  }

  const legacyPath = join(root, "legacy_credentials", account);
  const report = {
    root,
    account,
    apply: Boolean(apply),
    active: accountInRoot(root),
    legacy: { path: legacyPath, exists: existsSync(legacyPath), files: [] },
    stores: [],
    configs: [],
    adc: { path: join(root, "application_default_credentials.json"), exists: false, mtime: null },
    removed: null,
    blockers: [],
    // The state as found. Kept apart from finalClean on purpose: after a purge
    // this is still true of the moment before it, and a report that overwrote it
    // would print "nothing to purge" directly above "removed 2 rows".
    clean: false,
    finalClean: null,
  };

  if (report.legacy.exists) {
    try {
      report.legacy.files = readdirSync(legacyPath);
    } catch {
      report.legacy.files = [];
    }
  }

  if (existsSync(report.adc.path)) {
    report.adc.exists = true;
    report.adc.mtime = statSync(report.adc.path).mtime.toISOString();
  }

  const DatabaseSync = loadSqlite();
  const anyStore = CREDENTIAL_STORES.some((definition) => existsSync(join(root, definition.file)));

  if (!DatabaseSync && anyStore) {
    report.blockers.push(
      "node:sqlite is unavailable (it needs Node 22.5 or newer), so the credential stores cannot be cleaned. Refusing: deleting only the legacy directory would leave the refresh token in place and still report success.",
    );
  }

  if (DatabaseSync) {
    report.stores = CREDENTIAL_STORES.map((definition) => inspectStore(DatabaseSync, root, definition, account));
    report.configs = scanConfigStores(DatabaseSync, root, account);
    for (const store of report.stores) {
      if (store.blocked) report.blockers.push(store.blocked);
    }
  } else {
    report.stores = CREDENTIAL_STORES.map((definition) => ({
      ...definition,
      path: join(root, definition.file),
      exists: existsSync(join(root, definition.file)),
      rows: null,
      accounts: [],
      column: null,
      blocked: null,
      note: "not read",
    }));
  }

  // An unprefixed call in this root would be left with no identity at all, so
  // the account in use is the one account this tool will not take away.
  if (report.active.ok && report.active.account && report.active.account === account) {
    report.blockers.push(
      `the shared root already authenticates as ${account} (configuration ${report.active.configuration}). Repointing the configuration is a separate decision; the purge is refused while this account is the one in use.`,
    );
  }

  report.clean =
    !report.legacy.exists && report.stores.every((store) => !store.rows);

  if (!apply || report.blockers.length || report.clean) return report;

  const removed = { stores: [], legacy: false };

  // Rows first. The refresh token is the artifact that matters here, and a
  // directory deleted while its token stayed behind would read as a clean root.
  for (const store of report.stores) {
    if (!store.rows) continue;
    const db = openStore(DatabaseSync, store.path);
    try {
      const changes = db
        .prepare(`DELETE FROM ${quoteIdent(store.table)} WHERE ${quoteIdent(store.column)} = ?`)
        .run(account).changes;
      removed.stores.push({ file: store.file, rows: Number(changes) });
    } finally {
      db.close();
    }
  }

  if (report.legacy.exists) {
    rmSync(legacyPath, { recursive: true, force: true });
    removed.legacy = true;
  }

  report.removed = removed;

  // Re-read rather than trust the deletes: this object is what the user reads
  // before walking away from the incident.
  report.stores = CREDENTIAL_STORES.map((definition) => inspectStore(DatabaseSync, root, definition, account));
  report.legacy.exists = existsSync(legacyPath);
  report.finalClean = !report.legacy.exists && report.stores.every((store) => !store.rows);

  return report;
}
