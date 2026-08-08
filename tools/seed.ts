#!/usr/bin/env bun
/**
 * Create the local tables and load enough data to exercise every page.
 *
 * The schema here MUST match `infra/modules/data/main.tf`. It is stated twice
 * because Terraform cannot talk to DynamoDB Local and DynamoDB Local cannot
 * read Terraform — but the duplication is bounded to the key schema, which is
 * two attributes and has not changed since it was designed.
 */

import {
  CreateTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
  ResourceNotFoundException,
} from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { DEFAULT_ACCESSORIES, planSeason } from "@fit/program";

const ENDPOINT = process.env["DYNAMODB_ENDPOINT"] ?? "http://localhost:8000";
const PREFIX = process.env["TABLE_PREFIX"] ?? "fit-local";
const USER = process.env["LOCAL_USER"] ?? "local@example.com";

const raw = new DynamoDBClient({
  region: "ap-southeast-2",
  endpoint: ENDPOINT,
  credentials: { accessKeyId: "local", secretAccessKey: "local" },
});
const db = DynamoDBDocumentClient.from(raw, { marshallOptions: { removeUndefinedValues: true } });

const TABLES = ["blocks", "sets", "measurements", "cardio", "season"] as const;

const ensureTable = async (logical: string): Promise<void> => {
  const TableName = `${PREFIX}-${logical}`;
  try {
    await raw.send(new DescribeTableCommand({ TableName }));
    console.log(`  = ${TableName} exists`);
    return;
  } catch (error) {
    // Only "not found" means "create it". Any other error — a stopped
    // container, a bad endpoint — must surface rather than be swallowed into a
    // create attempt that fails with a more confusing message.
    if (!(error instanceof ResourceNotFoundException)) throw error;
  }

  await raw.send(
    new CreateTableCommand({
      TableName,
      BillingMode: "PAY_PER_REQUEST",
      KeySchema: [
        { AttributeName: "pk", KeyType: "HASH" },
        { AttributeName: "sk", KeyType: "RANGE" },
      ],
      AttributeDefinitions: [
        { AttributeName: "pk", AttributeType: "S" },
        { AttributeName: "sk", AttributeType: "S" },
      ],
    }),
  );
  console.log(`  + ${TableName} created`);
};

const pk = `USER#${USER}`;
const put = (logical: string, item: Record<string, unknown>) =>
  db.send(new PutCommand({ TableName: `${PREFIX}-${logical}`, Item: item }));

/** A start date far enough back that weeks 1-3 are already in the past. */
const blockStart = (): string => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 16);
  // Wind back to the Monday, because the program's day offsets assume the
  // block begins on the athlete's chosen first training day of a week.
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
};

const main = async (): Promise<void> => {
  console.log(`Seeding ${PREFIX}-* at ${ENDPOINT} for ${USER}`);

  for (const logical of TABLES) await ensureTable(logical);

  const startDate = blockStart();
  const blockId = "seed-block-1";

  await put("blocks", {
    pk,
    sk: `BLOCK#${startDate}#${blockId}`,
    blockId,
    startDate,
    units: "kg",
    // The source workbook's own seeds, so a local run reproduces exactly the
    // numbers the golden tests assert.
    oneRepMax: { bench: 40, squat: 70, deadlift: 80 },
    accessories: DEFAULT_ACCESSORIES,
    createdAt: new Date().toISOString(),
    createdBy: "seed",
  });

  // A handful of logged sets across the first fortnight, so the progress chart
  // and the personal-bests panel have something real to render.
  const loggedSets = [
    { day: 0, exercise: "Squat", weight: 55, reps: 6, count: 4 },
    { day: 0, exercise: "Deadlift", weight: 65, reps: 6, count: 2 },
    { day: 1, exercise: "Bench Press", weight: 20, reps: 10, count: 1 },
    { day: 1, exercise: "Bench Press", weight: 27.5, reps: 10, count: 1 },
    { day: 1, exercise: "Bench Press", weight: 30, reps: 8, count: 1 },
    { day: 1, exercise: "Bench Press", weight: 30, reps: 6, count: 1 },
    { day: 7, exercise: "Squat", weight: 55, reps: 9, count: 1 },
    { day: 8, exercise: "Bench Press", weight: 35, reps: 7, count: 1 },
    { day: 14, exercise: "Squat", weight: 62.5, reps: 5, count: 3 },
    { day: 14, exercise: "Deadlift", weight: 70, reps: 5, count: 2 },
  ];

  let written = 0;
  for (const entry of loggedSets) {
    for (let i = 0; i < entry.count; i++) {
      const ts = new Date(`${startDate}T18:00:00Z`);
      ts.setUTCDate(ts.getUTCDate() + entry.day);
      // Offset by the RUNNING total, not by `i`. Offsetting by `i` gives every
      // exercise on a given day the same 18:00 start, so four separate bench
      // entries all land on one timestamp — which then collides as a React key
      // and, worse, misrepresents a session as four simultaneous sets.
      ts.setUTCMinutes(ts.getUTCMinutes() + written * 3);
      const timestamp = ts.toISOString();
      const id = `seed-${written}`;
      await put("sets", {
        pk,
        sk: `SET#${timestamp}#${id}`,
        id,
        timestamp,
        exercise: entry.exercise,
        weight: entry.weight,
        reps: entry.reps,
        units: "kg",
        setIndex: i + 1,
        blockId,
        loggedBy: "seed",
      });
      written++;
    }
  }
  console.log(`  + ${written} sets`);

  // Two measurements a day for a fortnight, so the weekly median actually has
  // something to average out rather than trivially equalling the single value.
  let measurements = 0;
  for (let day = 0; day < 15; day++) {
    for (const [kind, base, jitter] of [
      ["bodyWeight", 99.5, 0.6],
      ["waistCircumference", 106, 1.5],
    ] as const) {
      const ts = new Date(`${startDate}T07:30:00Z`);
      ts.setUTCDate(ts.getUTCDate() + day);
      const timestamp = ts.toISOString();
      const id = `seed-m-${measurements}`;
      await put("measurements", {
        pk,
        sk: `MEASURE#${timestamp}#${id}`,
        id,
        timestamp,
        kind,
        // Deterministic pseudo-noise: a sine wave, not Math.random(), so two
        // seed runs produce identical data and a chart diff means something.
        value: Math.round((base - day * 0.05 + Math.sin(day) * jitter) * 10) / 10,
      });
      measurements++;
    }
  }
  console.log(`  + ${measurements} measurements`);

  // A season laid out the way the source workbook's year sheet is: six-week
  // blocks interrupted by fixtures, with each fixture starting a new block.
  const plan = planSeason({
    startDate,
    weeks: 26,
    fixtures: { 7: "ZWIFT_FTP", 8: "PARKRUN", 15: "PARKRUN", 22: "ZWIFT_FTP" },
  });
  await put("season", {
    pk,
    sk: `SEASON#${startDate}#plan`,
    plan,
    updatedAt: new Date().toISOString(),
  });
  console.log(`  + season plan, ${plan.weeks.length} weeks`);

  console.log(`\nSeeded. Mint a session with: make token ENV=local`);
};

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`error: ${message}`);
  console.error("Is DynamoDB Local running? Try `make up`.");
  process.exit(1);
});
