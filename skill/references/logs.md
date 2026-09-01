# Log Review And Comparison

Use this reference for incident review, GCP/AWS log comparison, error analysis, and timeline reconstruction.

## Minimum Scope

Require or infer:

- Provider and account/project
- Service names
- Region
- Start and end time
- Expected behavior
- Known request IDs, trace IDs, user IDs, deployment versions, or job IDs

If the user gives a vague time such as "today", convert it to an exact date and timezone before querying.

## Collection

GCP:

```bash
CLOUDSDK_CONFIG=PROFILE_ROOT gcloud --account=ACCOUNT --project=PROJECT_ID logging read 'severity>=ERROR' --freshness=24h --limit=100 --format=json
CLOUDSDK_CONFIG=PROFILE_ROOT gcloud --account=ACCOUNT --project=PROJECT_ID logging read 'resource.labels.service_name="SERVICE" AND timestamp>="START_ISO" AND timestamp<="END_ISO"' --limit=500 --format=json
```

AWS:

```bash
aws logs filter-log-events --log-group-name LOG_GROUP --start-time START_MS --end-time END_MS --region REGION --output json
```

Save large raw outputs under `/tmp/devo-logs-*` when needed, then summarize only the relevant findings to the user.

## Normalization

Compare logs using these fields when available:

- Timestamp in UTC and local timezone
- Provider, account/project, region
- Service and resource ID
- Severity
- Message
- Trace ID, request ID, correlation ID
- Deployment version, revision, image digest, commit SHA
- User or tenant ID if safe to display

## Analysis Pattern

1. Build a timeline ordered by timestamp.
2. Group repeated errors by signature, not by full message.
3. Identify first occurrence, peak frequency, and last occurrence.
4. Compare the timeline to deploys, autoscaling events, config changes, quota events, and billing anomalies.
5. Separate symptoms from likely root cause.

## Reporting

Report:

- Time window searched
- Commands or filters used
- Top error groups with counts
- First and latest occurrence
- A short incident hypothesis
- Next verification step

Avoid dumping full log payloads unless the user explicitly asks.
