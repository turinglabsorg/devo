import { spawnSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

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
};

const DEFAULT_CONFIG_PATHS = [
  resolve(process.cwd(), "devo.config.json"),
  resolve(REPO_DIR, "devo.config.json"),
  join(process.env.HOME || "", ".devo", "config.json"),
].filter(Boolean);

export function normalizeProvider(provider) {
  const value = String(provider || "all").toLowerCase();
  if (["all", "gcp", "aws"].includes(value)) return value;
  throw new Error(`Unsupported provider: ${provider}. Expected all, gcp, or aws.`);
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

  return {
    configPath: loaded.path,
    name,
    tenant: {
      ...tenant,
      provider: normalizeProvider(tenant.provider),
    },
  };
}

function applyTenantTemplate(command, tenant) {
  const region = tenant.defaultRegion || tenant.regions?.[0] || "REGION";
  const replacements = {
    PROJECT_ID: tenant.projectId || "PROJECT_ID",
    REGION: region,
    ACCOUNT_ID: tenant.accountId || "ACCOUNT_ID",
    PROFILE: tenant.profile || "PROFILE",
  };

  let resolved = command;
  for (const [token, value] of Object.entries(replacements)) {
    resolved = resolved.replaceAll(token, value);
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
  });

  const stdout = (result.stdout || "").trim();
  const stderr = (result.stderr || "").trim();

  return {
    command: [command, ...args].join(" "),
    ok: !result.error && result.status === 0,
    status: result.status,
    stdout,
    stderr,
    error: result.error?.code || result.error?.message || "",
  };
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
  return {
    name: `${tool} available`,
    ok: result.ok,
    summary: result.ok ? result.stdout.split("\n")[0] : "",
    warning: result.ok ? result.stderr.split("\n")[0] : "",
    error: result.ok ? "" : result.error || result.stderr || "command failed",
  };
}

function commandCheck(name, command, args, summaryFallback) {
  const result = run(command, args);
  return {
    name,
    ok: result.ok,
    summary: result.ok ? summarizeJson(result.stdout, summaryFallback) : "",
    warning: result.ok ? result.stderr.split("\n")[0] : "",
    error: result.ok ? "" : result.error || result.stderr || "command failed",
  };
}

function gcpDoctor() {
  const checks = [
    toolCheck("gcloud", ["--version"]),
    commandCheck(
      "active gcloud account",
      "gcloud",
      ["auth", "list", "--filter=status:ACTIVE", "--format=json"],
      "active account inspected",
    ),
    commandCheck(
      "gcloud config",
      "gcloud",
      ["config", "list", "--format=json"],
      "config inspected",
    ),
  ];

  return {
    provider: "gcp",
    ok: checks.every((check) => check.ok),
    checks,
  };
}

function gcpTenantDoctor(tenant) {
  const checks = [
    ...gcpDoctor().checks,
    commandCheck(
      `gcp project ${tenant.projectId || "configured"}`,
      "gcloud",
      ["projects", "describe", tenant.projectId || "", "--format=json"].filter(Boolean),
      "project inspected",
    ),
  ];

  return {
    provider: "gcp",
    ok: checks.every((check) => check.ok),
    checks,
  };
}

function awsDoctor() {
  const checks = [
    toolCheck("aws", ["--version"]),
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
    ok: checks.every((check) => check.ok),
    checks,
  };
}

function awsTenantDoctor(tenant) {
  const identityArgs = ["sts", "get-caller-identity", "--output", "json"];
  if (tenant.profile) identityArgs.push("--profile", tenant.profile);

  const checks = [
    toolCheck("aws", ["--version"]),
    commandCheck("aws caller identity", "aws", identityArgs, "caller identity inspected"),
    commandCheck("aws configure list", "aws", ["configure", "list"], "configuration inspected"),
  ];

  return {
    provider: "aws",
    ok: checks.every((check) => check.ok),
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
      providers: [gcpTenantDoctor(resolvedTenant.tenant)],
    };
  }

  if (resolvedTenant?.tenant.provider === "aws") {
    return {
      generatedAt: new Date().toISOString(),
      tenant: resolvedTenant.name,
      configPath: resolvedTenant.configPath,
      providers: [awsTenantDoctor(resolvedTenant.tenant)],
    };
  }

  if (normalizedProvider === "all" || normalizedProvider === "gcp") {
    providers.push(gcpDoctor());
  }

  if (normalizedProvider === "all" || normalizedProvider === "aws") {
    providers.push(awsDoctor());
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
    throw new Error("Choose a specific provider for command suggestions: gcp or aws.");
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
