output "wager_transactions_queue_url" {
  value = aws_sqs_queue.wager_transactions.url
}
output "wager_transactions_dlq_url" {
  value = aws_sqs_queue.wager_dlq.url
}
output "wager_events_queue_url" {
  value = aws_sqs_queue.wager_events.url
}
