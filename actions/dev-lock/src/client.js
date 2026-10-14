import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { LockStore } from "./store.js";

/** How long one attempt may take before it is abandoned, and how many attempts a call gets. */
export const LIMITS = Object.freeze({ connectionTimeout: 5000, requestTimeout: 10000, maxAttempts: 3 });

/**
 * The HTTP handler options. `throwOnRequestTimeout` is what makes `requestTimeout` do anything: without it the SDK only
 * logs a warning when a request exceeds the timeout and keeps waiting, so a connection that is accepted and then goes
 * silent would hang the action (and its post step) until the job's own timeout.
 */
export function requestHandlerOptions({ connectionTimeout, requestTimeout } = LIMITS) {
  return { connectionTimeout, requestTimeout, throwOnRequestTimeout: true };
}

/**
 * The real DynamoDB document client. Timeouts are short and retries few: a slow lock store must not stall a deploy.
 * `limits` is only here so tests can use short timeouts; the action always uses the defaults.
 */
export function createDocumentClient(settings, env = process.env, limits = LIMITS) {
  const client = new DynamoDBClient({
    region: settings.region,
    maxAttempts: limits.maxAttempts,
    requestHandler: new NodeHttpHandler(requestHandlerOptions(limits)),
    ...(env.AWS_ENDPOINT_URL ? { endpoint: env.AWS_ENDPOINT_URL } : {}),
  });
  return DynamoDBDocumentClient.from(client, { marshallOptions: { removeUndefinedValues: true } });
}

/** Build the store the action really uses. */
export function createStore(settings, env, clock) {
  return new LockStore(createDocumentClient(settings, env), settings.tableName, () => clock.now());
}
