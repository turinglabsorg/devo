import { spawnSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

import {
  LEGACY_FIELD_NOTE,
  LEGACY_PROFILE_FIELD,
  PROFILE_FIELD,
  findProfile,
  isStaleToken,
  listProfiles,
  probeProfile,
  profileEnv,
  requireProfile,
} from "./profiles.mjs";

const DEFAULT_TIMEOUT_MS = 15000;
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SKILL_DIR = resolve(__dirname, "..");
const REPO_DIR = resolve(SKILL_DIR, "..");

export const COMMAND_CATALOG = {
  gcp: {
    identity: [
      "gcloud auth list --filter=status:ACTIVE --format=json",
      "gcloud config list --format=json",
      "gcloud projects describe PROJECT_ID --format=json",
    ],
    services: [
      "gcloud services list --enabled --project PROJECT_ID",
      "gcloud run services list --project PROJECT_ID --region REGION",
      "gcloud compute instances list --project PROJECT_ID",
      "gcloud container clusters list --project PROJECT_ID",
      "gcloud sql instances list --project PROJECT_ID",
    ],
    logs: [
      "gcloud logging read 'resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"SERVICE\"' --project PROJECT_ID --freshness=1h --limit=100 --format=json",
      "gcloud logging read 'severity>=ERROR' --project PROJECT_ID --freshness=24h --limit=100 --format=json",
    ],
    costs: [
      "gcloud billing projects describe PROJECT_ID",
      "gcloud billing accounts list",
      "bq query --use_legacy_sql=false 'SELECT service.description, SUM(cost) cost FROM `BILLING_EXPORT_TABLE` WHERE usage_start_time >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 30 DAY) GROUP BY 1 ORDER BY cost DESC LIMIT 20'",
    ],
    iam: [
      "gcloud projects get-iam-policy PROJECT_ID --format=json",
      "gcloud iam service-accounts list --project PROJECT_ID",
      "gcloud secrets list --project PROJECT_ID",
    ],
  },
  aws: {
    identity: [
      "aws sts get-caller-identity --output json",
      "aws configure list",
      "aws configure list-profiles",
    ],
    services: [
      "aws ec2 describe-instances --region REGION --output json",
      "aws ecs list-clusters --region REGION --output json",
      "aws eks list-clusters --region REGION --output json",
      "aws lambda list-functions --region REGION --output json",
      "aws rds describe-db-instances --region REGION --output json",
      "aws s3api list-buckets --output json",
    ],
    logs: [
      "aws logs describe-log-groups --region REGION --output json",
      "aws logs filter-log-events --log-group-name LOG_GROUP --start-time START_MS --end-time END_MS --region REGION --output json",
    ],
    costs: [
      "aws ce get-cost-and-usage --time-period Start=YYYY-MM-01,End=YYYY-MM-DD --granularity MONTHLY --metrics UnblendedCost --group-by Type=DIMENSION,Key=SERVICE --output json",
      "aws ce get-cost-forecast --time-period Start=YYYY-MM-DD,End=YYYY-MM-DD --metric UNBLENDED_COST --granularity MONTHLY --output json",
      "aws budgets describe-budgets --account-id ACCOUNT_ID --output json",
    ],
    iam: [
      "aws iam get-account-summary --output json",
      "aws iam list-users --output json",
      "aws iam list-roles --output json",
      "aws iam list-account-aliases --output json",
    ],
  },
  digitalocean: {
    identity: [
      "doctl --context DOCTL_CONTEXT account get --output json",
      "doctl --context DOCTL_CONTEXT account ratelimit --output json",
      "doctl auth list",
    ],
    services: [
      "doctl --context DOCTL_CONTEXT projects list --output json",
      "doctl --context DOCTL_CONTEXT apps list --output json",
      "doctl --context DOCTL_CONTEXT compute droplet list --output json",
      "doctl --context DOCTL_CONTEXT databases list --output json",
      "doctl --context DOCTL_CONTEXT kubernetes cluster list --output json",
    ],
    logs: [
      "doctl --context DOCTL_CONTEXT apps list --output json",
      "doctl --context DOCTL_CONTEXT apps logs APP_ID COMPONENT --type run --tail 100",
    ],
    costs: [
      "doctl --context DOCTL_CONTEXT balance get --output json",
      "doctl --context DOCTL_CONTEXT billing-history list --output json",
    ],
    iam: [
      "doctl --context DOCTL_CONTEXT account get --output json",
      "doctl --context DOCTL_CONTEXT compute ssh-key list --output json",
      "doctl --context DOCTL_CONTEXT projects list --output json",
    ],
  },
};

const DEFAULT_CONFIG_PATHS = [
  resolve(process.cwd(), "devo.config.json"),
  resolve(REPO_DIR, "devo.config.json"),
  join(process.env.HOME || "", ".devo", "config.json"),
].filter(Boolean);

export function normalizeProvider(provider) {
  const value = String(provider || "all").toLowerCase();
  const normalized = {
    do: "digitalocean",
    "digital-ocean": "digitalocean",
    digital_ocean: "digitalocean",
  }[value] || value;
  if (["all", "gcp", "aws", "digitalocean"].includes(normalized)) return normalized;
  throw new Error(`Unsupported provider: ${provider}. Expected all, gcp, aws, or digitalocean.`);
}

export function loadConfig(configPath) {
  const paths = configPath ? [resolve(configPath)] : DEFAULT_CONFIG_PATHS;
  const foundPath = paths.find((path) => existsSync(path));

  if (!foundPath) {
    return {
      path: null,
      config: { version: 1, tenants: {} },
    };
  }

  return {
    path: foundPath,
    config: JSON.parse(readFileSync(foundPath, "utf8")),
  };
}

export function listTenants({ configPath } = {}) {
  const loaded = loadConfig(configPath);
  const tenants = Object.entries(loaded.config.tenants || {}).map(([name, tenant]) => ({
    name,
    provider: tenant.provider,
    projectId: tenant.projectId,
    accountId: tenant.accountId,
    profile: tenant.profile,
    gcloudProfile: tenant[PROFILE_FIELD],
    gcloudConfiguration: tenant[LEGACY_PROFILE_FIELD],
    doctlContext: tenant.doctlContext,
    teamName: tenant.teamName,
    digitalOceanProjectId: tenant.digitalOceanProjectId,
    defaultRegion: tenant.defaultRegion,
    regions: tenant.regions || [],
    notes: tenant.notes || "",
  }));

  return {
    configPath: loaded.path,
    tenants,
  };
}

export function resolveTenant(name, { configPath } = {}) {
  if (!name) throw new Error("Missing tenant name.");

  const loaded = loadConfig(configPath);
  const tenant = loaded.config.tenants?.[name];
  if (!tenant) {
    const knownTenants = Object.keys(loaded.config.tenants || {});
    throw new Error(
      `Unknown tenant: ${name}. Known tenants: ${knownTenants.length ? knownTenants.join(", ") : "none"}`,
    );
  }

  const provider = normalizeProvider(tenant.provider);
  if (provider === "digitalocean" && !tenant.doctlContext) {
    throw new Error(`DigitalOcean tenant ${name} must define doctlContext.`);
  }

  const forbiddenCredentialFields = ["accessToken", "apiToken", "token"];
  const forbiddenField = forbiddenCredentialFields.find((field) => tenant[field]);
  if (forbiddenField) {
    throw new Error(
      `Tenant ${name} contains forbidden credential field ${forbiddenField}. Store credentials in the provider CLI, not Devo config.`,
    );
  }

  const warnings = [];
  const gcloudProfile = tenant[PROFILE_FIELD];
  if (provider === "gcp" && gcloudProfile && !findProfile(gcloudProfile)) {
    throw new Error(
      `Tenant ${name} declares unknown ${PROFILE_FIELD} "${gcloudProfile}". Known profiles: ${listProfiles()
        .map((candidate) => candidate.name)
        .join(", ")}.`,
    );
  }

  if (provider === "gcp" && !gcloudProfile && tenant[LEGACY_PROFILE_FIELD]) {
    warnings.push(
      `Tenant ${name} uses ${LEGACY_PROFILE_FIELD} "${tenant[LEGACY_PROFILE_FIELD]}": ${LEGACY_FIELD_NOTE}, so gcloud will run with whatever identity the shared global config holds. Set "${PROFILE_FIELD}" instead.`,
    );
  }

  return {
    configPath: loaded.path,
    name,
    warnings,
    tenant: {
      ...tenant,
      provider,
    },
  };
}

/**
 * A suggested gcloud command is only useful if it carries its identity: printed
 * bare, it runs against the shared global config with whatever account happens
 * to be active there.
 */
function applyGcloudIdentity(command, tenant) {
  const profileName = tenant[PROFILE_FIELD];

  if (profileName) {
    const profile = findProfile(profileName);
    if (!profile) {
      return `${command}  # unknown ${PROFILE_FIELD} "${profileName}"`;
    }

    const isGcloud = command.startsWith("gcloud ");
    const subcommand = isGcloud ? command.split(/\s+/)[1] : "";
    // `auth` and `config` are the calls that inspect the identity itself, and
    // bq spells its project flag differently, so neither gets the pinned flags.
    const pinnable = isGcloud && subcommand !== "auth" && subcommand !== "config";
    const flags = pinnable
      ? [
          profile.account && !command.includes("--account") ? `--account ${profile.account}` : "",
          tenant.projectId && !command.includes("--project") ? `--project ${tenant.projectId}` : "",
        ].filter(Boolean)
      : [];

    const suffix = !isGcloud && tenant.projectId ? `  # needs --project_id=${tenant.projectId}` : "";
    return `CLOUDSDK_CONFIG=${profile.root} ${command}${flags.length ? ` ${flags.join(" ")}` : ""}${suffix}`;
  }

  const configuration = tenant[LEGACY_PROFILE_FIELD];
  if (configuration) {
    return `${command} --configuration ${configuration}  # ${LEGACY_FIELD_NOTE}`;
  }

  return `${command}  # no ${PROFILE_FIELD} declared: this would use the shared global config`;
}

export function applyTenantTemplate(command, tenant) {
  const region = tenant.defaultRegion || tenant.regions?.[0] || "REGION";
  const replacements = {
    PROJECT_ID: tenant.projectId || "PROJECT_ID",
    REGION: region,
    ACCOUNT_ID: tenant.accountId || "ACCOUNT_ID",
    PROFILE: tenant.profile || "PROFILE",
    DOCTL_CONTEXT: tenant.doctlContext || "DOCTL_CONTEXT",
    DIGITALOCEAN_PROJECT_ID: tenant.digitalOceanProjectId || "DIGITALOCEAN_PROJECT_ID",
  };

  let resolved = command;
  for (const [token, value] of Object.entries(replacements)) {
    resolved = resolved.replaceAll(token, value);
  }

  // `bq` reads the same credentials as gcloud, so it needs the same root.
  if (tenant.provider === "gcp" && /^(gcloud|bq) /.test(resolved)) {
    resolved = applyGcloudIdentity(resolved, tenant);
  }

  if (tenant.provider === "aws" && tenant.profile && !resolved.includes("--profile ")) {
    resolved = `${resolved} --profile ${tenant.profile}`;
  }

  return resolved;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: options.timeout || DEFAULT_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
    env: options.env || process.env,
  });

  const stdout = (result.stdout || "").trim();
  const stderr = (result.stderr || "").trim();

  return {
    command: [command, ...args].join(" "),
    ok: !result.error && result.status === 0,
    status: result.status,
    stdout,
    stderr,
    missing: result.error?.code === "ENOENT",
    error: result.error?.code || result.error?.message || "",
  };
}

