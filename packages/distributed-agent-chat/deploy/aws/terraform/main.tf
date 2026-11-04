# Minimal DAC PoC on AWS: ONE t4g.micro running the Node room-owner server, a MOCK pi worker and Caddy (HTTPS on 443 only).
# Mirrors deploy/aws/deploy.sh resource for resource. Do not mix the two for one deployment (use either deploy.sh/teardown.sh or terraform).

data "aws_caller_identity" "current" {}

data "aws_vpc" "default" {
  default = true
}

# Latest Amazon Linux 2023 arm64 (public SSM parameter).
data "aws_ssm_parameter" "al2023_arm64" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64"
}

locals {
  param_name = "/dac-poc/env"
}

# --- the ONE narrowly scoped role: SSM agent + read exactly one parameter --------------------------------------------
resource "aws_iam_role" "node" {
  name        = "dac-poc-ssm"
  description = "dac-poc: SSM agent + read one parameter"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "ec2.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy_attachment" "ssm_core" {
  role       = aws_iam_role.node.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_role_policy" "read_env" {
  name = "read-dac-poc-env"
  role = aws_iam_role.node.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = "ssm:GetParameter"
      Resource = "arn:aws:ssm:us-east-1:${data.aws_caller_identity.current.account_id}:parameter${local.param_name}"
    }]
  })
}

resource "aws_iam_instance_profile" "node" {
  name = "dac-poc-ssm"
  role = aws_iam_role.node.name
}

# --- secrets: ONE SecureString read by the instance itself (never in user-data or a command line) ---------------------
# NOTE: the value is also stored in Terraform state. Keep state local and private (0600) or use an encrypted remote backend.
resource "aws_ssm_parameter" "env" {
  name  = local.param_name
  type  = "SecureString"
  value = file(pathexpand(var.env_file))
}

# --- network: tcp/443 only. No SSH, no port 80, no admin ports ----------------------------------------------------------
resource "aws_security_group" "node" {
  name        = "dac-poc-sg"
  description = "dac-poc chat 443 only"
  vpc_id      = data.aws_vpc.default.id
}

resource "aws_vpc_security_group_ingress_rule" "chat_https" {
  security_group_id = aws_security_group.node.id
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = var.chat_cidr
  description       = "chat over HTTPS (token required)"
}

resource "aws_vpc_security_group_egress_rule" "all_out" {
  security_group_id = aws_security_group.node.id
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
  description       = "package + certificate downloads, SSM"
}

# --- the node ------------------------------------------------------------------------------------------------------------
resource "aws_instance" "node" {
  ami                         = data.aws_ssm_parameter.al2023_arm64.value
  instance_type               = var.instance_type
  iam_instance_profile        = aws_iam_instance_profile.node.name
  vpc_security_group_ids      = [aws_security_group.node.id]
  associate_public_ip_address = true                                   # auto-assigned public IPv4; deliberately NO Elastic IP
  user_data                   = file("${path.module}/../bootstrap.sh") # installs pinned Node + Caddy; contains no secrets
  user_data_replace_on_change = true

  instance_initiated_shutdown_behavior = "terminate"

  metadata_options {
    http_tokens   = "required" # IMDSv2 only
    http_endpoint = "enabled"
  }

  root_block_device {
    volume_size           = 8
    volume_type           = "gp3"
    delete_on_termination = true
  }

  tags        = { Name = "dac-poc-node" }
  volume_tags = { project = "dac-poc" }

  depends_on = [aws_iam_role_policy_attachment.ssm_core, aws_iam_role_policy.read_env, aws_ssm_parameter.env]
}

# --- app + secrets over SSM Run Command (shared with deploy.sh) ----------------------------------------------------------
resource "terraform_data" "install" {
  count = var.install_app ? 1 : 0

  triggers_replace = [aws_instance.node.id, filesha256("${path.module}/../../../src/node-server.ts"), filesha256("${path.module}/../../../src/worker.ts")]

  provisioner "local-exec" {
    command = "${path.module}/../install-app.sh ${aws_instance.node.id} ${aws_instance.node.public_ip}"
  }
}
