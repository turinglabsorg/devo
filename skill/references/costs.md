# Cost Review

Use this reference for GCP Billing, AWS Cost Explorer, budgets, forecasts, and spend anomaly investigations.

## Label Cost Type

Always label the number:

- Estimated current-month spend
- Forecasted spend
- Historical invoiced spend
- Unblended, blended, amortized, or net cost

Do not compare numbers with different cost bases without saying so.

## GCP

Start with billing account attachment:

```bash
gcloud billing projects describe PROJECT_ID
gcloud billing accounts list
```

If Cloud Billing export to BigQuery exists, query it directly:

```bash
bq query --use_legacy_sql=false '
SELECT
  service.description AS service,
  sku.description AS sku,
  SUM(cost) AS cost
FROM `BILLING_EXPORT_TABLE`
WHERE usage_start_time >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 30 DAY)
GROUP BY service, sku
ORDER BY cost DESC
LIMIT 30'
```

Useful groupings:

- Service
- SKU
- Project ID
- Labels
- Day
- Location

## AWS

Cost Explorer examples:

```bash
aws ce get-cost-and-usage --time-period Start=YYYY-MM-01,End=YYYY-MM-DD --granularity DAILY --metrics UnblendedCost --group-by Type=DIMENSION,Key=SERVICE --output json
aws ce get-cost-and-usage --time-period Start=YYYY-MM-01,End=YYYY-MM-DD --granularity MONTHLY --metrics UnblendedCost --group-by Type=DIMENSION,Key=REGION --output json
aws ce get-cost-forecast --time-period Start=YYYY-MM-DD,End=YYYY-MM-DD --metric UNBLENDED_COST --granularity MONTHLY --output json
```

Budgets:

```bash
aws budgets describe-budgets --account-id ACCOUNT_ID --output json
```

## Investigation Pattern

1. Establish baseline period and comparison period.
2. Break spend down by service, SKU or usage type, region, and project/account.
3. Identify the first day of change.
4. Correlate with deploys, traffic, logs, autoscaling, data transfer, storage growth, and backup retention.
5. Separate one-time charges from recurring run-rate changes.

## Red Flags

- Spend concentrated in unknown regions.
- Data transfer or NAT gateway charges growing unexpectedly.
- Idle load balancers, disks, snapshots, IPs, or databases.
- Untagged resources in shared accounts.
- Forecast materially above budget with no known launch or traffic event.
