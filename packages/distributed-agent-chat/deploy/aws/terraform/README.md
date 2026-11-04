# Terraform: DAC PoC on AWS

The same setup as `../deploy.sh`, written as Terraform. One `t4g.micro` (Amazon Linux 2023 arm64, 8 GB gp3, IMDSv2 only, public IPv4, no Elastic IP) in the default VPC of `us-east-1`, one security group (tcp/443 only), one narrowly scoped IAM role + instance profile (SSM agent + read one parameter), one SecureString parameter. Everything is tagged `project=dac-poc`. Budget: about USD 0.33/day.

```sh
# once: three distinct random secrets, mode 0600, outside git (shared with the shell scripts and the Codespace secrets)
mkdir -p ~/.dac-poc && chmod 700 ~/.dac-poc
( umask 077; printf 'CHAT_TOKEN=%s\nPI_TOKEN=%s\nCLAUDE_TOKEN=%s\n' "$(openssl rand -hex 24)" "$(openssl rand -hex 24)" "$(openssl rand -hex 24)" > ~/.dac-poc/env )

cd packages/distributed-agent-chat/deploy/aws/terraform
terraform init
terraform plan
terraform apply        # ~5 min; the last step runs ../install-app.sh over SSM
terraform output endpoint
terraform destroy      # removes everything it created
```

Notes
- `terraform apply` installs the app by running `../install-app.sh` (needs the `aws` CLI, `node` and `python3` locally). Set `-var install_app=false` to create only the infrastructure.
- The token values end up in Terraform state through the SecureString parameter. Keep the state local and private, or use an encrypted remote backend. Never commit `*.tfstate`.
- Use either this Terraform **or** `deploy.sh`/`teardown.sh` for a given deployment, not both: `teardown.sh` deletes by tag and would invalidate Terraform's state.
- Not applied as part of this commit: it was `terraform validate`d and `terraform plan`ned only. The shell scripts are the path that was run end to end.
