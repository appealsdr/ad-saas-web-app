#!/usr/bin/env bash
#
# Build the current working tree and push it to this project's default
# App Runner deployment target. Auto-deployments are enabled on the service,
# so the push alone triggers a rolling redeploy — no separate "deploy" API
# call needed.
#
# Default target (set 2026-09-20): AWS account 494777101987, region us-east-1,
# App Runner service "ad-saas-app" (https://kfhdt8kc2n.us-east-1.awsapprunner.com),
# via the local AWS CLI profile "ad-saas-deployment".
set -euo pipefail

AWS_PROFILE="${AWS_PROFILE:-ad-saas-deployment}"
REGION="${AWS_REGION:-us-east-1}"
ACCOUNT="${AWS_ACCOUNT:-494777101987}"
REPO_NAME="${ECR_REPO:-ad-saas-app}"
REPO="$ACCOUNT.dkr.ecr.$REGION.amazonaws.com/$REPO_NAME"

cd "$(dirname "$0")/.."

aws ecr get-login-password --region "$REGION" --profile "$AWS_PROFILE" \
  | docker login --username AWS --password-stdin "$ACCOUNT.dkr.ecr.$REGION.amazonaws.com"

docker build --platform linux/amd64 -t "${REPO}:latest" .
docker push "${REPO}:latest"

echo "Pushed ${REPO}:latest — App Runner auto-deploy should start within a few seconds."
