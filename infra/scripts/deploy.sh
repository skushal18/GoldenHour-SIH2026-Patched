#!/usr/bin/env bash
# Deploys the current checkout to the GoldenHour stack with the AWS CLI —
# the same steps as .github/workflows/deploy-aws.yml, for a laptop signed in
# to account 109933871250 (aws sso login / aws configure). Region ap-southeast-2.
#   infra/scripts/deploy.sh            backend + front-ends
#   infra/scripts/deploy.sh web        front-ends only
set -euo pipefail
export AWS_REGION=ap-southeast-2 AWS_DEFAULT_REGION=ap-southeast-2
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
STACK=goldenhour
out() { aws cloudformation describe-stacks --stack-name "$STACK" --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }
ARTIFACTS=$(out ArtifactsBucketName); SITE=$(out SiteBucketName); DIST=$(out DistributionId)
APP=$(out BeanstalkApplication); ENVNAME=$(out BeanstalkEnvironment); URL=$(out SiteUrl)

"$ROOT/infra/scripts/build.sh"

# It may be asleep (2 idle hours): wake it and wait for /health before deploying.
for i in $(seq 1 30); do
  curl -fsS "$URL/health" >/dev/null 2>&1 && break
  [ "$i" = 1 ] && echo "GoldenHour is asleep — waking it (up to ~10 minutes)…"
  curl -sS "$URL/wake" >/dev/null 2>&1 || true
  sleep 30
done

if [ "${1:-all}" != web ]; then
  LABEL="$(git -C "$ROOT" rev-parse --short=12 HEAD)-$(date +%s)"
  aws s3 cp "$ROOT/dist/backend.zip" "s3://$ARTIFACTS/backend/$LABEL.zip"
  aws elasticbeanstalk create-application-version --application-name "$APP" --version-label "$LABEL" \
    --source-bundle S3Bucket="$ARTIFACTS",S3Key="backend/$LABEL.zip" --process >/dev/null
  aws elasticbeanstalk update-environment --environment-name "$ENVNAME" --version-label "$LABEL" >/dev/null
  echo "deploying $LABEL to $ENVNAME…"
  aws elasticbeanstalk wait environment-updated --environment-names "$ENVNAME"
fi

aws s3 sync "$ROOT/dist/web" "s3://$SITE" --delete --exclude 'vendor/*' --cache-control 'no-cache'
aws s3 sync "$ROOT/dist/web/vendor" "s3://$SITE/vendor" --delete --cache-control 'public, max-age=86400'
aws cloudfront create-invalidation --distribution-id "$DIST" --paths '/*' >/dev/null
curl -fsS "$URL/health"; echo
