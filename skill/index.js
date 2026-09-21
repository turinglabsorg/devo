#!/usr/bin/env node

import { spawnSync } from "child_process";
import { appendFileSync, mkdirSync } from "fs";
import { dirname } from "path";

import {
  COMMAND_CATALOG,
  listTenants,
  normalizeProvider,
  printCommandCatalog,
  resolveTenant,
  runDoctor,
} from "./scripts/doctor.mjs";
import { ambientRoot, purgeAmbientAccount } from "./scripts/ambient.mjs";
import { runExec } from "./scripts/exec.mjs";
import { repairProfile, runGcloud } from "./scripts/gcloud.mjs";
import { findProfile, gcloudProfilesDir, listProfiles, probeProfile } from "./scripts/profiles.mjs";
import { historyPath, installWatch, uninstallWatch, watchStatus } from "./scripts/watch.mjs";

const args = process.argv.slice(2);
const command = args[0] || "help";

function getFlag(name, fallback = undefined) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) return true;
  return value;
}

function hasFlag(name) {
  return args.includes(name);
}

function printHelp() {
  console.log(`Devo cloud operations helper

Usage:
  devo doctor [--provider all|gcp|aws|digitalocean] [--tenant name] [--config path] [--json]
  devo tenants [--config path]
  devo tenant <name> [--config path] [--json]
  devo commands [gcp|aws|digitalocean] [topic] [--tenant name] [--config path]
  devo profiles [--probe] [--json]
  devo gcloud --profile <name> [--project id] [--account email] [--allow-mutation] [--tty] -- <gcloud args>
  devo exec --profile <name> [--project id] [--account email] [--allow-mutation] -- <command...>
  devo auth status [--profile name] [--quiet] [--notify] [--json] [--record]
  devo auth watch [--install [--interval seconds] | --uninstall]
  devo auth repair <profile>
  devo auth purge <account> [--yes]

Topics:
  all, identity, services, logs, costs, iam

Identity:
  A gcloud call outside its profile root silently uses the shared global config
  and the wrong account. \`devo gcloud\` therefore requires --profile and runs
  gcloud with CLOUDSDK_CONFIG set to that profile's root.

  A caller that is not gcloud -- the docker CLI and the credential helper it
  spawns, terraform, an ADC client library -- needs the same root and has no
  gcloud flags to carry it. \`devo exec\` pins the root for the command it starts,
  so the caller names a profile instead of a directory, and refuses to pass on
  any argument that names a root or a credential store.

  An identity that landed in the shared root anyway is removed with
  \`devo auth purge\`. It deletes the local copy only and makes no gcloud call,
  so the refresh token stays valid on Google's side and the isolated profile
  that holds the same account keeps working. The default is a dry run.

Examples:
  devo doctor --provider all
  devo doctor --provider gcp --json
  devo doctor --tenant letzgo
  devo tenants
  devo tenant letzgo
  devo profiles
  devo profiles --probe
  devo gcloud --profile credilex --project credilex-gprod -- run services list --region europe-west8
  devo exec --profile master -- docker push REGISTRY/IMAGE:TAG
  devo exec --profile master -- terraform apply
  devo auth status
  devo auth watch --install              # hourly launchd watchdog, notifies only on failure
  devo auth watch                        # is it loaded, and when did it last fail
  devo auth repair credilex
  devo auth purge seba@credilex.it         # dry run: what the shared root holds
  devo auth purge seba@credilex.it --yes   # remove it, locally only
  devo commands --tenant letzgo services
  devo commands gcp logs
  devo commands aws costs
  devo doctor --tenant example-digitalocean
  devo commands digitalocean services`);
}

function printDoctorHuman(report) {
  console.log(`Devo doctor (${report.generatedAt})`);
  if (report.tenant) console.log(`Tenant: ${report.tenant}`);
  if (report.configPath) console.log(`Config: ${report.configPath}`);
  for (const warning of report.warnings || []) {
    console.log(`Warning: ${warning}`);
  }
  console.log("");

  for (const providerReport of report.providers) {
    console.log(`${providerReport.provider.toUpperCase()}: ${providerReport.ok ? "ok" : "needs attention"}`);

    for (const check of providerReport.checks) {
      const status = check.skipped ? "skip" : check.ok ? "ok" : "fail";
      console.log(`  [${status}] ${check.name}`);
      if (check.summary) console.log(`       ${check.summary}`);
      if (check.warning) console.log(`       warning: ${check.warning}`);
      if (!check.ok && !check.skipped && check.error) console.log(`       ${check.error}`);
    }

    console.log("");
  }
}

