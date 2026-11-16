output "eks_cluster_name" { value = module.eks.cluster_name }
output "aws_region" { value = var.aws_region }
output "ecr_repository_url" { value = aws_ecr_repository.app.repository_url }
output "postgres_host" { value = aws_db_instance.postgres.address }
output "postgres_port" { value = aws_db_instance.postgres.port }
output "postgres_secret_arn" {
  value       = aws_db_instance.postgres.master_user_secret[0].secret_arn
  description = "RDS-managed secret ARN (no plaintext password in Terraform)."
}
output "sqs_wager_transactions_url" { value = aws_sqs_queue.wager_transactions.url }
output "sqs_wager_dlq_url" { value = aws_sqs_queue.wager_dlq.url }
output "sqs_wager_events_url" { value = aws_sqs_queue.wager_events.url }
output "pod_identity_role_arn" { value = aws_iam_role.wagering_pod.arn }