/** A tool that is not installed, or a probe with no target, is not a failure. */
function allOk(checks) {
  return checks.every((check) => check.ok || check.skipped);
}

function summarizeJson(stdout, fallback) {
  if (!stdout) return fallback;
  try {
    const parsed = JSON.parse(stdout);
    if (Array.isArray(parsed)) return `${parsed.length} item(s) returned`;
    return Object.keys(parsed).slice(0, 8).join(", ") || fallback;
  } catch {
    return stdout.split("\n")[0].slice(0, 180);
  }
}

function toolCheck(tool, args) {
  const result = run(tool, args);
  if (result.missing) {
    return {
      name: `${tool} available`,
      ok: false,
      skipped: true,
      summary: "not installed on this workstation: provider checks skipped",
    };
  }
  return {
    name: `${tool} available`,
    ok: result.ok,
    summary: result.ok ? result.stdout.split("\n")[0] : "",
    warning: result.ok ? result.stderr.split("\n")[0] : "",
    error: result.ok ? "" : result.error || result.stderr || "command failed",
  };
}

function commandCheck(name, command, args, summaryFallback, options = {}) {
  const result = run(command, args, options);
  return {
    name,
    ok: result.ok,
    summary: result.ok ? summarizeJson(result.stdout, summaryFallback) : "",
    warning: result.ok ? result.stderr.split("\n")[0] : "",
    error: result.ok ? "" : result.error || result.stderr || "command failed",
  };
}

