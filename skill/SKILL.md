---
name: devo
description: DevOps specialist for auditing GCP, AWS, and DigitalOcean environments with isolated tenant contexts. Use when the user asks to verify gcloud, AWS, or doctl configuration; inspect cloud services; compare logs; review costs; check cloud health; investigate incidents; audit IAM, billing, or service state; deploy explicitly requested changes; or produce a cloud operations report.
---

# Devo

Devo is a cloud operations specialist for GCP, AWS, and DigitalOcean. It helps Codex inspect cloud state, compare logs, verify costs, and explain operational risks while staying read-only by default.

## Core Workflow

1. Define scope: provider, account or project, region, services, and time window.
2. Run local readiness checks with the Devo CLI when useful:

```bash
devo doctor --provider all
devo doctor --tenant letzgo
```

When working from the repo without installing:

```bash
node devo/skill/index.js doctor --provider all
```

3. Load only the reference needed for the task:
   - GCP or `gcloud`: read `references/gcp.md`.
   - AWS: read `references/aws.md`.
   - DigitalOcean or `doctl`: read `references/digitalocean.md`.
   - Cost or billing review: read `references/costs.md`.
   - Log comparison or incident review: read `references/logs.md`.
   - Tenant/client mapping: read `references/tenants.md`.
4. Run provider commands with explicit project/profile/region flags. For GCP, resolve the `master` or `nobrainer` identity profile from `references/gcp.md` and set its `CLOUDSDK_CONFIG` on every CLI, proxy, or local application process; never depend on the globally active gcloud configuration.
5. Report findings as facts, evidence, risk, and next action. Include command summaries, not raw credential-like output.

## Safety Rules

- Stay read-only unless the user explicitly requests a change.
- Never print secrets, access tokens, private keys, full environment dumps, or service account key contents.
- Never store gcloud credential databases, ADC JSON, OAuth tokens, cookies, or exported credentials in this skill, a repository, tenant metadata, or generated documentation. The skill stores only profile names, account identifiers, and paths; gcloud owns the credential files inside each isolated profile directory.
- Confirm the active cloud identity before interpreting service state or costs.
- Do not change global CLI defaults unless the user explicitly asks.
- Keep tenant/client contexts isolated. Do not mix costs, logs, service state, or recommendations across tenants.
- For cost investigations, label values as estimated, forecasted, or invoiced.

## CLI

```bash
devo doctor --provider all
devo tenants
devo tenant letzgo
devo doctor --tenant letzgo
devo commands --tenant letzgo services
devo doctor --provider gcp --json
devo commands gcp logs
devo commands aws costs
devo doctor --tenant zonzo
devo commands digitalocean services
```

Use `doctor` for local tool/auth/config readiness. Use `commands` to print non-destructive audit command suggestions for a provider and topic.
