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
    "example-aws": {
      "provider": "aws",
      "accountId": "123456789012",
      "profile": "example",
      "regions": ["eu-west-1"],
      "defaultRegion": "eu-west-1"
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
```

## Rules

- Resolve tenant aliases before running provider-specific checks.
- State the resolved provider, project/account, and region before querying resources.
- Do not mix logs, costs, resource inventory, or findings across tenants.
- Treat tenant config as operational metadata. Do not store secrets in it.
