variable "aws_region" {
  description = "Region emulated locally."
  type        = string
  default     = "us-east-1"
}

variable "sqs_endpoint" {
  description = "SQS emulator hostname inside Docker Compose."
  type        = string
  default     = "http://aws-emulator:4566"
}