function printPurgeReport(report) {
  console.log(`Shared ambient root: ${report.root}`);
  console.log(`Identity:            ${report.account}`);
  console.log("");

  console.log(
    report.active.ok && report.active.account
      ? `The root authenticates as ${report.active.account} (configuration ${report.active.configuration}).`
      : `The root declares no active account (configuration ${report.active.configuration}).`,
  );
  console.log("");

  if (report.clean) {
    console.log(`Nothing to purge: the root holds no credential material for ${report.account}.`);
  } else if (report.removed) {
    console.log(`Removed from the root for this identity:`);
    if (report.removed.legacy) console.log(`  legacy_credentials/${report.account}/`);
    for (const store of report.removed.stores) {
      if (store.rows) console.log(`  ${store.file}: ${store.rows} row(s)`);
    }
  } else {
    console.log("Held by the root for this identity:");
    if (report.legacy.exists) {
      const files = report.legacy.files.length ? `  ${report.legacy.files.join(", ")}` : "";
      console.log(`  legacy_credentials/${report.account}/ ${files}`);
    }
    for (const store of report.stores) {
      if (!store.exists) continue;
      const rows =
        store.rows === null ? "not read" : `${store.rows} row${store.rows === 1 ? "" : "s"}`;
      console.log(`  ${store.file} (${store.table}): ${rows} -- ${store.holds}`);
    }
  }
  console.log("");

  // Named so the report cannot be mistaken for "the stores are now empty": the
  // accounts that are not being purged are the ones that must survive.
  const others = [
    ...new Set(
      report.stores
        .flatMap((store) => store.accounts || [])
        .filter((candidate) => candidate && candidate !== report.account),
    ),
  ];
  if (others.length) {
    console.log(`Identities that stay in the stores: ${others.join(", ")}`);
    console.log("");
  }

  console.log("Left alone on purpose:");
  if (report.adc.exists) {
    console.log(
      `  application_default_credentials.json   last modified ${String(report.adc.mtime).slice(0, 10)}, neither read nor deleted`,
    );
  }
  if (report.configs.length) {
    for (const hit of report.configs) {
      console.log(`  ${hit.file} (${hit.table}.${hit.column}): ${hit.rows} row(s) still name this account`);
    }
    console.log("  repointing a configuration is a separate decision: nothing here rewrites one");
  } else {
    console.log("  no configuration store names this account, so no pointer needs repointing");
  }
  console.log("");

  if (report.blockers.length) {
    console.log("Refused:");
    for (const blocker of report.blockers) console.log(`  ${blocker}`);
    console.log("");
  }

  if (report.removed) {
    console.log(
      report.finalClean
        ? `The root now holds nothing for this identity. No gcloud call was made, so the refresh token is still valid at Google and the isolated profile keeps working.`
        : `The root still holds something for this identity: run without --yes to see what is left.`,
    );
    console.log("");
    return;
  }

  if (report.blockers.length) return;

  console.log(
    "No gcloud call is made and nothing is revoked at Google: the isolated profile that holds this account keeps working.",
  );
  console.log("");
  console.log(`Dry run: nothing was changed. Apply with: devo auth purge ${report.account} --yes`);
}

function printTenantsHuman(report) {
  if (report.configPath) {
    console.log(`Config: ${report.configPath}`);
  } else {
    console.log("Config: not found");
  }

  if (report.tenants.length === 0) {
    console.log("No tenants configured.");
    return;
  }

  for (const tenant of report.tenants) {
    const scope = tenant.projectId || tenant.accountId || tenant.teamName || tenant.doctlContext || "no cloud scope";
    const region = tenant.defaultRegion || tenant.regions[0] || "no default region";
    const identity = tenant.gcloudProfile
      ? ` profile=${tenant.gcloudProfile}`
      : tenant.gcloudConfiguration
        ? ` configuration=${tenant.gcloudConfiguration}`
        : "";
    console.log(`${tenant.name}: ${tenant.provider} ${scope} ${region}${identity}`);
  }
}

