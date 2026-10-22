#!/usr/bin/env bash
# Builds, uploads and deploys the stack, then grants the distribution invoke rights.
#   STACK=mos-proxy CODE_BUCKET=my-bucket ORIGIN_URL=https://origin.example.com \
#   MOS_SECRET_KEY=sk_... infra/deploy.sh
# MOS_SECRET_KEY is only required for a new stack.
# Optional: ORIGIN_AUTH=IamAuth|ApplicationManaged, SURFACE_SLUG, MOS_HOST, INJECT_SCRIPT_URL,
# MAX_ENVIRONMENTS, LOG_RETENTION_IN_DAYS.
# Each optional setting keeps the stack's current value when unset.
# Arguments are passed on as extra stack parameters, e.g. 'OriginRequestHeaders={"X-Api-Key":"..."}'.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${STACK:?}" "${CODE_BUCKET:?}" "${ORIGIN_URL:?}"

# Checked before building so a new stack without a key fails fast. Any describe failure other than a
# missing stack (credentials, throttling) stops here rather than minting a new secret.
new_stack=
if ! status=$(aws cloudformation describe-stacks --stack-name "$STACK" --query 'Stacks[0].StackStatus' --output text 2>&1); then
    [[ $status == *"does not exist"* ]] || { echo "$status" >&2; exit 1; }
    : "${MOS_SECRET_KEY:?is required for a new stack}"
    new_stack=1
elif [[ $status == ROLLBACK_COMPLETE ]]; then
    echo "Stack $STACK failed to create. Delete it, then deploy again: aws cloudformation delete-stack --stack-name $STACK" >&2
    exit 1
fi

pnpm run build
rm -rf dist && mkdir dist
(cd build && zip -qr ../dist/proxy.zip . -x '*.map')
key="mos-proxy/$(date +%Y%m%d%H%M%S)-$(shasum -a 256 dist/proxy.zip | cut -c1-12).zip"
aws s3 cp dist/proxy.zip "s3://$CODE_BUCKET/$key"

overrides=(
    "CodeBucket=$CODE_BUCKET" "CodeKey=$key"
    "OriginUrl=$ORIGIN_URL"
)
[[ -n ${MOS_SECRET_KEY:-} ]] && overrides+=("MosSecretKey=$MOS_SECRET_KEY")
[[ -n ${ORIGIN_AUTH:-} ]] && overrides+=("OriginAuth=$ORIGIN_AUTH")
[[ -n ${SURFACE_SLUG:-} ]] && overrides+=("SurfaceSlug=$SURFACE_SLUG")
[[ -n ${MOS_HOST:-} ]] && overrides+=("MosHost=$MOS_HOST")
[[ -n ${INJECT_SCRIPT_URL:-} ]] && overrides+=("InjectScriptUrl=$INJECT_SCRIPT_URL")
[[ -n ${MAX_ENVIRONMENTS:-} ]] && overrides+=("MaxEnvironments=$MAX_ENVIRONMENTS")
[[ -n ${LOG_RETENTION_IN_DAYS:-} ]] && overrides+=("LogRetentionInDays=$LOG_RETENTION_IN_DAYS")
overrides+=("$@")
# `cloudformation deploy` keeps the previous value of any parameter left out, so only mint the secret
# for a new stack.
[[ -n $new_stack ]] && overrides+=("OriginVerifySecret=$(openssl rand -hex 32)")

aws cloudformation deploy --stack-name "$STACK" --template-file infra/template.yaml \
    --capabilities CAPABILITY_IAM --parameter-overrides "${overrides[@]}"

output() {
    aws cloudformation describe-stacks --stack-name "$STACK" \
        --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
}
parameter() {
    aws cloudformation describe-stacks --stack-name "$STACK" \
        --query "Stacks[0].Parameters[?ParameterKey=='$1'].ParameterValue" --output text
}

# There is no CloudFormation resource for a Web Function resource policy yet.
if [[ $(parameter OriginAuth) == IamAuth ]]; then
    policy=$(cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [{
    "Sid": "AllowCloudFrontOAC",
    "Effect": "Allow",
    "Principal": { "Service": "cloudfront.amazonaws.com" },
    "Action": "lambda:InvokeWebFunctionEndpoint",
    "Resource": "$(output EndpointArn)",
    "Condition": { "StringEquals": { "aws:SourceArn": "$(output DistributionArn)" } }
  }]
}
EOF
)
    aws lambda-web put-resource-policy --resource-arn "$(output WebFunctionArn)" --policy "$policy"
fi

echo "https://$(output DistributionDomainName)/"
