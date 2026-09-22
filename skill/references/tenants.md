# Tenant Mapping

Use this reference when the user names a client/project alias such as `letzgo` instead of a raw cloud project, account, profile, or region.

## Config Locations

Devo searches for config in this order:

1. `./devo.config.json`
2. the Devo repo root when running from the local repo
3. `~/.devo/config.json`

Use `devo.config.example.json` as the schema example. The real `devo.config.json` is ignored by Git.

## Schema

```json
{
  "version": 1,
  "tenants": {
    "letzgo": {
      "provider": "gcp",
      "projectName": "LETZGO",
      "projectId": "inbound-pattern-489808-h0",
      "projectNumber": "317340568577",
      "gcloudConfiguration": "zonzolab",
      "sourceRoot": "/Users/zencrust/GIT/@zonzolab",
      "regions": ["us-central1"],
      "defaultRegion": "us-central1",
      "artifactRegistryRepo": "letzgo-repo",
      "repositories": ["letzgo-admin", "letzgo-agent", "letzgo-app", "letzgo-be"],
      "services": ["letzgo-agent", "letzgo-agent-worker", "letzgo-be"],
      "labels": {
        "client": "LETZGO"
      },
      "notes": "LETZGO on Google Cloud"
    },
    "acme": {
      "provider": "gcp",
      "projectName": "Acme Staging",
      "projectId": "acme-gstaging",
      "projectNumber": "790098789544",
      "gcloudProfile": "acme",
      "sourceRoot": "/Users/zencrust/GIT/@tessor/acme-datatape-stage-release",
      "regions": ["europe-west4"],
      "defaultRegion": "europe-west4",
      "artifactRegistryRepo": "acme",
      "services": ["acme-api"],
      "labels": {
        "client": "ACME"
      },
      "notes": "Isolated profile acme / human@acme.example. Do not use master/nobrainer."
    },
    "example-aws": {
      "provider": "aws",
      "accountId": "123456789012",
      "profile": "example",
      "regions": ["eu-west-1"],
      "defaultRegion": "eu-west-1"
    },
    "example-digitalocean": {
      "provider": "digitalocean",
      "teamName": "Example Team",
      "doctlContext": "example-team",
      "defaultRegion": "fra",
      "regions": ["fra"],
      "digitalOceanProjectId": "00000000-0000-0000-0000-000000000000"
    }
  }
}
```

## CLI

```bash
devo tenants
devo tenant letzgo
devo doctor --tenant letzgo
devo commands --tenant letzgo services
devo commands --tenant letzgo logs
devo doctor --tenant example-digitalocean
devo commands --tenant example-digitalocean services
```

## Rules

- Resolve tenant aliases before running provider-specific checks.
- State the resolved provider, project/account, and region before querying resources.
- Do not mix logs, costs, resource inventory, or findings across tenants.
- Treat tenant config as operational metadata. Do not store secrets in it.
- Require `doctlContext` for every DigitalOcean tenant and pass it explicitly to all `doctl` account and resource commands.
- Keep DigitalOcean tokens in named `doctl` contexts, never in Devo config.
- For GCP tenants, declare `gcloudProfile`: the name of the isolated identity root. `devo` derives `CLOUDSDK_CONFIG`, the account, and the project guard from the profile registry, and prefixes the suggested commands in `devo commands` with that root. Do not use a different identity profile for a tenant.
- `gcloudConfiguration` is legacy: it names a configuration inside the shared global root, not an isolated identity root. A tenant that still uses it runs gcloud with whatever identity the shared config holds; `devo` warns about it. Prefer `gcloudProfile`.
- `gcloudConfigRoot` may restate the profile's root path. The registry stays the source of truth: if the restated path disagrees, `devo doctor` reports the mismatch instead of silently using one of the two.