function gcloudToolChecks() {
  return [
    toolCheck("gcloud", ["--version"]),
    commandCheck(
      "shared global config: active account",
      "gcloud",
      ["auth", "list", "--filter=status:ACTIVE", "--format=json"],
      "active account inspected",
    ),
    commandCheck(
      "shared global config: settings",
      "gcloud",
      ["config", "list", "--format=json"],
      "config inspected",
    ),
  ];
}

/**
 * Every isolated profile is probed with a read-only API call. `auth list`
 * answers from the local store and stays green on a dead refresh token, so it
 * cannot be the check that catches a broken profile: that is exactly how the
 * doctor reported "ok" while a profile could not authenticate.
 */
function profileChecks() {
  return listProfiles().map((profile) => {
    if (!profile.rootExists) {
      return {
        name: `profile ${profile.name}`,
        ok: false,
        summary: "no configuration root",
        error: `missing ${profile.root}. Create it with: CLOUDSDK_CONFIG=${profile.root} gcloud auth login ${profile.account || "<account>"}`,
      };
    }

    const probe = probeProfile(profile);
    return {
      name: `profile ${profile.name}${profile.account ? ` (${profile.account})` : ""}`,
      ok: probe.ok === true,
      skipped: probe.ok === null,
      summary: probe.summary || "",
      warning: probe.stale ? `repair with: ${probe.repair}` : "",
      error: probe.ok === false ? probe.error || "" : "",
    };
  });
}

