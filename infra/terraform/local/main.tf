resource "aws_sqs_queue" "wager_dlq" {
  name                        = "wager-transactions-dlq.fifo"
  fifo_queue                  = true
  content_based_deduplication = true
  message_retention_seconds   = 1209600
}

resource "aws_sqs_queue" "wager_transactions" {
  name                        = "wager-transactions.fifo"
  fifo_queue                  = true
  content_based_deduplication = true
  visibility_timeout_seconds  = 60
  receive_wait_time_seconds   = 10
  message_retention_seconds   = 1209600
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.wager_dlq.arn
    maxReceiveCount     = 5
  })
}

# Destination for future transactional-outbox events.
resource "aws_sqs_queue" "wager_events" {
  name                        = "wager-events.fifo"
  fifo_queue                  = true
  content_based_deduplication = true
  message_retention_seconds   = 1209600
}
