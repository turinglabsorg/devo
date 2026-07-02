#!/usr/bin/env node

import {
  COMMAND_CATALOG,
  listTenants,
  normalizeProvider,
  printCommandCatalog,
  resolveTenant,
  runDoctor,
} from "./scripts/doctor.mjs";

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
  devo doctor [--provider all|gcp|aws] [--tenant name] [--config path] [--json]
  devo tenants [--config path]
  devo tenant <name> [--config path] [--json]
  devo commands [gcp|aws] [topic] [--tenant name] [--config path]

Topics:
  all, identity, services, logs, costs, iam

Examples:
  devo doctor --provider all
  devo doctor --provider gcp --json
  devo doctor --tenant letzgo
  devo tenants
  devo tenant letzgo
  devo commands --tenant letzgo services
  devo commands gcp logs
  devo commands aws costs`);
}

function printDoctorHuman(report) {
  console.log(`Devo doctor (${report.generatedAt})`);
  if (report.tenant) console.log(`Tenant: ${report.tenant}`);
  if (report.configPath) console.log(`Config: ${report.configPath}`);
  console.log("");

  for (const providerReport of report.providers) {
    console.log(`${providerReport.provider.toUpperCase()}: ${providerReport.ok ? "ok" : "needs attention"}`);

    for (const check of providerReport.checks) {
      const status = check.ok ? "ok" : "fail";
      console.log(`  [${status}] ${check.name}`);
      if (check.summary) console.log(`       ${check.summary}`);
      if (check.warning) console.log(`       warning: ${check.warning}`);
      if (!check.ok && check.error) console.log(`       ${check.error}`);
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
    const scope = tenant.projectId || tenant.accountId || "no cloud scope";
    const region = tenant.defaultRegion || tenant.regions[0] || "no default region";
    console.log(`${tenant.name}: ${tenant.provider} ${scope} ${region}`);
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
  if (tenant.gcloudConfiguration) console.log(`  gcloudConfiguration: ${tenant.gcloudConfiguration}`);
  if (tenant.profile) console.log(`  profile: ${tenant.profile}`);
  if (tenant.sourceRoot) console.log(`  sourceRoot: ${tenant.sourceRoot}`);
  if (tenant.artifactRegistryRepo) console.log(`  artifactRegistryRepo: ${tenant.artifactRegistryRepo}`);
  if (tenant.defaultRegion) console.log(`  defaultRegion: ${tenant.defaultRegion}`);
  if (tenant.regions?.length) console.log(`  regions: ${tenant.regions.join(", ")}`);
  if (tenant.repositories?.length) console.log(`  repositories: ${tenant.repositories.join(", ")}`);
  if (tenant.services?.length) console.log(`  services: ${tenant.services.join(", ")}`);
  if (tenant.notes) console.log(`  notes: ${tenant.notes}`);
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
    if (hasFlag("--json")) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    printDoctorHuman(report);
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
    const provider = ["gcp", "aws", "all"].includes(first) ? normalizeProvider(first) : undefined;
    const topic = provider ? positional[1] || "all" : first || "all";
    printCommandCatalog({ provider, topic, tenantName, configPath });
    return;
  }

  console.error(`Unknown command: ${command}`);
  printHelp();
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});

export { COMMAND_CATALOG, runDoctor };
