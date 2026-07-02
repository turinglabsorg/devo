# Devo

Devo is a DevOps-focused Codex skill for auditing GCP and AWS environments. It helps verify local cloud tooling, active accounts/projects, service inventory, logs, costs, and operational risk without changing infrastructure by default.

It supports tenant/project mapping through a local `devo.config.json`, so a client alias such as `letzgo` can resolve to a specific provider, GCP project, AWS account, profile, and region.

## Proposed Structure

```
devo/
├── AGENTS.md
├── devo.config.example.json
├── README.md
└── skill/
    ├── SKILL.md
    ├── agents/
    │   └── openai.yaml
    ├── index.js
    ├── install.sh
    ├── package.json
    ├── references/
    │   ├── aws.md
    │   ├── costs.md
    │   ├── gcp.md
    │   ├── logs.md
    │   └── tenants.md
    └── scripts/
        └── doctor.mjs
```

Future scheduled audits, notification bridges, or long-running collectors should live under `devo/agent/`. The first version starts as a Codex skill because the current workflow is interactive investigation and command-driven diagnostics.

## Local Usage

```bash
./bin/devo doctor --provider all
./bin/devo tenants
./bin/devo tenant letzgo
./bin/devo doctor --tenant letzgo
./bin/devo commands --tenant letzgo services
./bin/devo commands gcp logs
./bin/devo commands aws costs
```

## Tenant Config

Local config lookup order:

1. `./devo.config.json`
2. `devo/devo.config.json` when running from this repo
3. `~/.config/devo/config.json`

`devo.config.json` is intentionally ignored by Git. Use [devo.config.example.json](./devo.config.example.json) as the committed schema/example.

## Install

```bash
cd devo/skill
./install.sh
```

The installer copies the CLI to `${CODEX_HOME:-$HOME/.codex}/tools/devo`, the skill resources to `${CODEX_HOME:-$HOME/.codex}/skills/devo`, and the config example to `~/.config/devo/config.example.json`.

It also creates a `devo` command in `~/.local/bin/devo` by default:

```bash
devo tenants
devo doctor --tenant letzgo
devo commands --tenant letzgo services
```

Set `DEVO_BIN_DIR` before running the installer to choose another binary directory.
