# GoldenHour on AWS — three tiers

Live: **https://d1k7k7ahunvfhc.cloudfront.net** — `/hospital` (ER desk), `/hospital/#activate` (first-time activation), `/admin`, `/ambulance`, `/health`, `/wake`. All links and the sign-in / activation steps for users: [`docs/GOLDENHOUR-GUIDE.md`](../../docs/GOLDENHOUR-GUIDE.md).

Account `109933871250`, region **ap-southeast-2 (Sydney)** only. Everything is one CloudFormation stack, **`goldenhour`**, defined in [`infra/goldenhour.yaml`](../../infra/goldenhour.yaml); every resource is tagged `Project=GoldenHour`.

```text
                     Ambulance app (APK / web)          ER desks · admin console (browser)
                                   │  HTTPS                         │  HTTPS
                                   ▼                                ▼
 ┌──────────────────────── CloudFront  ESD4D0YHVEK9M  d1k7k7ahunvfhc.cloudfront.net ────────────────────────┐
 │  HTTP → HTTPS redirect · security headers · TLS                                                          │
 │   default (*)           → S3 origin (OAC)        cached, /x/ → /x/index.html (function goldenhour-index) │
 │   /api/* /socket.io/* /health → Beanstalk origin  no cache, all viewer headers + query, WebSockets       │
 └───────────────┬───────────────────────────────────────────────────────┬──────────────────────────────────┘
   PRESENTATION  │                                         APPLICATION    │ HTTP :80 (CloudFront prefix list only)
                 ▼                                                         ▼
   S3 goldenhour-web-109933871250 (private)      Elastic Beanstalk goldenhour-prod (Node.js 22, AL2023, arm64)
   /index.html /hospital/ /admin/                 t4g.micro single instance · nginx (WebSocket upgrade) → Node :8080
   /ambulance/ /vendor/                           reads secrets with its instance role ──► Secrets Manager
                                                                │ MySQL :3306, TLS (RDS CA), from the app SG only
                                                   DATA         ▼
                                                  RDS for MySQL 8.4  goldenhour-db  db.t4g.micro, 20 GB gp3,
                                                  encrypted, private subnets (no internet route), not public
```

## Resources

| Tier | Resource | ID / value |
|---|---|---|
| Presentation | CloudFront distribution | `ESD4D0YHVEK9M` → `d1k7k7ahunvfhc.cloudfront.net` (PriceClass_200, HTTP/2+3, IPv6) |
| | Origin access control | `E3S67IJWQVPXBA` (`goldenhour-web`) |
| | CloudFront function | `goldenhour-index` (directory index + `/hospital` → `/hospital/`) |
| | Response headers policy | `goldenhour-web` (CSP, HSTS, nosniff, DENY framing, Permissions-Policy) |
| | S3 site bucket | `goldenhour-web-109933871250` (private, OAC only, TLS only) |
| Application | Beanstalk application / environment | `goldenhour` / `goldenhour-prod` |
| | Environment URL (origin) | `goldenhour-109933871250.ap-southeast-2.elasticbeanstalk.com` → EIP `32.236.253.166` (EB-managed) |
| | Instance | `i-0ed3b145e455266b1` (t4g.micro, replaced by Beanstalk as needed) |
| | Platform | Node.js 22 on 64-bit Amazon Linux 2023 6.11.12, managed minor updates Sun 20:30 UTC |
| | Security group | `sg-0284eb2e3c59d7d95` `goldenhour-app` — TCP 80 from `pl-b8a742d1` (CloudFront origin-facing) only; EB's default SG disabled |
| | IAM | `goldenhour-eb-service` (service role), `goldenhour-eb-instance` (instance role + profile: web tier, SSM, read the two secrets) |
| | Logs | CloudWatch `/aws/elasticbeanstalk/goldenhour-prod/*` (14 days) |
| Data | RDS instance | `goldenhour-db` — MySQL 8.4, `goldenhour-db.ctsiws0ykcw6.ap-southeast-2.rds.amazonaws.com:3306`, database `goldenhour` |
| | Subnets | `subnet-0bba6ea31cc784de8` (172.31.48.0/24, 2a), `subnet-0a11f797a7b564ab1` (172.31.49.0/24, 2b), route table `rtb-0ef431677349397cc` (local only) |
| | Security group | `sg-03d8f1252503db775` `goldenhour-db` — TCP 3306 from `goldenhour-app` only |
| Secrets | RDS master secret (RDS-managed, rotates) | `rds!db-7647de29-71bc-434c-b64c-9c589e28a673` |
| | App secret | `goldenhour/app` — `JWT_SECRET` (48 random bytes), `SUPER_ADMIN_USERNAME`, `SUPER_ADMIN_PASSWORD`; filled once by Lambda `goldenhour-secret-seeder` |
| Monitoring | Health probe | Lambda `goldenhour-health-probe`, every 5 min (rule `goldenhour-health-probe`), GET `/health`, fails unless healthy on MySQL |
| | Alarms → SNS `goldenhour-alerts` (email) | `goldenhour-health-failing` (2 failed probes), `goldenhour-db-cpu-high` (>80 % 15 min), `goldenhour-db-storage-low` (<2 GiB) |
| | Budget | `goldenhour-monthly` US$20 — email at 80 % and 100 % actual, 100 % forecast |
| Sleep / wake | Sleeper | Lambda `goldenhour-idle-sleeper`, every 15 min (rule `goldenhour-idle-sleeper`) — after `IdleStopMinutes` (120) without a request: instance → 0, RDS stopped, probe paused |
| | Waker | Lambda `goldenhour-waker` behind CloudFront `/wake` (function URL, OAC `goldenhour-waker`) — starts RDS and the instance |
| Deploy | Artifacts bucket | `goldenhour-artifacts-109933871250` (`backend/*.zip`, `cfn/goldenhour.yaml`) |