function printTenantHuman(resolved) {
  const tenant = resolved.tenant;
  console.log(`${resolved.name}`);
  console.log(`  provider: ${tenant.provider}`);
  if (tenant.projectName) console.log(`  projectName: ${tenant.projectName}`);
  if (tenant.projectId) console.log(`  projectId: ${tenant.projectId}`);
  if (tenant.projectNumber) console.log(`  projectNumber: ${tenant.projectNumber}`);
  if (tenant.accountId) console.log(`  accountId: ${tenant.accountId}`);
  if (tenant.gcloudProfile) console.log(`  gcloudProfile: ${tenant.gcloudProfile}`);
  if (tenant.gcloudConfiguration) console.log(`  gcloudConfiguration: ${tenant.gcloudConfiguration} (legacy)`);
  if (tenant.profile) console.log(`  profile: ${tenant.profile}`);
  if (tenant.doctlContext) console.log(`  doctlContext: ${tenant.doctlContext}`);
  if (tenant.teamName) console.log(`  teamName: ${tenant.teamName}`);
  if (tenant.digitalOceanProjectId) console.log(`  digitalOceanProjectId: ${tenant.digitalOceanProjectId}`);
  if (tenant.sourceRoot) console.log(`  sourceRoot: ${tenant.sourceRoot}`);
  if (tenant.artifactRegistryRepo) console.log(`  artifactRegistryRepo: ${tenant.artifactRegistryRepo}`);
  if (tenant.defaultRegion) console.log(`  defaultRegion: ${tenant.defaultRegion}`);
  if (tenant.regions?.length) console.log(`  regions: ${tenant.regions.join(", ")}`);
  if (tenant.repositories?.length) console.log(`  repositories: ${tenant.repositories.join(", ")}`);
  if (tenant.services?.length) console.log(`  services: ${tenant.services.join(", ")}`);
  if (tenant.notes) console.log(`  notes: ${tenant.notes}`);
  for (const warning of resolved.warnings || []) {
    console.log(`  warning: ${warning}`);
  }
}

function printProfilesHuman(report) {
  console.log(`Profiles root: ${report.root}`);

  for (const profile of report.profiles) {
    const state = !profile.rootExists ? "missing" : profile.declared ? "declared" : "undeclared";
    console.log(`${profile.name}: ${state}`);
    if (profile.account) console.log(`  account: ${profile.account}`);
    console.log(`  root: ${profile.root}`);
    if (profile.healthProject) console.log(`  healthProject: ${profile.healthProject}`);
    if (profile.projectPatterns?.length) console.log(`  projectPatterns: ${profile.projectPatterns.join(", ")}`);
    if (profile.label) console.log(`  ${profile.label}`);
    if (profile.probe) {
      const verdict = profile.probe.ok === true ? "ok" : profile.probe.ok === null ? "skip" : "fail";
      console.log(`  [${verdict}] ${profile.probe.summary || ""}`);
      if (profile.probe.repair) console.log(`       repair: ${profile.probe.repair}`);
      if (profile.probe.ok === false && profile.probe.error) console.log(`       ${profile.probe.error}`);
    }
  }
}

/**
 * Probes every declared profile that has a health project and reports the ones
 * whose stored refresh token Google no longer accepts.
 *
 * This is a detector, not a keep-alive. A refresh token is not expired by short
 * inactivity, so polling it cannot stop it from dying; what the poll buys is
 * finding out within the hour instead of in the middle of a task.
 *
 * --profile narrows the probe to one identity, which together with --record is
 * what keeps two processes on two identities out of each other's files: the
 * record path is derived from the profile.
 */
function authStatus({ quiet, notify, json, record, profileName }) {
  const profiles = profileName
    ? [probeableProfile(profileName)]
    : listProfiles().filter((profile) => profile.declared && profile.healthProject);
  const results = profiles.map((profile) => {
    const { name, ...probe } = probeProfile(profile);
    return { profile: profile.name, ...probe };
  });
  const failing = results.filter((result) => result.ok !== true);

  if (json) {
    console.log(JSON.stringify({ checkedAt: new Date().toISOString(), results }, null, 2));
  } else if (!quiet || failing.length) {
    // Printed under --record too: the launchd job redirects stdout to a log, and
    // a failure with nothing in the log is the kind of anomaly that costs an
    // hour of guessing.
    for (const result of results) {
      console.log(`[${result.ok === true ? "ok" : "fail"}] ${result.profile}: ${result.summary}`);
      if (result.repair) console.log(`       repair: ${result.repair}`);
    }
  }

  if (record) recordHistory(results);

  if (failing.length && notify) {
    notifyDesktop(
      "devo auth",
      failing.map((result) => `${result.profile}: ${result.summary}`).join(" | "),
    );
  }

  return failing.length ? 1 : 0;
}

