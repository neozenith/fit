import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  BatchWriteCommand,
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import { DYNAMODB_ENDPOINT, IS_LOCAL, REGION, TABLE_PREFIX } from "./const.js";

/**
 * DynamoDB access.
 *
 * Key design, and the reasoning behind it:
 *
 *   pk = USER#{email}                    one partition per user (ADR-0018)
 *   sk = {TYPE}#{iso-timestamp}#{id}     type-prefixed, time-ordered
 *
 * The sort key leads with the type so a query can select one kind of item
 * without a filter expression, and follows with an ISO timestamp so lexical
 * order IS chronological order. That second property is what lets the age-out
 * job find everything older than a cut-off with a range query rather than a
 * full-table scan (ADR-0012) — a scan over years of history would cost more
 * than the storage it is trying to save.
 *
 * The trailing id disambiguates two items written in the same millisecond,
 * which happens more often than intuition suggests when a whole session's sets
 * are submitted at once.
 */

const client = DynamoDBDocumentClient.from(
  new DynamoDBClient({
    region: REGION,
    // The ONLY local/deployed difference in the service (ADR-0016).
    ...(IS_LOCAL
      ? {
          endpoint: DYNAMODB_ENDPOINT,
          credentials: { accessKeyId: "local", secretAccessKey: "local" },
        }
      : {}),
  }),
  { marshallOptions: { removeUndefinedValues: true } },
);

export type LogicalTable = "blocks" | "sets" | "measurements" | "cardio" | "season";

export const tableName = (logical: LogicalTable): string => `${TABLE_PREFIX}-${logical}`;

export interface Item {
  pk: string;
  sk: string;
  [key: string]: unknown;
}

export const sortKey = (type: string, timestamp: string, id: string): string =>
  `${type}#${timestamp}#${id}`;

/**
 * Query one user's items of one type, newest first.
 *
 * `begins_with` on the type prefix rather than a filter expression: a filter is
 * applied AFTER the read and is billed for every item it discards, so filtering
 * by type would pay to read the entire partition on every request.
 */
export const queryByType = async <T extends object>(
  logical: LogicalTable,
  pk: string,
  type: string,
  options: { limit?: number; since?: string; ascending?: boolean } = {},
): Promise<Array<T & Item>> => {
  const { limit, since, ascending = false } = options;

  const result = await client.send(
    new QueryCommand({
      TableName: tableName(logical),
      KeyConditionExpression: since
        ? "pk = :pk AND sk BETWEEN :from AND :to"
        : "pk = :pk AND begins_with(sk, :type)",
      ExpressionAttributeValues: since
        ? { ":pk": pk, ":from": `${type}#${since}`, ":to": `${type}#￿` }
        : { ":pk": pk, ":type": `${type}#` },
      ScanIndexForward: ascending,
      ...(limit ? { Limit: limit } : {}),
    }),
  );

  return (result.Items ?? []) as Array<T & Item>;
};

export const putItem = async (logical: LogicalTable, item: Item): Promise<void> => {
  await client.send(new PutCommand({ TableName: tableName(logical), Item: item }));
};

/**
 * Write many items at once.
 *
 * DynamoDB caps a batch at 25, and — more importantly — a `BatchWriteItem` can
 * succeed overall while returning some items as `UnprocessedItems` under
 * throttling. Ignoring that field silently drops writes, so unprocessed items
 * are retried with exponential backoff rather than assumed away.
 */
export const putItems = async (logical: LogicalTable, items: Item[]): Promise<void> => {
  const table = tableName(logical);

  for (let i = 0; i < items.length; i += 25) {
    let pending = items.slice(i, i + 25).map((Item) => ({ PutRequest: { Item } }));

    for (let attempt = 0; pending.length > 0 && attempt < 5; attempt++) {
      if (attempt > 0) {
        await new Promise((r) => setTimeout(r, 2 ** attempt * 50));
      }
      const result = await client.send(
        new BatchWriteCommand({ RequestItems: { [table]: pending } }),
      );
      pending = (result.UnprocessedItems?.[table] ?? []) as typeof pending;
    }

    if (pending.length > 0) {
      throw new Error(`${pending.length} items into ${table} remained unwritten after 5 attempts`);
    }
  }
};

export const documentClient = client;
