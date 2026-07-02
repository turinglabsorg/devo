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

## Identity And Configuration

```bash
gcloud auth list --filter=status:ACTIVE --format=json
gcloud config list --format=json
gcloud projects describe PROJECT_ID --format=json
gcloud billing projects describe PROJECT_ID
```

## Service Inventory

```bash
gcloud services list --enabled --project PROJECT_ID
gcloud run services list --project PROJECT_ID --region REGION
gcloud compute instances list --project PROJECT_ID
gcloud container clusters list --project PROJECT_ID
gcloud sql instances list --project PROJECT_ID
gcloud app services list --project PROJECT_ID
gcloud scheduler jobs list --project PROJECT_ID --location REGION
gcloud pubsub topics list --project PROJECT_ID
```

## IAM And Secrets Surface

List names and bindings only. Do not print secret payloads or service account key contents.

```bash
gcloud projects get-iam-policy PROJECT_ID --format=json
gcloud iam service-accounts list --project PROJECT_ID
gcloud iam service-accounts keys list --iam-account SERVICE_ACCOUNT_EMAIL --project PROJECT_ID
gcloud secrets list --project PROJECT_ID
```

Red flags:

- User-managed service account keys older than the rotation policy.
- Broad primitive roles such as Owner or Editor granted to users or default service accounts.
- Enabled APIs without matching active services.
- Public ingress on services expected to be internal.

## Cloud Run Checks

```bash
gcloud run services describe SERVICE --project PROJECT_ID --region REGION --format=json
gcloud run revisions list --service SERVICE --project PROJECT_ID --region REGION
gcloud run services get-iam-policy SERVICE --project PROJECT_ID --region REGION --format=json
```

Check ingress, authentication, min/max instances, CPU/memory, container image digest, environment variable names, and recent revision rollout.

## Logs

Use narrow filters and explicit freshness:

```bash
gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="SERVICE"' --project PROJECT_ID --freshness=1h --limit=100 --format=json
gcloud logging read 'severity>=ERROR' --project PROJECT_ID --freshness=24h --limit=100 --format=json
```

For cross-service investigations, load `references/logs.md`.

## Costs

Start with billing attachment, then use Billing Export to BigQuery when available:

```bash
gcloud billing accounts list
gcloud billing projects describe PROJECT_ID
```

For deeper cost analysis, load `references/costs.md`.
