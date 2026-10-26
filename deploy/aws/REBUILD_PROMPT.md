# Prompt: rebuild GoldenHour as a 3-tier AWS application

Paste everything inside the block into Claude Code, opened on this repository (branch `Patch-2`), after running `aws login` for account 109933871250.

```text
You are rebuilding GoldenHour (SIH 2026 emergency pre-arrival system: ambulance app → hospital ER desks) as a three-tier application fully managed on AWS. Read README.md, deploy/aws/README.md and backend/src first, and keep every existing feature and test working.

## AWS context
- Account 109933871250, region ap-southeast-2 (Sydney) ONLY — other regions are blocked by an organisation policy.
- Free plan with about US$100 credit. Keep the monthly run cost under ~US$25. Before creating anything, give me a cost estimate per resource and wait for my OK.
- Tag every resource Project=GoldenHour. Define ALL infrastructure as code with AWS CDK (TypeScript) in a new infra/ folder so the whole stack can be rebuilt with one `cdk deploy`.
- The current deployment (EC2 i-04a337bf8a7adf656 + CloudFront EXTEH411I2R7O, see deploy/aws/README.md) must keep running until the new stack is verified. Never delete it without asking me.

## Target architecture (3 tiers)
1. Presentation tier — S3 (private bucket) + CloudFront with Origin Access Control serving the static front-ends: /hospital (ER desk), /admin (admin console), /ambulance (web ambulance app). CloudFront also routes /api/* and /socket.io/* to the application tier (caching disabled, all viewer headers/query strings forwarded, WebSockets working). HTTPS everywhere; HTTP redirects to HTTPS.
2. Application tier — AWS Elastic Beanstalk, Node.js 22 on Amazon Linux 2023, single-instance environment (t4g.small or t4g.micro) running backend/src/server.js. Managed platform updates on. Health check path /health. Make sure the Beanstalk nginx proxy passes WebSocket upgrades (Socket.IO must connect over websocket, not only polling — prove it).
3. Data tier — Amazon RDS for MySQL 8.0, db.t4g.micro, 20 GB gp3, encrypted, automated backups (7 days), NOT publicly accessible, in private subnets, security group allowing 3306 only from the Beanstalk instance security group.
- Secrets: RDS-managed master password in AWS Secrets Manager; a separate Secrets Manager secret for JWT_SECRET (48 random bytes) and the first SUPER_ADMIN password. The app reads them at startup (use Beanstalk environment secrets or a small loader using the AWS SDK with the instance role). No secret may appear in code, git, CDK output, logs or chat.
- Monitoring: CloudWatch Logs streaming from Beanstalk, an alarm on /health failures and on RDS CPU/storage, and an AWS Budgets alert at US$20/month emailed to kushal.sentheel@gmail.com.
- CI/CD: GitHub Actions workflow that deploys the backend to Beanstalk and syncs the front-ends to S3 (+ CloudFront invalidation) on every push to Patch-2, authenticating with GitHub OIDC (an IAM role trusted only for repo skushal18/GoldenHour-SIH2026-Patched, branch Patch-2). No long-lived AWS keys in GitHub.

## Database: 100 hospitals in RDS
- Create a `hospitals` table in RDS (id = the directory id from data/hospitals/india_hospitals.csv, name, state, district, pincode, address, phone, ownership, lat, lng, coord_source, active).
- Load exactly 100 hospitals, a mix of the top cities: Bengaluru, Mumbai, Delhi, Chennai, Hyderabad, Kolkata and Pune (about 14–15 each). Choose emergency-capable hospitals (emergency_likely = 1), prefer coord_source = 'listed' and those with a phone number, and always include St John's Medical College Hospital (12179), Bowring and Lady Curzon (12815), Victoria Hospital (11880) and Manipal Hospital Old Airport Road (100093). Show me the list of 100 as a table and wait for my OK before loading it.
- Write the loader as a repeatable migration/seed script in the repo (idempotent: re-running it changes nothing).
- Change the backend so the hospital directory, matching, nearby search and admin console read hospitals from RDS instead of the CSV. Keep the full 29,844-row CSV in the repo as the source the admin can import more hospitals from.
- All other tables (accounts, broadcasts, broadcast_targets, hospital_capacity, case_events) live in RDS too; the server already creates them at startup (backend/src/store/migrate.js).

## Logins: one per hospital, each hospital sets its own
- Remove the built-in logins: delete backend/seed/accounts.json and the seeding code path that uses it. The old passwords must stop working everywhere.
- The first SUPER_ADMIN is created from the Secrets Manager secret on first boot; I sign in and must change that password immediately.
- Add "Create logins for all hospitals" to the admin console: for each of the 100 hospitals it creates an account in a pending state with a one-time activation code (random, shown/exported once as a CSV I can download, stored only as a hash, expires in 7 days, single use). Also keep creating/resetting one login at a time.
- Add a hospital activation screen: the hospital enters its activation code, then chooses ITS OWN desired username (unique, 3–64 chars, letters/digits/dot/dash/underscore) and password (min 10 chars, the existing strength rules). After activation it signs in with exactly that username and password and lands on its own ER desk — and only its own hospital's cases.
- Keep everything the current auth does: bcrypt hashing, 5 wrong tries → 15 min lock, token revocation on disable/reset/password change, admin cannot read passwords, audit log of sign-ins and account changes.
- Admin can see each hospital's status: pending activation / active / disabled / locked, and re-issue an activation code.

## Ambulance app and APK
- Point app/www/config.js SERVER_BASE at the new CloudFront HTTPS address, rebuild the web app, and make sure GitHub Actions "Build GoldenHour APK" produces an APK that talks to the new stack. Keep CORS_ORIGIN = https://localhost for the APK.

## Quality bar
- Run `npm run setup && npm test` before every push; add tests for: the RDS hospital directory, bulk login creation, activation (code expiry, single use, username uniqueness, password rules) and that a hospital sees only its own cases.
- After deploying, prove it end to end through the public HTTPS address: /health shows store mysql and the RDS host; sign in as admin; create logins; activate one hospital with a chosen username/password; broadcast a test case from the ambulance app; accept it on that hospital's desk; check live GPS and arrival; check the Socket.IO connection is websocket. Then cancel/close the test case.
- Update README.md and deploy/aws/README.md with the new architecture (a diagram), every resource ID, how deploys work, costs, and how to rebuild with CDK.

## How to work with me
- Work in small steps and tell me what you are about to create before you create it. Ask me before anything that costs money, deletes data, or changes the live site.
- When the new stack is verified, ask me before switching the APK/links over, and ask again before tearing down the old EC2/CloudFront stack (terminate instance, release Elastic IP, disable+delete the old distribution, delete its security group and IAM role).
- Start by: (1) confirming you can reach the AWS account, (2) showing me the cost estimate and the plan as a checklist, (3) waiting for my OK.
```
