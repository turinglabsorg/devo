# Devo

Devo is a private Turing Labs DevOps specialist for Codex. It gives Codex a consistent way to audit cloud environments, map client aliases to real cloud projects or accounts, inspect service health, compare logs, and review cost signals across GCP, AWS, and DigitalOcean.

The implementation is a Codex skill plus a small Node.js CLI. It deliberately uses the user's existing `gcloud`, `aws`, and `doctl` installations instead of storing cloud credentials or introducing a separate backend service.

## What Devo Does

- Checks local cloud tooling and active authentication.
- Resolves tenant aliases such as `letzgo` to provider, project/account, regions, repositories, and services.
- Produces safe command suggestions for service inventory, logs, costs, IAM, and billing checks.
- Runs read-only readiness checks through `devo doctor`.
- Enforces explicit named `doctl` contexts for DigitalOcean tenants.
- Guides Codex through cloud audits with scoped references for GCP, AWS, DigitalOcean, costs, logs, and tenants.

Devo is read-only by default. It should not create, update, delete, restart, resize, rotate, or deploy cloud resources unless the user explicitly asks for that change.

## Repository

Private GitHub repo:

```text
git@github.com:turinglabsorg/devo.git
```

Local monorepo path:

```text
/Users/zencrust/GIT/@turinglabs/@agentlab/devo
```

## Structure

```text
devo/
├── AGENTS.md                    Repo-specific operating rules
├── README.md                    Human-facing project documentation
├── bin/
│   └── devo                     Local repo wrapper
├── devo.config.example.json     Committed tenant config example
└── skill/
    ├── SKILL.md                 Codex skill entry point
    ├── agents/openai.yaml       Skill UI metadata
    ├── index.js                 CLI entry point
    ├── install.sh               Installer for Codex skill + CLI
    ├── package.json
    ├── hooks/
    │   └── gcloud-guard.sh      PreToolUse guard on Bash calls
    ├── references/
    │   ├── aws.md
    │   ├── costs.md
    │   ├── digitalocean.md
    │   ├── gcp.md
    │   ├── logs.md
    │   └── tenants.md
    ├── scripts/
    │   ├── ambient.mjs          Ambient identity purge
    │   ├── doctor.mjs           Tool/auth/tenant readiness checks
    │   ├── drift.mjs            Installed-copy check behind `doctor --provider install`
    │   ├── exec.mjs             Profile-pinned route for a non-gcloud process
    │   ├── gcloud.mjs           Profile-aware gcloud router
    │   ├── profiles.mjs         Profile registry
    │   └── watch.mjs            Hourly launchd auth-status watchdog
    └── test/                    Node test suites for the above
```

Future scheduled audits, notification bridges, or long-running collectors should live under a future `devo/agent/` boundary. The current version is intentionally interactive and command-driven.

## Install

From the repo:

```bash
cd devo/skill
./install.sh
```

The installer copies:

- CLI runtime to `${CODEX_HOME:-$HOME/.codex}/tools/devo`
- skill files to `${CODEX_HOME:-$HOME/.codex}/skills/devo`
- the PreToolUse guard to `~/.claude/hooks/gcloud-guard.sh`
- config example to `~/.devo/config.example.json`
- executable wrapper to `~/.local/bin/devo`

It also records every copy it wrote, with its digest, in
`${CODEX_HOME:-$HOME/.codex}/tools/devo/INSTALLED.json`, and `devo doctor
--provider install` compares the installed copies against it. An installed copy
edited in place works immediately and diverges silently, so the repository is the
only source: edit under `skill/`, run `./install.sh`, then check.

Ensure `~/.local/bin` is in `PATH`. On this workstation it is configured in `~/.zshenv`, so non-interactive shells can run `devo` directly.

Use a custom binary directory if needed:

```bash
DEVO_BIN_DIR="$HOME/bin" ./install.sh
```

## Configuration

Real tenant configuration lives outside the repo:

```text
~/.devo/config.json
```

Local development can also use:

```text
./devo.config.json
```

`devo.config.json` is ignored by Git. Do not commit real tenant config if it contains operational metadata that should remain local. Never store secrets, access tokens, service account keys, passwords, or cloud credentials in Devo config.

