"""Age DynamoDB observations out to Parquet on S3.

The ordering here is the whole design (ADR-0012): **copy, verify, then delete**,
in that order, always. Reversed or interleaved, a failure between the write and
the delete loses data permanently. In this order the failure mode is a duplicate
partition — recoverable, and de-duplicated on read by sort key.

Only observation tables are aged out. Configuration tables are small and always
hot, so moving them would save nothing and cost a join.

This is the platform's only Python runtime (ADR-0019). It is here rather than in
TypeScript because writing Parquet from Node means shipping a WASM Arrow build,
while Python has pyarrow as a first-class Lambda layer.
"""

from __future__ import annotations

import io
import json
import logging
import os
from datetime import datetime, timedelta, timezone
from typing import Any, Iterator

import boto3
import pyarrow as pa
import pyarrow.parquet as pq
from boto3.dynamodb.types import TypeDeserializer

logger = logging.getLogger()
logger.setLevel(logging.INFO)

# Imported at module scope, and NOT wrapped in try/except. If pyarrow is missing
# the function must fail loudly at cold start — an age-out that silently skips
# the Parquet write would delete DynamoDB items with nothing written in their
# place, which is the one outcome this job must never produce.

DYNAMODB = boto3.client("dynamodb")
S3 = boto3.client("s3")
GLUE = boto3.client("glue")
DESERIALIZE = TypeDeserializer()

TABLE_PREFIX = os.environ["TABLE_PREFIX"]
ARCHIVE_BUCKET = os.environ["ARCHIVE_BUCKET"]
GLUE_DATABASE = os.environ["GLUE_DATABASE"]
HOT_WINDOW_MONTHS = int(os.environ["HOT_WINDOW_MONTHS"])

# Only these. `blocks` and `season` are configuration and stay hot forever.
AGED_TABLES = {
    "sets": "SET",
    "measurements": "MEASURE",
    "cardio": "CARDIO",
}

# DynamoDB caps a BatchWriteItem at 25 items.
DELETE_BATCH = 25


def cutoff_iso(now: datetime) -> str:
    """The instant before which items are cold.

    Thirteen months, not twelve, so a year-on-year comparison is always
    answerable from the hot path alone and never has to reach Athena.

    Month arithmetic is done by day-count deliberately: `relativedelta` is not
    in the standard library and the precision genuinely does not matter here —
    being a few days either side of the boundary changes nothing about which
    data is queryable.
    """
    return (now - timedelta(days=HOT_WINDOW_MONTHS * 30)).isoformat()


def scan_cold_items(table: str, sort_prefix: str, cutoff: str) -> Iterator[dict[str, Any]]:
    """Yield every item older than the cut-off.

    A Scan, not a Query, because the job has to sweep EVERY user's partition and
    there is no index across partitions. That is acceptable precisely because
    the sort key is time-ordered: the filter discards on the server side, and
    the table is small enough at this scale that the read cost is trivial.

    Pagination is followed rather than assumed. A truncated page would leave
    items behind — harmless — but the `LastEvaluatedKey` loop also guarantees
    the delete pass sees exactly what the write pass wrote.
    """
    paginator = DYNAMODB.get_paginator("scan")
    for page in paginator.paginate(
        TableName=table,
        FilterExpression="begins_with(sk, :prefix) AND sk < :cutoff",
        ExpressionAttributeValues={
            ":prefix": {"S": f"{sort_prefix}#"},
            ":cutoff": {"S": f"{sort_prefix}#{cutoff}"},
        },
    ):
        for raw in page.get("Items", []):
            yield {k: DESERIALIZE.deserialize(v) for k, v in raw.items()}


def partition_of(item: dict[str, Any]) -> tuple[str, str]:
    """Year and month for an item, taken from its sort key.

    From the SORT KEY rather than a `timestamp` attribute, because the sort key
    is the thing the scan filtered on. Using a different field would let an item
    be selected as cold and then written into a partition that disagrees.
    """
    _, timestamp, *_ = item["sk"].split("#")
    return timestamp[0:4], timestamp[5:7]


def write_parquet(logical: str, year: str, month: str, items: list[dict[str, Any]]) -> str:
    """Write one partition and return its S3 key."""
    # Numbers arrive from DynamoDB as Decimal, which Arrow cannot infer a type
    # for. Casting to float here is safe: every numeric field in these tables is
    # a weight, a rep count or a measurement, none of which needs exact decimal
    # semantics.
    normalised = [
        {k: (float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else v)
         for k, v in item.items()}
        for item in items
    ]

    table = pa.Table.from_pylist(normalised)
    buffer = io.BytesIO()
    pq.write_table(table, buffer, compression="snappy")

    key = f"tables/{logical}/year={year}/month={month}/part-{year}{month}.parquet"
    S3.put_object(
        Bucket=ARCHIVE_BUCKET,
        Key=key,
        Body=buffer.getvalue(),
        ContentType="application/vnd.apache.parquet",
    )
    return key


