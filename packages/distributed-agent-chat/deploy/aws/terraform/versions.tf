terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = { source = "hashicorp/aws", version = ">= 5.60, < 7.0" }
  }
}

provider "aws" {
  region = "us-east-1" # PoC is pinned to us-east-1

  # Every resource that supports tags gets project=dac-poc (same tag the shell teardown.sh matches on).
  default_tags {
    tags = { project = "dac-poc" }
  }
}