DigitalOcean credentials live in persistent named `doctl` contexts. Devo stores only the context name:

```json
{
  "provider": "digitalocean",
  "teamName": "Example Team",
  "doctlContext": "example-team",
  "defaultRegion": "fra"
}
```

Config lookup order:

1. `./devo.config.json`
2. `devo/devo.config.json` when running from this repo
3. `~/.devo/config.json`

Use [`devo.config.example.json`](./devo.config.example.json) as the schema reference.

## Tenant Example

`letzgo` is configured as a GCP tenant:

```json
{
  "provider": "gcp",
  "projectName": "LETZGO",
  "projectId": "inbound-pattern-489808-h0",
  "projectNumber": "317340568577",
  "gcloudConfiguration": "zonzolab",
  "sourceRoot": "/Users/zencrust/GIT/@zonzolab",
  "regions": ["us-central1"],
  "defaultRegion": "us-central1",
  "artifactRegistryRepo": "letzgo-repo"
}
```

This lets Codex or an operator ask for `letzgo` instead of repeating the raw project ID, region, service list, and source root every time.

## CLI Usage

```bash
devo tenants
devo tenant letzgo
devo doctor --tenant letzgo
devo doctor --provider all
devo commands --tenant letzgo services
devo commands --tenant letzgo logs
devo commands gcp costs
devo commands aws costs
devo doctor --tenant example-digitalocean
devo commands digitalocean services
```

When working from the repo without installing:

```bash
./bin/devo doctor --tenant letzgo
node skill/index.js doctor --tenant letzgo
```

## Typical Workflows

### Verify Local Cloud Readiness

```bash
devo doctor --tenant letzgo
```

This checks whether `gcloud` or `aws` are available, whether the active account is visible, and whether the configured tenant project/account is reachable.

### Inspect GCP Services

```bash
devo commands --tenant letzgo services
```

Then run the suggested provider commands with explicit `--project` and `--region` flags. Do not rely on global defaults for audit conclusions.

### Inspect DigitalOcean Services

```bash
devo doctor --tenant example-digitalocean
devo commands --tenant example-digitalocean services
```

Every generated resource command includes the tenant's named `doctl` context. Never rely on whichever DigitalOcean context happens to be globally active.

### Review Logs

```bash
devo commands --tenant letzgo logs
```

Use concrete time windows and summarize log groups by service, severity, first/latest occurrence, and repeated signature. Avoid dumping full log payloads unless explicitly requested.

### Review Costs

```bash
devo commands --tenant letzgo costs
```

Cost reviews should label numbers as estimated, forecasted, or historical invoiced spend. If BigQuery Billing Export exists, query it directly and group by service, SKU, project, location, labels, and day.

## Safety Rules

- State provider, project/account, region, services, and time window before interpreting findings.
- Keep tenant contexts isolated. Do not mix costs, logs, services, repos, or recommendations across clients.
- Never print secrets, access tokens, private keys, full environment dumps, or service account key contents.
- Prefer read-only commands first.
- Prefer explicit flags such as `--project inbound-pattern-489808-h0` over changing global CLI config.
- For GCP, use local authenticated `gcloud`.
- For AWS, verify `aws sts get-caller-identity` before querying resources.
- For DigitalOcean, require a tenant-scoped `doctlContext` and pass `--context` on every account or resource command.
- Treat billing and cost numbers carefully: do not compare estimated, forecasted, and invoiced values without naming the basis.

## Development

The skill runtime has no third-party production dependencies.

```bash
cd devo/skill
npm run check
npm test
```

Validate shell installer syntax:

```bash
bash -n install.sh
```

Validate the installed command after running `install.sh`:

```bash
command -v devo
devo tenant letzgo
devo doctor --tenant letzgo
```

## Current Status

- Repo is private under `turinglabsorg/devo`.
- Installed skill path: `~/.codex/skills/devo`.
- Installed CLI wrapper: `~/.local/bin/devo`.
- Canonical config directory: `~/.devo/`.
- `letzgo` tenant is configured for GCP project `inbound-pattern-489808-h0`.
- DigitalOcean tenants use isolated persistent `doctl` contexts without embedding tokens in Devo config.