def verify(key: str, expected_rows: int) -> bool:
    """Read the object back and confirm it holds what was written.

    This is the "verify" in copy-verify-delete, and it is not ceremonial: an
    S3 PutObject can succeed while the object is unreadable (a truncated body, a
    bad encoding), and deleting on the strength of a 200 response alone is how
    an archive job destroys data it believes it saved.
    """
    try:
        body = S3.get_object(Bucket=ARCHIVE_BUCKET, Key=key)["Body"].read()
        rows = pq.read_table(io.BytesIO(body)).num_rows
    except Exception:
        logger.exception("verification failed for %s", key)
        return False

    if rows != expected_rows:
        logger.error("verification failed for %s: %d rows, expected %d", key, rows, expected_rows)
        return False
    return True


def register_partition(logical: str, year: str, month: str) -> None:
    """Make the partition visible to Athena.

    Failure here is logged and swallowed ON PURPOSE — and it is the ONLY place
    in this job where that is acceptable. The data is written and verified; an
    unregistered partition is invisible until the next run repairs it, whereas
    aborting would leave the DynamoDB items in place and the whole job would
    re-do the write next time.
    """
    location = f"s3://{ARCHIVE_BUCKET}/tables/{logical}/year={year}/month={month}/"
    try:
        GLUE.batch_create_partition(
            DatabaseName=GLUE_DATABASE,
            TableName=logical,
            PartitionInputList=[
                {
                    "Values": [year, month],
                    "StorageDescriptor": {
                        "Location": location,
                        "InputFormat": "org.apache.hadoop.hive.ql.io.parquet.MapredParquetInputFormat",
                        "OutputFormat": "org.apache.hadoop.hive.ql.io.parquet.MapredParquetOutputFormat",
                        "SerdeInfo": {
                            "SerializationLibrary": "org.apache.hadoop.hive.ql.io.parquet.serde.ParquetHiveSerDe"
                        },
                    },
                }
            ],
        )
    except GLUE.exceptions.EntityNotFoundException:
        logger.warning("Glue table %s.%s does not exist yet — partition not registered",
                       GLUE_DATABASE, logical)
    except Exception:
        logger.exception("could not register partition %s", location)


def delete_items(table: str, items: list[dict[str, Any]]) -> int:
    """Delete the archived items. Runs ONLY after a successful verify."""
    deleted = 0
    for start in range(0, len(items), DELETE_BATCH):
        batch = items[start : start + DELETE_BATCH]
        request = {
            table: [
                {"DeleteRequest": {"Key": {"pk": {"S": i["pk"]}, "sk": {"S": i["sk"]}}}}
                for i in batch
            ]
        }
        # Unprocessed items under throttling are retried rather than ignored.
        # Ignoring them leaves rows in DynamoDB that also exist in Parquet —
        # not data loss, but it makes the next run's counts inexplicable.
        for attempt in range(5):
            response = DYNAMODB.batch_write_item(RequestItems=request)
            unprocessed = response.get("UnprocessedItems", {})
            if not unprocessed:
                break
            request = unprocessed
        deleted += len(batch)
    return deleted


def handler(event: dict[str, Any], _context: Any) -> dict[str, Any]:
    """Entry point. Idempotent: re-running re-writes partitions it already wrote."""
    now = datetime.now(timezone.utc)
    cutoff = cutoff_iso(now)
    # `dry_run` is an operator escape hatch for the first run in a new
    # environment, where seeing what WOULD be deleted is worth a round trip.
    dry_run = bool(event.get("dry_run", False))

    logger.info("age-out starting: cutoff=%s dry_run=%s", cutoff, dry_run)
    summary: dict[str, Any] = {"cutoff": cutoff, "dry_run": dry_run, "tables": {}}

    for logical, sort_prefix in AGED_TABLES.items():
        table = f"{TABLE_PREFIX}-{logical}"
        items = list(scan_cold_items(table, sort_prefix, cutoff))

        if not items:
            summary["tables"][logical] = {"archived": 0, "deleted": 0}
            continue

        partitions: dict[tuple[str, str], list[dict[str, Any]]] = {}
        for item in items:
            partitions.setdefault(partition_of(item), []).append(item)

        archived = 0
        deleted = 0
        for (year, month), rows in sorted(partitions.items()):
            if dry_run:
                archived += len(rows)
                continue

            key = write_parquet(logical, year, month, rows)
            if not verify(key, len(rows)):
                # Stop this table entirely. Continuing to the next partition
                # would delete items whose sibling partition is known bad.
                logger.error("aborting %s: %s did not verify", logical, key)
                break

            register_partition(logical, year, month)
            archived += len(rows)
            deleted += delete_items(table, rows)

        summary["tables"][logical] = {"archived": archived, "deleted": deleted}
        logger.info("%s: archived %d, deleted %d", logical, archived, deleted)

    logger.info("age-out complete: %s", json.dumps(summary))
    return summary