/** Fail closed on a name that would otherwise probe nothing and report success. */
function probeableProfile(name) {
  const profile = findProfile(name);
  if (!profile) {
    throw new Error(
      `Unknown profile: ${name}. Known profiles: ${listProfiles()
        .map((candidate) => candidate.name)
        .join(", ")}`,
    );
  }

  if (!profile.declared || !profile.healthProject) {
    const probed = listProfiles()
      .filter((candidate) => candidate.declared && candidate.healthProject)
      .map((candidate) => candidate.name);
    throw new Error(
      `Profile ${name} has no health project configured, so there is nothing to probe. Probed profiles: ${probed.join(", ") || "(none)"}`,
    );
  }

  return profile;
}

/**
 * One line per profile, in that profile's own file, so the interval between
 * failures can be measured -- and the reason, so a later reader does not have to
 * guess which failure it was.
 *
 * The path carries the profile. A caller that probes one identity writes one
 * file that no other identity's process opens, which is the whole reason the
 * records are split: a shared file cannot be written by two agents working on
 * two gclouds without one of them being in the other's way.
 */
function recordHistory(results) {
  for (const result of results) {
    const path = historyPath(result.profile);
    mkdirSync(dirname(path), { recursive: true });
    const line = JSON.stringify({
      at: new Date().toISOString(),
      profile: result.profile,
      ok: result.ok === true,
      summary: result.summary,
      ...(result.ok === true ? {} : { stale: result.stale === true, timedOut: result.timedOut === true }),
      ...(result.attempts ? { attempts: result.attempts } : {}),
      ...(result.ok === true ? {} : { error: result.error || "" }),
    });
    appendFileSync(path, `${line}\n`);
  }
}

/** A desktop notice, so a dead profile is seen without opening a log file. */
function notifyDesktop(title, message) {
  spawnSync("osascript", [
    "-e",
    `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`,
  ]);
}

function printWatchInstall(report) {
  console.log(`Watchdog installed: every ${report.intervalSeconds}s`);
  console.log(`  plist: ${report.plist}`);
  console.log(`  log:   ${report.log}`);
  console.log(`  history: ${report.history}`);
  console.log(report.loaded ? "  launchd: loaded" : `  launchd: NOT loaded -- ${report.error}`);
}

function printWatchUninstall(report) {
  console.log(report.removed ? `Removed ${report.plist}` : "No plist to remove.");
  console.log(report.unloaded ? "launchd: unloaded" : "launchd: was not loaded");
  if (report.note) console.log(`  ${report.note}`);
}

function printWatchStatus(report) {
  if (!report.installed) {
    console.log("Watchdog not installed. Install with: devo auth watch --install");
    console.log(`  would write: ${report.plist}`);
    console.log(`  would log to: ${report.log}`);
    console.log(`  would record: ${report.history}`);
    return;
  }

  console.log("Watchdog installed");
  console.log(`  plist: ${report.plist}`);
  console.log(`  launchd: ${report.loaded ? "loaded" : "NOT loaded"}`);
  console.log(`  interval: ${report.intervalSeconds}s`);
  console.log(`  records: ${report.runs} (failures: ${report.failures})`);
  if (report.lastRun) console.log(`  last run: ${report.lastRun.at} (${report.lastRun.profile})`);
  if (report.lastFailure) {
    console.log(`  last failure: ${report.lastFailure.at}`);
    console.log(`    ${report.lastFailure.profile}: ${report.lastFailure.summary}`);
  }
  if (report.legacyRecords) {
    console.log(`  note: ${report.legacyRecords} older records from the single-file era are in`);
    console.log(`        ${report.legacyHistory}, and are not counted above`);
  }
  for (const line of report.logTail) console.log(`  log: ${line}`);
}

