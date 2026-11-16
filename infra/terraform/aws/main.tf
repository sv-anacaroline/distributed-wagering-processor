data "aws_availability_zones" "available" {
  state = "available"
}

locals {
  name = "${var.project}-${var.environment}"
  azs  = slice(data.aws_availability_zones.available.names, 0, 2)
  tags = {
    Project     = var.project
    Environment = var.environment
    ManagedBy   = "Terraform"
  }
}

module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "~> 6.0"

  name = "${local.name}-vpc"
  cidr = "10.42.0.0/16"

  azs              = local.azs
  public_subnets   = ["10.42.1.0/24", "10.42.2.0/24"]
  private_subnets  = ["10.42.11.0/24", "10.42.12.0/24"]
  database_subnets = ["10.42.21.0/24", "10.42.22.0/24"]

  enable_nat_gateway           = true
  single_nat_gateway           = true # Development only; not highly available.
  create_database_subnet_group = false

  public_subnet_tags = {
    "kubernetes.io/role/elb" = "1"
  }
  private_subnet_tags = {
    "kubernetes.io/role/internal-elb" = "1"
  }
  tags = local.tags
}

module "eks" {
  source  = "terraform-aws-modules/eks/aws"
  version = "~> 21.0"

  name               = "${local.name}-eks"
  kubernetes_version = var.kubernetes_version

  endpoint_public_access                   = true
  endpoint_private_access                  = true
  endpoint_public_access_cidrs             = [var.operator_cidr]
  enable_cluster_creator_admin_permissions = true # Development only.

  addons = {
    coredns                = {}
    kube-proxy             = {}
    vpc-cni                = { before_compute = true }
    eks-pod-identity-agent = { before_compute = true }
  }

  vpc_id     = module.vpc.vpc_id
  subnet_ids = module.vpc.private_subnets

  eks_managed_node_groups = {
    application = {
      instance_types = [var.node_instance_type]
      min_size       = 2
      max_size       = 3
      desired_size   = 2
    }
  }
  tags = local.tags
}

resource "aws_ecr_repository" "app" {
  name                 = local.name
  image_tag_mutability = "IMMUTABLE"
  encryption_configuration { encryption_type = "AES256" }
  force_delete = false
}

resource "aws_ecr_lifecycle_policy" "app" {
  repository = aws_ecr_repository.app.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep the last 20 images"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = 20
      }
      action = { type = "expire" }
    }]
  })
}

resource "aws_security_group" "rds" {
  name_prefix = "${local.name}-postgres-"
  description = "PostgreSQL access only from EKS nodes"
  vpc_id      = module.vpc.vpc_id
  tags        = local.tags
  lifecycle { create_before_destroy = true }
}

resource "aws_vpc_security_group_ingress_rule" "rds_from_eks" {
  security_group_id            = aws_security_group.rds.id
  referenced_security_group_id = module.eks.node_security_group_id
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
  description                  = "EKS nodes to PostgreSQL"
}

resource "aws_db_subnet_group" "postgres" {
  name       = "${local.name}-postgres-subnets"
  subnet_ids = module.vpc.database_subnets
}

resource "aws_db_instance" "postgres" {
  identifier                  = "${local.name}-postgres"
  engine                      = "postgres"
  instance_class              = var.db_instance_class
  allocated_storage           = var.db_allocated_storage
  max_allocated_storage       = 100
  storage_type                = "gp3"
  storage_encrypted           = true
  db_name                     = "wagering"
  username                    = "wagering"
  manage_master_user_password = true
  db_subnet_group_name        = aws_db_subnet_group.postgres.name
  vpc_security_group_ids      = [aws_security_group.rds.id]
  publicly_accessible        = false
  multi_az                   = false # Development only.
  backup_retention_period    = 7
  deletion_protection        = false # Development only.
  skip_final_snapshot        = true  # Development only.
}

resource "aws_sqs_queue" "wager_dlq" {
  name                        = "${local.name}-wager-transactions-dlq.fifo"
  fifo_queue                  = true
  content_based_deduplication = true
  message_retention_seconds   = 1209600
}

resource "aws_sqs_queue" "wager_transactions" {
  name                        = "${local.name}-wager-transactions.fifo"
  fifo_queue                  = true
  content_based_deduplication = true
  receive_wait_time_seconds   = 10
  visibility_timeout_seconds  = 60
  message_retention_seconds   = 1209600
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.wager_dlq.arn
    maxReceiveCount     = 5
  })
}

resource "aws_sqs_queue" "wager_events" {
  name                        = "${local.name}-wager-events.fifo"
  fifo_queue                  = true
  content_based_deduplication = true
  message_retention_seconds   = 1209600
}

data "aws_iam_policy_document" "pod_identity_trust" {
  statement {
    actions = ["sts:AssumeRole", "sts:TagSession"]
    principals {
      type        = "Service"
      identifiers = ["pods.eks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "wagering_pod" {
  name               = "${local.name}-pod-role"
  assume_role_policy = data.aws_iam_policy_document.pod_identity_trust.json
}

resource "aws_iam_role_policy" "wagering_pod" {
  name = "${local.name}-sqs-and-db-secret"
  role = aws_iam_role.wagering_pod.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "sqs:SendMessage", "sqs:ReceiveMessage", "sqs:DeleteMessage",
          "sqs:ChangeMessageVisibility", "sqs:GetQueueUrl", "sqs:GetQueueAttributes"
        ]
        Resource = [
          aws_sqs_queue.wager_transactions.arn,
          aws_sqs_queue.wager_dlq.arn,
          aws_sqs_queue.wager_events.arn
        ]
      },
      {
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue"]
        Resource = aws_db_instance.postgres.master_user_secret[0].secret_arn
      }
    ]
  })
}

resource "aws_eks_pod_identity_association" "wagering" {
  cluster_name    = module.eks.cluster_name
  namespace       = "wagering"
  service_account = "wagering-api"
  role_arn        = aws_iam_role.wagering_pod.arn
}
