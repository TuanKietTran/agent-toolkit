variable "env_file" {
  description = "Local file with CHAT_TOKEN=, PI_TOKEN=, CLAUDE_TOKEN= lines (three distinct random values, >= 24 chars). Create it once with mode 0600; never commit it."
  type        = string
  default     = "~/.dac-poc/env"
}

variable "instance_type" {
  description = "Cheap arm64 size only (the bootstrap installs linux-arm64 builds)."
  type        = string
  default     = "t4g.micro"
  validation {
    condition     = can(regex("^t4g\\.(micro|small)$", var.instance_type))
    error_message = "PoC budget: use t4g.micro (or t4g.small)."
  }
}

variable "chat_cidr" {
  description = "Who may reach the chat port. Codespaces egress IPs vary, so the PoC opens 443 to the world; the app still requires a token."
  type        = string
  default     = "0.0.0.0/0"
}

variable "install_app" {
  description = "Run install-app.sh (SSM Run Command) after the instance exists. Needs the aws CLI, node and python3 locally."
  type        = bool
  default     = true
}
