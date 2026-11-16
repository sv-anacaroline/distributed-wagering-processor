variable "project" {
  type    = string
  default = "distributed-wagering"
}
variable "environment" {
  type    = string
  default = "dev"
}
variable "aws_region" {
  type    = string
  default = "us-east-1"
}
variable "operator_cidr" {
  description = "Public IPv4 /32 allowed to reach EKS control plane; never 0.0.0.0/0."
  type        = string
  validation {
    condition     = can(cidrhost(var.operator_cidr, 0)) && var.operator_cidr != "0.0.0.0/0"
    error_message = "Provide your public IP /32, not 0.0.0.0/0."
  }
}
variable "kubernetes_version" {
  type    = string
  default = "1.34"
}
variable "node_instance_type" {
  type    = string
  default = "t3.large"
}
variable "db_instance_class" {
  type    = string
  default = "db.t4g.micro"
}
variable "db_allocated_storage" {
  type    = number
  default = 20
}