function gcpDoctor() {
  const checks = [...gcloudToolChecks(), ...profileChecks()];

  return {
    provider: "gcp",
    ok: allOk(checks),
    checks,
  };
}

/**
 * Which root and identity a tenant's gcloud calls must use.
 *
 * `gcloudProfile` selects an isolated root; the legacy `gcloudConfiguration`
 * selects a named configuration inside the shared root. Those are different
 * things: treating the legacy value as a profile silently checks the tenant's
 * project with whatever identity the global config happens to hold.
 */
function tenantGcloudContext(tenant) {
  const projectFlags = tenant.projectId ? ["--project", tenant.projectId] : [];
  const profileName = tenant[PROFILE_FIELD];

  if (profileName) {
    try {
      const profile = requireProfile(profileName);
      return {
        env: profileEnv(profile),
        flags: ["--account", profile.account, ...projectFlags],
        label: `profile ${profile.name}`,
        error: "",
      };
    } catch (error) {
      return {
        env: process.env,
        flags: projectFlags,
        label: `profile ${profileName}`,
        error: error.message,
      };
    }
  }

  const configuration = tenant[LEGACY_PROFILE_FIELD];
  if (configuration) {
    return {
      env: process.env,
      flags: ["--configuration", configuration, ...projectFlags],
      label: `legacy named configuration ${configuration}`,
      note: LEGACY_FIELD_NOTE,
      error: "",
    };
  }

  return { env: process.env, flags: projectFlags, label: "shared global config", error: "" };
}

