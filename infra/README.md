# infra/ — GoldenHour on AWS as code

| File | What |
|---|---|
| `goldenhour.yaml` | The whole stack (CloudFormation): network, RDS, secrets, Beanstalk, S3 + CloudFront, monitoring, budget, optional GitHub OIDC deploy role |
| `eb/` | Copied into the Beanstalk bundle: `Procfile` (`node backend/src/start.js`) and `.platform/nginx/` (WebSocket upgrade, 13 MB bodies) |
| `scripts/build.sh` | Builds `dist/backend.zip` (Beanstalk bundle) and `dist/web/` (front-ends for S3) |
| `scripts/deploy.sh` | Deploys the checkout with the AWS CLI (same steps as `.github/workflows/deploy-aws.yml`) |
| `scripts/power.sh` | `stop` / `start` / `status` between demos |
| `scripts/pack-web.js` | Packs `dist/web` into one JSON file, for sessions that can upload one file but not run `aws s3 sync` |

The resources, IDs, costs and how to operate them are in [`deploy/aws/README.md`](../deploy/aws/README.md).

## Rebuild everything

Region **ap-southeast-2** for every command (`export AWS_REGION=ap-southeast-2`). Account `109933871250`.

```bash
# 1. The stack (~20 min: RDS ~10, Beanstalk ~3, CloudFront ~5)
aws cloudformation deploy --stack-name goldenhour --template-file infra/goldenhour.yaml \
  --capabilities CAPABILITY_NAMED_IAM --tags Project=GoldenHour
#    The template is under the 51,200-byte inline limit; for CreateStack with --template-url,
#    upload it first (aws s3 cp infra/goldenhour.yaml s3://goldenhour-artifacts-<acct>/cfn/).

# 2. The application (backend to Beanstalk, front-ends to S3, CloudFront invalidation)
infra/scripts/deploy.sh
```

That is all. On first boot the server creates its tables, loads the 100 network hospitals into the empty `hospitals` table (`HospitalSeedOnBoot=true`) and creates the administrator from the `goldenhour/app` secret. Then follow *First sign-in* in `deploy/aws/README.md`.

Parameters worth knowing (defaults in brackets):

| Parameter | |
|---|---|
| `InstanceType` [`t4g.micro`] | or `t4g.small` |
| `DbEngineVersion` [`8.4`] | MySQL 8.4 LTS — do not use 8.0 (Extended Support charges) |
| `DbBackupRetentionDays` [`1`] | the Free plan allows 1; set 7 on the Paid plan |
| `HospitalSeedOnBoot` [`true`] | seed `data/hospitals/network_hospitals.csv` into an empty table |
| `GitHubOidc` [`none`] | `create` (also creates the OIDC provider) or `existing`; blocked by the org SCP today |
| `AlertEmail`, `MonthlyBudgetUsd` [`20`] | alarms and budget |

Notes

- A new CloudFront domain means a new APK: put it in `app/www/config.js` (`SERVER_BASE`), push, run **Build GoldenHour APK**.
- The RDS instance has deletion protection and `DeletionPolicy: Snapshot`; deleting the stack leaves a final snapshot. The stack has termination protection on.
- The Beanstalk CNAME is `goldenhour-<account>.ap-southeast-2.elasticbeanstalk.com`; CloudFront reaches it over HTTP on port 80, which only CloudFront's origin-facing addresses may use.
