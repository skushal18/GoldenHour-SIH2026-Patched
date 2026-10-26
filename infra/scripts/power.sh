#!/usr/bin/env bash
# Stop GoldenHour between demos, start it again before one.
#   infra/scripts/power.sh stop     ~US$4/month while stopped (idle IP, disks, secrets)
#   infra/scripts/power.sh start    back in ~10 minutes (RDS start is the slow part)
#   infra/scripts/power.sh status
# Stopping: the Beanstalk instance scales to 0, RDS stops, the health probe
# pauses (so no false alarms). RDS starts itself again after 7 days stopped —
# run `stop` again then. Data in RDS is kept.
set -euo pipefail
export AWS_REGION=ap-southeast-2 AWS_DEFAULT_REGION=ap-southeast-2
ENVNAME=goldenhour-prod DB=goldenhour-db RULE=goldenhour-health-probe
asg() { aws elasticbeanstalk update-environment --environment-name "$ENVNAME" --option-settings \
  Namespace=aws:autoscaling:asg,OptionName=MinSize,Value="$1" Namespace=aws:autoscaling:asg,OptionName=MaxSize,Value="$1" >/dev/null; }
case "${1:-status}" in
  stop)
    aws events disable-rule --name "$RULE"
    asg 0
    aws elasticbeanstalk wait environment-updated --environment-names "$ENVNAME"
    aws rds stop-db-instance --db-instance-identifier "$DB" >/dev/null
    echo "stopping: instance scaled to 0, database stopping, probe paused" ;;
  start)
    aws rds start-db-instance --db-instance-identifier "$DB" >/dev/null 2>&1 || true
    aws rds wait db-instance-available --db-instance-identifier "$DB"
    asg 1
    aws elasticbeanstalk wait environment-updated --environment-names "$ENVNAME"
    aws events enable-rule --name "$RULE"
    echo "started" ;;
  status)
    aws rds describe-db-instances --db-instance-identifier "$DB" --query 'DBInstances[0].DBInstanceStatus' --output text
    aws elasticbeanstalk describe-environments --environment-names "$ENVNAME" --query 'Environments[0].[Status,Health,VersionLabel]' --output text
    aws events describe-rule --name "$RULE" --query State --output text ;;
  *) echo "usage: $0 stop|start|status"; exit 2 ;;
esac
