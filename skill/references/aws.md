# AWS Audit Reference

Use this reference when the task involves AWS CLI configuration, AWS service inventory, CloudWatch logs, IAM, Cost Explorer, accounts, or regions.

## Scope First

Always identify:

- AWS account ID
- Active profile
- Region
- Target service
- Time window for logs and costs

Confirm identity before interpreting output:

```bash
aws sts get-caller-identity --output json
aws configure list
aws configure list-profiles
```

Use `--profile PROFILE` and `--region REGION` when the user names them.

## Regional Inventory

```bash
aws ec2 describe-regions --all-regions --output json
aws ec2 describe-instances --region REGION --output json
aws ecs list-clusters --region REGION --output json
aws eks list-clusters --region REGION --output json
aws lambda list-functions --region REGION --output json
aws rds describe-db-instances --region REGION --output json
aws elbv2 describe-load-balancers --region REGION --output json
aws logs describe-log-groups --region REGION --output json
```

For broad resource discovery, prefer Resource Groups Tagging API when the account supports it:

```bash
aws resourcegroupstaggingapi get-resources --region REGION --output json
```

## Global Inventory

```bash
aws s3api list-buckets --output json
aws iam get-account-summary --output json
aws iam list-account-aliases --output json
aws iam list-users --output json
aws iam list-roles --output json
```

Do not print access keys or secret values. If reviewing access keys, list metadata only:

```bash
aws iam list-access-keys --user-name USER --output json
```

## Logs

```bash
aws logs describe-log-groups --region REGION --output json
aws logs filter-log-events --log-group-name LOG_GROUP --start-time START_MS --end-time END_MS --region REGION --output json
```

Use epoch milliseconds for `--start-time` and `--end-time`. For log comparison workflow, load `references/logs.md`.

## Costs

Cost Explorer is global and usually requires payer or billing permissions:

```bash
aws ce get-cost-and-usage --time-period Start=YYYY-MM-01,End=YYYY-MM-DD --granularity MONTHLY --metrics UnblendedCost --group-by Type=DIMENSION,Key=SERVICE --output json
aws ce get-cost-forecast --time-period Start=YYYY-MM-DD,End=YYYY-MM-DD --metric UNBLENDED_COST --granularity MONTHLY --output json
aws budgets describe-budgets --account-id ACCOUNT_ID --output json
```

For deeper cost analysis, load `references/costs.md`.

## Red Flags

- Unknown active account or profile.
- Resources spread across unexpected regions.
- Public S3 buckets, public load balancers, or open security groups on sensitive services.
- IAM users with active long-lived access keys and no recent rotation.
- Expensive services with no tags or no owner.
