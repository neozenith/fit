# module: data — the durable stores.
#
# Two shapes of table, and the difference decides everything about them:
#
#   CONFIG tables are small, always hot, and read on every page load. They are
#   never aged out (ADR-0012) because there is nothing to save and everything
#   to lose by moving them.
#
#   OBSERVATION tables grow forever and are read interactively only for the
#   recent past. They carry a `pk`/`sk` design whose sort key begins with the
#   timestamp precisely so the age-out job can range-query a cut-off without a
#   scan.

locals {
  # Every table is keyed by user from day one even though exactly one user is
  # admitted (ADR-0018). Multi-user later is a policy change, not a migration.
  tables = {
    blocks = {
      description = "Block configuration: seed 1RMs, units, start date, accessory choices."
      ages_out    = false
    }
    sets = {
      description = "Logged training sets. The largest table by a wide margin."
      ages_out    = true
    }
    measurements = {
      description = "Body weight and circumference observations."
      ages_out    = true
    }
    cardio = {
      description = "Non-strength activities: rows, runs, rides."
      ages_out    = true
    }
    season = {
      description = "The hand-authored season plan: which week is which block."
      ages_out    = false
    }
  }
}

resource "aws_dynamodb_table" "table" {
  for_each = local.tables

  name = "${var.name_prefix}-${each.key}"

  # PAY_PER_REQUEST is the whole point (ADR-0003): a table nobody touches for a
  # week bills for stored bytes and nothing else. Provisioned capacity would
  # put a floor under the idle cost of every environment.
  billing_mode = "PAY_PER_REQUEST"

  hash_key  = "pk"
  range_key = "sk"

  attribute {
    name = "pk"
    type = "S"
  }
  attribute {
    name = "sk"
    type = "S"
  }

  # Point-in-time recovery on the tables that hold irreplaceable history.
  # A logged set from eight months ago cannot be reconstructed from anywhere.
  point_in_time_recovery {
    enabled = each.value.ages_out || each.key == "blocks"
  }

  # Deletion protection everywhere except dev, where rebuilding from scratch is
  # a feature rather than a disaster.
  deletion_protection_enabled = var.environment != "dev"

  server_side_encryption {
    enabled = true
  }

  tags = {
    Name = "${var.name_prefix}-${each.key}"
    # `AgesOut` is a tag because it is a FACT AN OPERATOR FILTERS ON — "show me
    # every table the archive job touches" is a real question.
    #
    # `description` is deliberately NOT a tag. It was, and AWS rejected the
    # apply: tag values reject the punctuation ordinary prose is full of, so a
    # perfectly good sentence becomes `ValidationException: The Tag Value
    # provided is invalid`. Prose belongs in the `locals` block above, where it
    # is read by people rather than validated by an API.
    AgesOut = tostring(each.value.ages_out)
  }
}

# --- Cold storage ------------------------------------------------------------
# Parquet written by the archive job, queried through Athena. Separate bucket
# from anything else so a lifecycle rule here can never touch application
# assets, and so its cost line is unambiguous.

resource "aws_s3_bucket" "archive" {
  bucket = "${var.name_prefix}-archive-${var.account_id}"
  tags = {
    Name = "${var.name_prefix}-archive"
  }
}

resource "aws_s3_bucket_public_access_block" "archive" {
  bucket                  = aws_s3_bucket.archive.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "archive" {
  bucket = aws_s3_bucket.archive.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_versioning" "archive" {
  bucket = aws_s3_bucket.archive.id
  versioning_configuration {
    # Versioning is on because the age-out job's failure mode is re-writing a
    # partition it already wrote (ADR-0012's copy-verify-delete ordering
    # tolerates duplicates, not corruption). A version history makes an
    # incorrect overwrite recoverable.
    status = "Enabled"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "archive" {
  bucket = aws_s3_bucket.archive.id

  rule {
    id     = "transition-cold-partitions"
    status = "Enabled"

    filter {
      prefix = "tables/"
    }

    # Data lands here already cold — it was aged out precisely because nothing
    # reads it interactively. Ninety days is enough for the migration itself to
    # be verified before the retrieval cost of Glacier applies.
    transition {
      days          = 90
      storage_class = "GLACIER_IR"
    }

    noncurrent_version_expiration {
      noncurrent_days = 30
    }
  }

  rule {
    id     = "abort-incomplete-uploads"
    status = "Enabled"
    filter {}
    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

# --- Query surface -----------------------------------------------------------
#
# There is none, and that is the point (ADR-0025). The archive is Parquet in S3,
# read directly by DuckDB inside the API Lambda:
#
#   SELECT ... FROM read_parquet('s3://bucket/tables/sets/**/*.parquet',
#                                hive_partitioning = true)
#
# The S3 LAYOUT is the schema. No Glue database to register, no crawler to run
# on a schedule, no Athena workgroup, and no results prefix to expire. Data is
# queryable the moment it is written, because writing the file IS publishing it.

# --- Cross-stack contract ----------------------------------------------------
# Published as SSM parameters, never as remote state (ADR-0008). A reader needs
# only IAM on this prefix, not the writer's backend credentials.

resource "aws_ssm_parameter" "table_names" {
  for_each = local.tables

  name  = "/${var.app_name}/${var.environment}/data/table/${each.key}"
  type  = "String"
  value = aws_dynamodb_table.table[each.key].name
}

resource "aws_ssm_parameter" "archive_bucket" {
  name  = "/${var.app_name}/${var.environment}/data/archive_bucket"
  type  = "String"
  value = aws_s3_bucket.archive.bucket
}

