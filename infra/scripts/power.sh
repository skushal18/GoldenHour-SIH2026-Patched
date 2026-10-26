#!/usr/bin/env bash
# GoldenHour sleeps by itself after 2 idle hours (IdleStopMinutes) and wakes
# on the next request. This does the same by hand.
#   infra/scripts/power.sh stop     sleep now: instance → 0, RDS stopped, health probe paused
#   infra/scripts/power.sh start    wake now (same as opening any GoldenHour page); ready in ~8–10 min
#   infra/scripts/power.sh status
set -euo pipefail
export AWS_REGION=ap-southeast-2 AWS_DEFAULT_REGION=ap-southeast-2
DB=goldenhour-db RULE=goldenhour-health-probe
ASG=$(aws autoscaling describe-auto-scaling-groups \
  --filters Name=tag:elasticbeanstalk:environment-name,Values=goldenhour-prod \
  --query 'AutoScalingGroups[0].AutoScalingGroupName' --output text)
case "${1:-status}" in
  stop)
    aws events disable-rule --name "$RULE"
    aws autoscaling update-auto-scaling-group --auto-scaling-group-name "$ASG" --min-size 0 --max-size 0 --desired-capacity 0
    aws rds stop-db-instance --db-instance-identifier "$DB" >/dev/null 2>&1 || true
    echo "asleep: instance → 0, database stopping, probe paused" ;;
  start)
    aws lambda invoke --function-name goldenhour-waker /dev/stdout; echo ;;
  status)
    echo "database: $(aws rds describe-db-instances --db-instance-identifier "$DB" --query 'DBInstances[0].DBInstanceStatus' --output text)"
    echo "instances: $(aws autoscaling describe-auto-scaling-groups --auto-scaling-group-names "$ASG" --query 'AutoScalingGroups[0].[DesiredCapacity]' --output text)"
    echo "probe: $(aws events describe-rule --name "$RULE" --query State --output text)" ;;
  *) echo "usage: $0 stop|start|status"; exit 2 ;;
esac
