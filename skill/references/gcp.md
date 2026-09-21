# GCP Audit Reference

Use this reference when the task involves GCP, `gcloud`, Cloud Run, GKE, Compute Engine, Cloud SQL, Cloud Logging, IAM, billing, or service inventory.

## Scope First

Always identify:

- Project ID
- Active account
- Region or multi-region scope
- Target service
- Time window for logs and metrics

Prefer explicit `--project PROJECT_ID` flags. Do not change global `gcloud config` unless requested.

## Local Identity Profiles

This workstation uses fully isolated gcloud roots. Treat these names as identity profiles, not ordinary named configurations:

| Profile | Account | Configuration root | Use |
| --- | --- | --- | --- |
| `master` | `sebastiano.cataudo@gmail.com` | `/Users/zencrust/.config/gcloud-profiles/master` | Default for PrismaNews and general GCP operations unless the user explicitly selects another identity. |
| `nobrainer` | `seer@nobraineragency.com` | `/Users/zencrust/.config/gcloud-profiles/nobrainer` | Operations explicitly associated with the Nobrainer identity or a project confirmed to require it. |
| `credilex` | `seba@credilex.it` | `/Users/zencrust/.config/gcloud-profiles/credilex` | Credilex GCP only. Isolated defaults: account `seba@credilex.it`, project `credilex-gstaging`. Credentials stay in this root (`credentials.db`); never log in to the global `ragusa` config for Credilex. Also visible: `linear-analyst-493018-u6`. Never use `master` or `nobrainer` for Credilex. |

Set `CLOUDSDK_CONFIG` on every gcloud invocation. Also pass the account, project, and region explicitly when supported:

```bash
CLOUDSDK_CONFIG=/Users/zencrust/.config/gcloud-profiles/master \
  gcloud --account=sebastiano.cataudo@gmail.com \
  --project=PROJECT_ID COMMAND
```

```bash
CLOUDSDK_CONFIG=/Users/zencrust/.config/gcloud-profiles/nobrainer \
  gcloud --account=seer@nobraineragency.com \
  --project=PROJECT_ID COMMAND
```

```bash
CLOUDSDK_CONFIG=/Users/zencrust/.config/gcloud-profiles/credilex \
  gcloud --account=seba@credilex.it \
  --project=credilex-gstaging COMMAND
```

The same environment prefix is mandatory for Cloud SQL Auth Proxy, client libraries, Terraform/OpenTofu helpers, scripts that invoke gcloud, and any other process that consumes Application Default Credentials. A process without the prefix may silently use the unrelated global ADC file.

## Route Calls Through The Router

Writing the prefix by hand is where this goes wrong: an unprefixed gcloud call
does not fail, it uses the shared global config and whatever account is active
there, and the resulting `PERMISSION_DENIED` reads like a real permission
problem. Use the router, which derives the root, the account and the project
from the registry in `scripts/profiles.mjs`:

```bash
devo profiles
devo gcloud --profile credilex --project credilex-gprod -- run services list --region europe-west8
devo gcloud --profile credilex -- run services describe credilex-api --region europe-west8
```

- `--profile` is mandatory; omitting it is an error, never a fallback.
- A project that belongs to another profile's scope is refused, even when the
  calling profile declares no patterns of its own.
- Mutating `auth`/`config` subcommands are refused unless `--allow-mutation` is
  passed; a credential repair goes through `devo auth repair <profile>`.
- A dead refresh token is rewritten into the exact repair command instead of the
  raw gcloud text.
- `--tty` hands the terminal to gcloud, for commands that prompt.

A PreToolUse hook (`~/.claude/hooks/gcloud-guard.sh`) denies an unprefixed
`gcloud auth login`, `gcloud config configurations activate`, `--update-adc`,
and any read of a credential store, for the agent's Bash calls.

Prefer `devo gcloud` for audit commands. Use the raw `CLOUDSDK_CONFIG` form below
when a non-gcloud process needs the same root (proxy, Terraform, scripts) or when
explaining the prefix to the user.

### Bootstrap Or Repair

Authentication is an external mutation and may open a browser. Run these commands only when the user explicitly asks to authenticate or repair a profile. Never run bare `gcloud auth login`, never activate a shared global configuration, and never use `--update-adc`.

Preferred form, which resolves the root and the account from the registry:

```bash
devo auth repair credilex
devo auth repair master
devo auth repair nobrainer
```

Expanded, for the gcloud CLI credential store:

```bash
CLOUDSDK_CONFIG=/Users/zencrust/.config/gcloud-profiles/master \
  gcloud auth login sebastiano.cataudo@gmail.com
```

```bash
CLOUDSDK_CONFIG=/Users/zencrust/.config/gcloud-profiles/nobrainer \
  gcloud auth login seer@nobraineragency.com
```

```bash
CLOUDSDK_CONFIG=/Users/zencrust/.config/gcloud-profiles/credilex \
  gcloud auth login seba@credilex.it
```

Only when the target command uses ADC, initialize the matching ADC file separately:

```bash
CLOUDSDK_CONFIG=/Users/zencrust/.config/gcloud-profiles/master \
  gcloud auth application-default login sebastiano.cataudo@gmail.com
```

```bash
CLOUDSDK_CONFIG=/Users/zencrust/.config/gcloud-profiles/nobrainer \
  gcloud auth application-default login seer@nobraineragency.com
```