No secret value is in the code, git, the template, stack outputs, environment variables or logs: the Beanstalk environment holds only the two secret **ARNs** and `backend/src/start.js` reads them at boot with the instance role (`backend/src/config/awsSecrets.js`). A rotated RDS password reaches the connection pool within 5 minutes without a restart.

## First sign-in

1. **Administrator**: AWS console → Secrets Manager → `goldenhour/app` → *Retrieve secret value*. Sign in at `/admin` with `SUPER_ADMIN_USERNAME` / `SUPER_ADMIN_PASSWORD`; you must choose a new password at once. (The secret keeps the first password; it is only used to create the administrator on an empty database.)
2. **Hospitals**: *Hospital accounts* → **Create logins for all hospitals**. A CSV with one activation code per hospital downloads once (codes are stored only as hashes, expire after 7 days, work once). Send each hospital its code; it opens `/hospital/#activate`, enters the code and chooses its own username and password, then signs in with exactly those. Re-issue a code from the same list when one expires or is lost.
3. Confirm the **SNS subscription email** ("AWS Notification - Subscription Confirmation") so alarms reach you.

## How deploys work

- **GitHub Actions** — `.github/workflows/deploy-aws.yml` runs on every push to `Patch-2`: tests (including MySQL 8.4), `infra/scripts/build.sh`, upload the bundle, new Beanstalk version, S3 sync, CloudFront invalidation, smoke test of `/health`. It authenticates with GitHub OIDC (role `goldenhour-github-deploy`, trusted only for `repo:skushal18/GoldenHour-SIH2026-Patched:ref:refs/heads/Patch-2`) — no AWS keys in GitHub.
  **Blocked today:** this account's organisation SCP (`p-8ptlsm3g`) denies every `iam:*OpenIDConnectProvider*` action, so the OIDC provider cannot be created. Until the organisation owner allows it, the deploy job skips with a notice. Once allowed: update the stack with `GitHubOidc=create`, then set the repository variable `AWS_DEPLOY_ROLE_ARN` to the `DeployRoleArn` output.
- **From a laptop** with the AWS CLI signed in: `infra/scripts/deploy.sh` (backend + front-ends) or `infra/scripts/deploy.sh web`.
- **The APK** reads `app/www/config.js` (`SERVER_BASE: "https://d1k7k7ahunvfhc.cloudfront.net"`, `CORS_ORIGIN=https://localhost` on the server). GitHub → Actions → **Build GoldenHour APK** builds it; it also runs on pushes to `Patch-2` that touch `app/`. The web copy at `/ambulance` uses the page's own origin.

## Sleeps when idle, wakes on demand