async function main() {
  if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (command === "doctor") {
    const tenantName = getFlag("--tenant");
    const provider = tenantName ? getFlag("--provider") : normalizeProvider(getFlag("--provider", "all"));
    const report = runDoctor({ provider, tenantName, configPath: getFlag("--config") });
    if (!report.providers.every((providerReport) => providerReport.ok)) {
      process.exitCode = 1;
    }
    if (hasFlag("--json")) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    printDoctorHuman(report);
    return;
  }

  if (command === "profiles") {
    const probe = hasFlag("--probe");
    const profiles = listProfiles().map((profile) => ({
      ...profile,
      probe: probe ? probeProfile(profile) : undefined,
    }));
    const report = { root: gcloudProfilesDir(), probed: probe, profiles };

    if (probe && profiles.some((profile) => profile.probe?.ok === false)) {
      process.exitCode = 1;
    }

    if (hasFlag("--json")) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    printProfilesHuman(report);
    return;
  }

  if (command === "gcloud") {
    const separator = args.indexOf("--");
    process.exitCode = runGcloud({
      profileName: getFlag("--profile"),
      projectId: getFlag("--project"),
      account: getFlag("--account"),
      allowMutation: hasFlag("--allow-mutation"),
      tty: hasFlag("--tty"),
      args: separator === -1 ? [] : args.slice(separator + 1),
    });
    return;
  }

  if (command === "exec") {
    const separator = args.indexOf("--");
    if (separator === -1) {
      throw new Error("Missing `--`. Usage: devo exec --profile <name> [--project <id>] -- <command...>");
    }

    // Flags are read before the separator only. After it the words belong to the
    // command being started, which has flags of its own: a `--project` there is
    // the command's project, not this route's, and reading it as ours would pin
    // the wrong one.
    const before = args.slice(0, separator);
    const flag = (name) => {
      const index = before.indexOf(name);
      return index === -1 ? undefined : before[index + 1];
    };

    process.exitCode = runExec({
      profileName: flag("--profile"),
      projectId: flag("--project"),
      account: flag("--account"),
      allowMutation: before.includes("--allow-mutation"),
      args: args.slice(separator + 1),
    });
    return;
  }

  if (command === "auth") {
    if (args[1] === "status") {
      process.exitCode = authStatus({
        quiet: hasFlag("--quiet"),
        notify: hasFlag("--notify"),
        json: hasFlag("--json"),
        record: hasFlag("--record"),
        profileName: getFlag("--profile"),
      });
      return;
    }

    if (args[1] === "watch") {
      if (hasFlag("--install")) {
        const intervalFlag = getFlag("--interval");
        const report = installWatch({
          intervalSeconds: typeof intervalFlag === "string" ? Number(intervalFlag) : undefined,
        });
        printWatchInstall(report);
        process.exitCode = report.loaded ? 0 : 1;
        return;
      }
      if (hasFlag("--uninstall")) {
        printWatchUninstall(uninstallWatch());
        return;
      }
      printWatchStatus(watchStatus());
      return;
    }

    if (args[1] === "purge") {
      // One scope only: the shared ambient root. A profile root holds its own
      // account on purpose, and the way to fix one of those is `auth repair`.
      if (args.includes("--profile") || args.includes("--root")) {
        throw new Error(
          "devo auth purge takes no --profile and no --root: it acts on the shared ambient root only. Use `devo auth repair <profile>` for a profile root.",
        );
      }

      const report = purgeAmbientAccount({
        account: args.slice(2).find((arg) => !arg.startsWith("--")),
        apply: hasFlag("--yes"),
      });
      printPurgeReport(report);
      process.exitCode = report.blockers.length ? 1 : 0;
      return;
    }

    if (args[1] !== "repair") {
      throw new Error(
        `Unknown auth subcommand: ${args[1] || "(none)"}. Expected: devo auth status, devo auth watch, devo auth repair <profile>, or devo auth purge <account>`,
      );
    }
    process.exitCode = repairProfile(args[2]);
    return;
  }

  if (command === "tenants") {
    const report = listTenants({ configPath: getFlag("--config") });
    if (hasFlag("--json")) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    printTenantsHuman(report);
    return;
  }

  if (command === "tenant") {
    const resolved = resolveTenant(args[1], { configPath: getFlag("--config") });
    if (hasFlag("--json")) {
      console.log(JSON.stringify(resolved, null, 2));
      return;
    }
    printTenantHuman(resolved);
    return;
  }

  if (command === "commands") {
    const tenantName = getFlag("--tenant");
    const configPath = getFlag("--config");
    const positional = args.slice(1).filter((arg) => {
      if (arg.startsWith("--")) return false;
      const previous = args[args.indexOf(arg) - 1];
      return previous !== "--tenant" && previous !== "--config";
    });
    const first = positional[0];
    const provider = ["gcp", "aws", "digitalocean", "do", "digital-ocean", "all"].includes(first)
      ? normalizeProvider(first)
      : undefined;
    const topic = provider ? positional[1] || "all" : first || "all";
    printCommandCatalog({ provider, topic, tenantName, configPath });
    return;
  }

  console.error(`Unknown command: ${command}`);
  printHelp();
  process.exitCode = 1;
}

main().catch((error) => {
  // Every error this CLI raises deliberately is a refusal the caller can act
  // on: a missing flag, an unknown profile, a project outside the profile's
  // scope. Printed as a stack it names internal paths and reads like a crash,
  // which is the opposite of what a refusal is for. The stack is one env var
  // away when the error is genuinely unexpected.
  console.error(process.env.DEVO_DEBUG ? error?.stack : error?.message || String(error));
  process.exitCode = 1;
});

export { COMMAND_CATALOG, runDoctor };
