variable "aws_region" { type = string }
variable "cluster_name" { type = string }
variable "image_repository" {
  type        = string
  description = "Full ECR repository URL from AWS Terraform."
}
variable "image_tag" {
  type        = string
  description = "Immutable tag of an image already pushed to ECR."
}
variable "replicas" {
  type    = number
  default = 3
  validation {
    condition     = var.replicas >= 1
    error_message = "replicas must be >= 1"
  }
}
variable "postgres_host" { type = string }
variable "postgres_secret_arn" { type = string }
variable "sqs_wager_transactions_url" { type = string }
variable "sqs_wager_events_url" { type = string }