function gcpTenantDoctor(tenant) {
  const context = tenantGcloudContext(tenant);
  const profileName = tenant[PROFILE_FIELD];

  const projectCheck = context.error
    ? {
        name: `gcloud ${context.label}`,
        ok: false,
        summary: "tenant identity unusable",
        error: context.error,
      }
    : commandCheck(
        `gcp project ${tenant.projectId || "configured"} via ${context.label}`,
        "gcloud",
        [...context.flags, "projects", "describe", tenant.projectId || "", "--format=json"].filter(Boolean),
        "project inspected",
        { env: context.env },
      );

  // Raw gcloud token text reads like a permission error; it is not one.
  if (!projectCheck.ok && !context.error && isStaleToken(projectCheck.error)) {
    projectCheck.summary = "stale credentials";
    projectCheck.error = profileName
      ? `the stored refresh token for this tenant's identity is no longer accepted by Google. Repair with: devo auth repair ${profileName}`
      : "the stored refresh token for this tenant's identity is no longer accepted by Google.";
  }

  const checks = [...gcloudToolChecks(), projectCheck];

  // A tenant may restate the root path. If it disagrees with the registry, the
  // registry wins: say so rather than silently picking one of the two.
  const restatedRoot = tenant.gcloudConfigRoot;
  if (profileName && restatedRoot) {
    const profile = findProfile(profileName);
    if (profile?.root && resolve(restatedRoot) !== resolve(profile.root)) {
      checks.push({
        name: "tenant gcloudConfigRoot matches the profile registry",
        ok: true,
        warning: `tenant declares ${restatedRoot} but profile ${profileName} resolves to ${profile.root}; the registry wins.`,
      });
    }
  }

  if (context.note && !context.error) {
    checks.push({
      name: `tenant field ${LEGACY_PROFILE_FIELD} is legacy`,
      ok: true,
      warning: `${LEGACY_PROFILE_FIELD}: ${context.note}; prefer "${PROFILE_FIELD}".`,
    });
  }

  return {
    provider: "gcp",
    ok: allOk(checks),
    checks,
  };
}

function awsDoctor() {
  const tool = toolCheck("aws", ["--version"]);
  if (tool.skipped) return { provider: "aws", ok: true, checks: [tool] };

  const checks = [
    tool,
    commandCheck(
      "aws caller identity",
      "aws",
      ["sts", "get-caller-identity", "--output", "json"],
      "caller identity inspected",
    ),
    commandCheck("aws configure list", "aws", ["configure", "list"], "configuration inspected"),
  ];

  return {
    provider: "aws",
    ok: allOk(checks),
    checks,
  };
}

function awsTenantDoctor(tenant) {
  const tool = toolCheck("aws", ["--version"]);
  if (tool.skipped) return { provider: "aws", ok: true, checks: [tool] };

  const identityArgs = ["sts", "get-caller-identity", "--output", "json"];
  if (tenant.profile) identityArgs.push("--profile", tenant.profile);

  const checks = [
    tool,
    commandCheck("aws caller identity", "aws", identityArgs, "caller identity inspected"),
    commandCheck("aws configure list", "aws", ["configure", "list"], "configuration inspected"),
  ];

  return {
    provider: "aws",
    ok: allOk(checks),
    checks,
  };
}

function digitalOceanDoctor() {
  const tool = toolCheck("doctl", ["version"]);
  if (tool.skipped) return { provider: "digitalocean", ok: true, checks: [tool] };

  const checks = [
    tool,
    commandCheck("doctl contexts", "doctl", ["auth", "list"], "authentication contexts inspected"),
  ];

  return {
    provider: "digitalocean",
    ok: allOk(checks),
    checks,
  };
}

function digitalOceanTenantDoctor(tenant) {
  const tool = toolCheck("doctl", ["version"]);
  if (tool.skipped) return { provider: "digitalocean", ok: true, checks: [tool] };

  const contextArgs = ["--context", tenant.doctlContext];
  const checks = [
    tool,
    commandCheck(
      `DigitalOcean context ${tenant.doctlContext}`,
      "doctl",
      [...contextArgs, "account", "get", "--output", "json"],
      "account identity inspected",
    ),
    commandCheck(
      "DigitalOcean projects",
      "doctl",
      [...contextArgs, "projects", "list", "--output", "json"],
      "projects inspected",
    ),
  ];

  if (tenant.digitalOceanProjectId) {
    checks.push(
      commandCheck(
        `DigitalOcean project ${tenant.digitalOceanProjectId}`,
        "doctl",
        [...contextArgs, "projects", "get", tenant.digitalOceanProjectId, "--output", "json"],
        "project inspected",
      ),
    );
  }

  return {
    provider: "digitalocean",
    ok: allOk(checks),
    checks,
  };
}

