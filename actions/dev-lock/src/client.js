import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { LockStore } from "./store.js";

/** The real DynamoDB document client. Timeouts are short and retries few: a slow lock store must not stall a deploy. */
export function createDocumentClient(settings, env = process.env) {
  const client = new DynamoDBClient({
    region: settings.region,
    maxAttempts: 3,
    requestHandler: { connectionTimeout: 5000, requestTimeout: 10000 },
    ...(env.AWS_ENDPOINT_URL ? { endpoint: env.AWS_ENDPOINT_URL } : {}),
  });
  return DynamoDBDocumentClient.from(client, { marshallOptions: { removeUndefinedValues: true } });
}

/** Build the store the action really uses. */
export function createStore(settings, env, clock) {
  return new LockStore(createDocumentClient(settings, env), settings.tableName, () => clock.now());
}
