#!/usr/bin/env bash
# Delete EXACTLY the resources tagged project=dac-poc in us-east-1 (instance, volumes, security group, IAM role/instance profile, SSM parameter).
# Nothing without the tag is ever touched: every delete below first re-checks the tag.
#   teardown.sh --list     show tagged resources only
#   teardown.sh            delete them, then show what remains
set -uo pipefail
export AWS_DEFAULT_REGION=us-east-1 AWS_PAGER=""
REGION=us-east-1; TK=project; TV=dac-poc; ROLE=dac-poc-ssm; PARAM=/dac-poc/env
say() { printf '[teardown] %s\n' "$*"; }
tagged_now() { aws resourcegroupstaggingapi get-resources --region $REGION --tag-filters "Key=$TK,Values=$TV" --query 'ResourceTagMappingList[].ResourceARN' --output text | tr '\t' '\n' | sed '/^$/d'; }
list() {
  say "tagged $TK=$TV resources (tagging API):"; tagged_now | sed 's/^/  /'
  say "instances with the tag (any state):"
  aws ec2 describe-instances --region $REGION --filters "Name=tag:$TK,Values=$TV" --query 'Reservations[].Instances[].[InstanceId,State.Name]' --output text | sed 's/^/  /'
}
[ "${1:-}" = "--list" ] && { list; exit 0; }

# 1. instances (tag filter only)
ids=$(aws ec2 describe-instances --region $REGION --filters "Name=tag:$TK,Values=$TV" "Name=instance-state-name,Values=pending,running,stopping,stopped,shutting-down" --query 'Reservations[].Instances[].InstanceId' --output text)
if [ -n "$ids" ]; then say "terminating $ids"; aws ec2 terminate-instances --region $REGION --instance-ids $ids >/dev/null; aws ec2 wait instance-terminated --region $REGION --instance-ids $ids; fi
# 2. leftover tagged volumes
for v in $(aws ec2 describe-volumes --region $REGION --filters "Name=tag:$TK,Values=$TV" --query 'Volumes[].VolumeId' --output text); do say "deleting volume $v"; aws ec2 delete-volume --region $REGION --volume-id $v; done
# 3. tagged security groups (retry while ENIs detach)
for g in $(aws ec2 describe-security-groups --region $REGION --filters "Name=tag:$TK,Values=$TV" --query 'SecurityGroups[].GroupId' --output text); do
  for i in 1 2 3 4 5 6 7 8 9 10; do aws ec2 delete-security-group --region $REGION --group-id $g >/dev/null 2>&1 && { say "deleted security group $g"; break; }; sleep 6; done
done
# 4. SSM parameter (only if tagged)
if aws ssm list-tags-for-resource --resource-type Parameter --resource-id $PARAM --query "TagList[?Key=='$TK'&&Value=='$TV'] | length(@)" --output text 2>/dev/null | grep -qx 1; then
  aws ssm delete-parameter --name $PARAM && say "deleted parameter $PARAM"
fi
# 5. IAM role + instance profile (only if tagged)
if aws iam list-role-tags --role-name $ROLE --query "Tags[?Key=='$TK'&&Value=='$TV'] | length(@)" --output text 2>/dev/null | grep -qx 1; then
  aws iam remove-role-from-instance-profile --instance-profile-name $ROLE --role-name $ROLE 2>/dev/null
  aws iam delete-instance-profile --instance-profile-name $ROLE 2>/dev/null && say "deleted instance profile $ROLE"
  for p in $(aws iam list-attached-role-policies --role-name $ROLE --query 'AttachedPolicies[].PolicyArn' --output text); do aws iam detach-role-policy --role-name $ROLE --policy-arn $p; done
  for p in $(aws iam list-role-policies --role-name $ROLE --query 'PolicyNames' --output text); do aws iam delete-role-policy --role-name $ROLE --policy-name $p; done
  aws iam delete-role --role-name $ROLE && say "deleted role $ROLE"
fi
rm -f "$HOME/.dac-poc/endpoint"
# 6. local scratch only (the secrets file ~/.dac-poc/env is kept unless you pass --purge-local)
[ "${1:-}" = "--purge-local" ] && { rm -rf "$HOME/.dac-poc"; say "removed ~/.dac-poc"; }
say "remaining:"; list
