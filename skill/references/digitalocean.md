# DigitalOcean Operations

Use this reference for DigitalOcean, App Platform, Droplets, managed databases, Kubernetes, DNS, billing, or `doctl` work.

## Scope and identity

Resolve a tenant before querying resources. Every DigitalOcean tenant must define a persistent `doctlContext`; `teamName`, `defaultRegion`, and `digitalOceanProjectId` are optional operational metadata.

```bash
devo tenant zonzo
devo doctor --tenant zonzo
devo commands --tenant zonzo identity
```

Pass the tenant context explicitly on every provider command:

```bash
doctl --context zonzo account get --output json
doctl --context zonzo projects list --output json
```

Never infer tenant identity from the globally active `doctl` context.

## Credentials

Persist credentials with a named context:

```bash
doctl auth init --context zonzo
```

Store the token only in `doctl` configuration. Never put access tokens in Devo config, repositories, command catalogs, logs, screenshots, or chat output. Remove temporary plaintext token files immediately after a successful import.

## Read-only inventory

Start with Devo's scoped catalog:

```bash
devo commands --tenant zonzo services
```

Typical inventory covers projects, App Platform apps, Droplets, managed databases, and Kubernetes clusters. Confirm project IDs and app IDs before interpreting logs or costs.

## App Platform

For an explicitly authorized deployment:

1. Verify the tenant with `devo doctor --tenant TENANT`.
2. Validate the app spec with `doctl --context CONTEXT apps spec validate SPEC`.
3. Check for an existing app with `doctl --context CONTEXT apps list --output json`.
4. Create or update with the same explicit context and project ID.
5. Wait for deployment completion, inspect build/runtime logs, and verify the public URL.

Do not create resources in a generic or similarly named team when the requested tenant context is missing.

## Logs and incidents

List apps first, then retrieve bounded logs for an exact app and component:

```bash
doctl --context CONTEXT apps logs APP_ID COMPONENT --type run --tail 100
```

Use a concrete deployment, component, and time window when comparing incidents. Do not dump unbounded logs or credential-bearing environment output.

## Costs and billing

Use `balance get` for current balance state and `billing-history list` for historical transactions. Label results as current balance or historical billing; do not describe them as a forecast unless a separate forecast source exists.

## DNS

Check authoritative nameservers before changing records. A domain can point to DigitalOcean while remaining managed by another registrar. Only mutate DNS when the user has authorized it and the exact zone and record target are confirmed.
