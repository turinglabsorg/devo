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
import { repairProfile, runGcloud } from "./scripts/gcloud.mjs";
import { gcloudProfilesDir, listProfiles, probeProfile } from "./scripts/profiles.mjs";
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
  devo auth status [--quiet] [--notify] [--json] [--record]
  devo auth watch [--install [--interval seconds] | --uninstall]
  devo auth repair <profile>

Topics:
  all, identity, services, logs, costs, iam

Identity:
  A gcloud call outside its profile root silently uses the shared global config
  and the wrong account. \`devo gcloud\` therefore requires --profile and runs
  gcloud with CLOUDSDK_CONFIG set to that profile's root.

Examples:
  devo doctor --provider all
  devo doctor --provider gcp --json
  devo doctor --tenant letzgo
  devo tenants
  devo tenant letzgo
  devo profiles
  devo profiles --probe
  devo gcloud --profile credilex --project credilex-gprod -- run services list --region europe-west8
  devo auth status
  devo auth watch --install              # hourly launchd watchdog, notifies only on failure
  devo auth watch                        # is it loaded, and when did it last fail
  devo auth repair credilex
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
 */
function authStatus({ quiet, notify, json, record }) {
  const profiles = listProfiles().filter((profile) => profile.declared && profile.healthProject);
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

/**
 * One line per run, so the interval between failures can be measured -- and the
 * reason, so a later reader does not have to guess which failure it was.
 */
function recordHistory(results) {
  const path = historyPath();
  mkdirSync(dirname(path), { recursive: true });
  const line = JSON.stringify({
    at: new Date().toISOString(),
    results: results.map((result) => ({
      profile: result.profile,
      ok: result.ok === true,
      summary: result.summary,
      ...(result.ok === true ? {} : { stale: result.stale === true, timedOut: result.timedOut === true }),
      ...(result.attempts ? { attempts: result.attempts } : {}),
      ...(result.ok === true ? {} : { error: result.error || "" }),
    })),
  });
  appendFileSync(path, `${line}\n`);
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
  console.log(`  runs recorded: ${report.runs} (failures: ${report.failures})`);
  if (report.lastRun) console.log(`  last run: ${report.lastRun.at}`);
  if (report.lastFailure) {
    const failed = report.lastFailure.results.filter((result) => !result.ok);
    console.log(`  last failure: ${report.lastFailure.at}`);
    for (const result of failed) console.log(`    ${result.profile}: ${result.summary}`);
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

  if (command === "auth") {
    if (args[1] === "status") {
      process.exitCode = authStatus({
        quiet: hasFlag("--quiet"),
        notify: hasFlag("--notify"),
        json: hasFlag("--json"),
        record: hasFlag("--record"),
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

    if (args[1] !== "repair") {
      throw new Error(
        `Unknown auth subcommand: ${args[1] || "(none)"}. Expected: devo auth status, devo auth watch, or devo auth repair <profile>`,
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