- After **2 hours** with no real request (any API call or new realtime connection — `/health` does not count) the sleeper scales the Beanstalk instance to **0**, stops **RDS** and pauses the health probe.
- While asleep the static pages still load; the API answers **504** within ~4 s. The ER desk, the admin console and the ambulance app then call **`/wake`** (at most once a minute) and show "GoldenHour is starting up…". The waker starts RDS and the instance; the app answers again after **~8–10 minutes** and the pages reconnect by themselves.
- A case sent from the ambulance app while asleep waits in the app's outbox and is sent when the server is back.
- An open ER desk polls every 10 s, so it keeps the stack awake — close desk screens you are not using.
- RDS restarts itself after 7 days stopped; the sleeper stops it again within 15 minutes.
- Change the idle time with the stack parameter `IdleStopMinutes`. Deploying while asleep fails — open `/wake` first and wait ~10 minutes.
- By hand: `infra/scripts/power.sh stop | start | status`, or open https://d1k7k7ahunvfhc.cloudfront.net/wake.

## Costs (Sydney, on demand, from the AWS Pricing API)

| Item | US$/month running |
|---|---:|
| Beanstalk t4g.micro ($0.0106/h) | 7.74 |
| 10 GB gp3 root volume | 0.96 |
| Public IPv4 (EB Elastic IP) | 3.65 |
| RDS db.t4g.micro MySQL ($0.025/h) | 18.25 |
| RDS 20 GB gp3 ($0.138/GB) | 2.76 |
| Secrets Manager (2 secrets) | 0.80 |
| CloudWatch logs + 3 alarms, Lambda, S3, CloudFront (free allowance), Budgets | ~1.10 |
| **Running all month** | **≈ 35** |
| **Asleep** (EIP, RDS storage, secrets) | **≈ 4** |

With the 2-hour idle sleep you pay roughly US$4 plus about US$0.05 per hour it is awake (≈ US$12/month at 8 hours a day). MySQL 8.4 (not 8.0) on purpose: 8.0 left standard support on 31 July 2026 and would add RDS Extended Support charges (≈ US$150/month for this instance); the template also sets `EngineLifecycleSupport: open-source-rds-extended-support-disabled`.

**Free plan limit:** automated backups are capped at **1 day** on the AWS Free plan (RDS refused 7). After upgrading the account to the Paid plan (the credit still applies), update the stack with `DbBackupRetentionDays=7`.

## Operating

- **Logs**: CloudWatch → Log groups → `/aws/elasticbeanstalk/goldenhour-prod/var/log/web.stdout.log` (app), `.../nginx/access.log`.
- **Shell**: EC2 → instance → Connect → Session Manager. App in `/var/app/current`; `sudo systemctl restart web`.
- **Hospitals**: the `hospitals` table is the network. `HOSPITAL_SEED_ON_BOOT=true` loads `data/hospitals/network_hospitals.csv` into an empty table at boot; by hand: `cd /var/app/current && npm --prefix backend run seed:hospitals` (idempotent). Add more from the admin console → Directory → *Add hospitals from the national list*.
- **End-to-end check** (on the instance, via Session Manager or SSM Run Command): `cd /var/app/current && eval "$(/opt/elasticbeanstalk/bin/get-config environment | node -e 'const e=JSON.parse(require("fs").readFileSync(0,"utf8"));for(const[k,v] of Object.entries(e))console.log("export "+k+"="+JSON.stringify(String(v)))')" && node backend/scripts/e2e-aws.js https://d1k7k7ahunvfhc.cloudfront.net` — it never prints a secret, and leaves the administrator as it found it.

## Rebuild from scratch

See [`infra/README.md`](../../infra/README.md): one `CreateStack` (or `UpdateStack`) with `infra/goldenhour.yaml`, then one deploy.

## Previous deployment (EC2) — retired 26 Oct 2026

Deleted: EC2 `i-04a337bf8a7adf656` (and its disk and MariaDB data), Elastic IP `52.64.219.180`, CloudFront `EXTEH411I2R7O` (`d31kwkffv9iv72.cloudfront.net`), security group `sg-07d01f03ac0ab235c`, IAM role and instance profile `goldenhour-ec2-role`. `deploy/aws/ec2-user-data.sh` is kept only as history.
