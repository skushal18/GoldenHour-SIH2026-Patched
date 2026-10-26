# GoldenHour on AWS

Live: **https://d31kwkffv9iv72.cloudfront.net** (`/hospital`, `/admin`, `/ambulance`, `/health`)

Everything is in account `109933871250`, region **ap-southeast-2 (Sydney)** — the only region this account may use. Every resource is tagged `Project=GoldenHour`.

| Resource | ID / value | Notes |
|---|---|---|
| EC2 instance | `i-04a337bf8a7adf656` (`t4g.small`, Amazon Linux 2023 arm64, 20 GB gp3) | Name tag `goldenhour` |
| Elastic IP | `52.64.219.180` (`eipalloc-0dfad13823fd82e6b`) | Keeps the origin address fixed across stop/start |
| Security group | `sg-07d01f03ac0ab235c` (`goldenhour-web`) | Port 8080 from CloudFront's origin-facing prefix list `pl-b8a742d1` only; no SSH |
| IAM role / instance profile | `goldenhour-ec2-role` | `AmazonSSMManagedInstanceCore` — Session Manager access |
| CloudFront | `EXTEH411I2R7O` → `d31kwkffv9iv72.cloudfront.net` | Origin `ec2-52-64-219-180.ap-southeast-2.compute.amazonaws.com:8080` (HTTP); CachingDisabled + AllViewer policies; redirects HTTP→HTTPS; WebSockets pass through |

## How deploys work

`git push` to **Patch-2** → within ~3 minutes the server pulls it, runs `npm ci` and restarts (`goldenhour-update.timer`). Check `/var/log/goldenhour-deploys.log` or `/health`.

The APK talks to the address in `app/www/config.js`. Change that only if the CloudFront address changes, then rebuild the APK (GitHub → Actions → **Build GoldenHour APK**).

## On the server

Connect: AWS console → EC2 → instance → **Connect → Session Manager** (or Systems Manager → Session Manager).

```bash
sudo systemctl status goldenhour           # app
sudo journalctl -u goldenhour -n 100       # app log
sudo systemctl restart goldenhour          # restart
sudo /usr/local/bin/goldenhour-update      # deploy now instead of waiting
sudo cat /var/log/goldenhour-deploys.log   # deploy history
sudo nano /etc/goldenhour.env              # settings (then restart)
sudo mysql goldenhour                      # database
```

## Rebuild from scratch

1. IAM role + instance profile `goldenhour-ec2-role` with `AmazonSSMManagedInstanceCore`.
2. Security group in the default VPC: TCP 8080 from prefix list `com.amazonaws.global.cloudfront.origin-facing`.
3. Launch `t4g.small`, AMI from SSM parameter `/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64`, IMDSv2 required, 20 GB encrypted gp3, the role above, user data = [`ec2-user-data.sh`](ec2-user-data.sh).
4. Allocate an Elastic IP and associate it.
5. CloudFront distribution: custom origin = the instance's public DNS name, HTTP only, port 8080, read timeout 60 s; default behaviour: redirect to HTTPS, all methods, cache policy `Managed-CachingDisabled`, origin request policy `Managed-AllViewer`.
6. If the CloudFront domain changed, update `SERVER_BASE` in `app/www/config.js`, push, rebuild the APK.

Setup takes ~3 minutes after the instance starts (`/var/log/goldenhour-setup.log` ends with `SETUP-DONE`).

## Cost (Free plan, $100 credit until April 2027)

Roughly: EC2 `t4g.small` ~US$12/month, Elastic IP ~US$3.60/month, 20 GB gp3 ~US$1.90/month, CloudFront within its free allowance at hackathon traffic — about **US$17/month from the credit**. Stop the instance when not demoing to save the EC2 part (the Elastic IP is still billed).

The database lives on the instance's disk: terminating the instance deletes it. The five built-in logins come back on any fresh server; logins created in the admin console do not.