```bash
CLOUDSDK_CONFIG=/Users/zencrust/.config/gcloud-profiles/credilex \
  gcloud auth application-default login seba@credilex.it
```

Credential files remain inside the corresponding configuration root and must never be read, printed, copied into this skill, or committed. Validate a profile with a read-only API call, not with `gcloud auth list`: `auth list` answers from the local store and reports green on a dead token.

```bash
devo profiles --probe
```

Do not print access tokens or ADC contents.

If a command returns `PERMISSION_DENIED`, first verify that the selected profile matches the intended client/project. Do not fall back to the other profile unless project ownership is confirmed; this prevents cross-client access and misleading audit results.

## Identity And Configuration

Replace `PROFILE_ROOT`, `ACCOUNT`, `PROJECT_ID`, and `REGION` with the selected profile values and target scope.

```bash
CLOUDSDK_CONFIG=PROFILE_ROOT gcloud auth list --filter=status:ACTIVE --format=json
CLOUDSDK_CONFIG=PROFILE_ROOT gcloud config list --format=json
CLOUDSDK_CONFIG=PROFILE_ROOT gcloud --account=ACCOUNT --project=PROJECT_ID projects describe PROJECT_ID --format=json
CLOUDSDK_CONFIG=PROFILE_ROOT gcloud --account=ACCOUNT --project=PROJECT_ID billing projects describe PROJECT_ID
```

## Service Inventory

```bash
CLOUDSDK_CONFIG=PROFILE_ROOT gcloud --account=ACCOUNT --project=PROJECT_ID services list --enabled
CLOUDSDK_CONFIG=PROFILE_ROOT gcloud --account=ACCOUNT --project=PROJECT_ID run services list --region=REGION
CLOUDSDK_CONFIG=PROFILE_ROOT gcloud --account=ACCOUNT --project=PROJECT_ID compute instances list
CLOUDSDK_CONFIG=PROFILE_ROOT gcloud --account=ACCOUNT --project=PROJECT_ID container clusters list
CLOUDSDK_CONFIG=PROFILE_ROOT gcloud --account=ACCOUNT --project=PROJECT_ID sql instances list
CLOUDSDK_CONFIG=PROFILE_ROOT gcloud --account=ACCOUNT --project=PROJECT_ID app services list
CLOUDSDK_CONFIG=PROFILE_ROOT gcloud --account=ACCOUNT --project=PROJECT_ID scheduler jobs list --location=REGION
CLOUDSDK_CONFIG=PROFILE_ROOT gcloud --account=ACCOUNT --project=PROJECT_ID pubsub topics list
```

## IAM And Secrets Surface

List names and bindings only. Do not print secret payloads or service account key contents.

```bash
CLOUDSDK_CONFIG=PROFILE_ROOT gcloud --account=ACCOUNT --project=PROJECT_ID projects get-iam-policy PROJECT_ID --format=json
CLOUDSDK_CONFIG=PROFILE_ROOT gcloud --account=ACCOUNT --project=PROJECT_ID iam service-accounts list
CLOUDSDK_CONFIG=PROFILE_ROOT gcloud --account=ACCOUNT --project=PROJECT_ID iam service-accounts keys list --iam-account=SERVICE_ACCOUNT_EMAIL
CLOUDSDK_CONFIG=PROFILE_ROOT gcloud --account=ACCOUNT --project=PROJECT_ID secrets list
```

Red flags:

- User-managed service account keys older than the rotation policy.
- Broad primitive roles such as Owner or Editor granted to users or default service accounts.
- Enabled APIs without matching active services.
- Public ingress on services expected to be internal.

## Cloud Run Checks

```bash
CLOUDSDK_CONFIG=PROFILE_ROOT gcloud --account=ACCOUNT --project=PROJECT_ID run services describe SERVICE --region=REGION --format=json
CLOUDSDK_CONFIG=PROFILE_ROOT gcloud --account=ACCOUNT --project=PROJECT_ID run revisions list --service=SERVICE --region=REGION
CLOUDSDK_CONFIG=PROFILE_ROOT gcloud --account=ACCOUNT --project=PROJECT_ID run services get-iam-policy SERVICE --region=REGION --format=json
```

Check ingress, authentication, min/max instances, CPU/memory, container image digest, environment variable names, and recent revision rollout.

## Logs

Use narrow filters and explicit freshness:

```bash
CLOUDSDK_CONFIG=PROFILE_ROOT gcloud --account=ACCOUNT --project=PROJECT_ID logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="SERVICE"' --freshness=1h --limit=100 --format=json
CLOUDSDK_CONFIG=PROFILE_ROOT gcloud --account=ACCOUNT --project=PROJECT_ID logging read 'severity>=ERROR' --freshness=24h --limit=100 --format=json
```

For cross-service investigations, load `references/logs.md`.

## Costs

Start with billing attachment, then use Billing Export to BigQuery when available:

```bash
CLOUDSDK_CONFIG=PROFILE_ROOT gcloud --account=ACCOUNT billing accounts list
CLOUDSDK_CONFIG=PROFILE_ROOT gcloud --account=ACCOUNT --project=PROJECT_ID billing projects describe PROJECT_ID
```

For deeper cost analysis, load `references/costs.md`.
