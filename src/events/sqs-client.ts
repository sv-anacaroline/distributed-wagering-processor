import {
  GetQueueUrlCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';

export function sqsClient(): SQSClient {
  return new SQSClient({
    region: process.env.AWS_REGION ?? 'us-east-1',
    ...(process.env.SQS_ENDPOINT_URL ? { endpoint: process.env.SQS_ENDPOINT_URL } : {}),
    maxAttempts: 2,
  });
}
export async function sqsQueueUrl(
  client: SQSClient, explicit: string | undefined, name: string,
): Promise<string> {
  if (explicit) return explicit;
  const result = await client.send(new GetQueueUrlCommand({ QueueName: name }));
  if (!result.QueueUrl) throw new Error(`SQS queue ${name} has no QueueUrl`);
  return result.QueueUrl;
}
