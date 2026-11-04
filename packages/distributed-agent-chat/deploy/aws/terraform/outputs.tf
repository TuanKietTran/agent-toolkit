output "instance_id" {
  value = aws_instance.node.id
}

output "public_ip" {
  value = aws_instance.node.public_ip
}

# Caddy obtains a Let's Encrypt certificate for <ip-with-dashes>.sslip.io on 443 (TLS-ALPN), so no domain name is needed.
output "endpoint" {
  value = "https://${replace(aws_instance.node.public_ip, ".", "-")}.sslip.io"
}

output "codespaces_secrets" {
  description = "Names to create as Codespaces secrets (values: the same tokens as in var.env_file, plus UPSTREAM_URL = endpoint)."
  value       = ["CHAT_TOKEN", "PI_TOKEN", "CLAUDE_TOKEN", "UPSTREAM_URL"]
}