export function runDoctor({ provider = "all", tenantName, configPath } = {}) {
  const resolvedTenant = tenantName ? resolveTenant(tenantName, { configPath }) : null;
  const normalizedProvider = normalizeProvider(provider || resolvedTenant?.tenant.provider);
  const providers = [];

  if (resolvedTenant && normalizedProvider !== "all" && normalizedProvider !== resolvedTenant.tenant.provider) {
    throw new Error(
      `Tenant ${tenantName} is configured for ${resolvedTenant.tenant.provider}, not ${normalizedProvider}.`,
    );
  }

  if (resolvedTenant?.tenant.provider === "gcp") {
    return {
      generatedAt: new Date().toISOString(),
      tenant: resolvedTenant.name,
      configPath: resolvedTenant.configPath,
      warnings: resolvedTenant.warnings,
      providers: [gcpTenantDoctor(resolvedTenant.tenant)],
    };
  }

  if (resolvedTenant?.tenant.provider === "aws") {
    return {
      generatedAt: new Date().toISOString(),
      tenant: resolvedTenant.name,
      configPath: resolvedTenant.configPath,
      warnings: resolvedTenant.warnings,
      providers: [awsTenantDoctor(resolvedTenant.tenant)],
    };
  }

  if (resolvedTenant?.tenant.provider === "digitalocean") {
    return {
      generatedAt: new Date().toISOString(),
      tenant: resolvedTenant.name,
      configPath: resolvedTenant.configPath,
      warnings: resolvedTenant.warnings,
      providers: [digitalOceanTenantDoctor(resolvedTenant.tenant)],
    };
  }

  if (normalizedProvider === "all" || normalizedProvider === "gcp") {
    providers.push(gcpDoctor());
  }

  if (normalizedProvider === "all" || normalizedProvider === "aws") {
    providers.push(awsDoctor());
  }

  if (normalizedProvider === "all" || normalizedProvider === "digitalocean") {
    providers.push(digitalOceanDoctor());
  }

  return {
    generatedAt: new Date().toISOString(),
    providers,
  };
}

function selectedTopics(provider, topic) {
  const catalog = COMMAND_CATALOG[provider];
  if (!catalog) throw new Error(`Unsupported provider for commands: ${provider}`);

  if (!topic || topic === "all") return Object.entries(catalog);
  if (!catalog[topic]) {
    throw new Error(`Unsupported topic: ${topic}. Expected one of: all, ${Object.keys(catalog).join(", ")}`);
  }
  return [[topic, catalog[topic]]];
}

export function printCommandCatalog({ provider, topic = "all", tenantName, configPath }) {
  const resolvedTenant = tenantName ? resolveTenant(tenantName, { configPath }) : null;
  const normalizedProvider = normalizeProvider(provider || resolvedTenant?.tenant.provider);
  if (normalizedProvider === "all") {
    throw new Error("Choose a specific provider for command suggestions: gcp, aws, or digitalocean.");
  }

  if (resolvedTenant && resolvedTenant.tenant.provider !== normalizedProvider) {
    throw new Error(
      `Tenant ${tenantName} is configured for ${resolvedTenant.tenant.provider}, not ${normalizedProvider}.`,
    );
  }

  console.log(`${normalizedProvider.toUpperCase()} ${topic} audit commands`);
  if (resolvedTenant) {
    console.log(
      `Tenant: ${resolvedTenant.name}${resolvedTenant.tenant.projectId ? ` project=${resolvedTenant.tenant.projectId}` : ""}${resolvedTenant.tenant.accountId ? ` account=${resolvedTenant.tenant.accountId}` : ""}`,
    );
    if (normalizedProvider === "gcp") {
      console.log(`Identity: ${tenantGcloudContext(resolvedTenant.tenant).label}`);
    }
    for (const warning of resolvedTenant.warnings || []) {
      console.log(`Warning: ${warning}`);
    }
  }
  console.log("");

  for (const [topicName, commands] of selectedTopics(normalizedProvider, topic)) {
    console.log(`# ${topicName}`);
    for (const command of commands) {
      console.log(resolvedTenant ? applyTenantTemplate(command, resolvedTenant.tenant) : command);
    }
    console.log("");
  }
}
