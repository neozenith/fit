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
    Name        = "${var.name_prefix}-${each.key}"
    Description = each.value.description
    AgesOut     = tostring(each.value.ages_out)
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
# One Glue database per environment. The archive job registers partitions here,
# and the API's cold-path reads go through Athena against it.

resource "aws_glue_catalog_database" "archive" {
  name        = replace("${var.name_prefix}_archive", "-", "_")
  description = "Parquet archive of aged-out DynamoDB items for ${var.environment}."
}

# Athena needs somewhere to spill results. Its own prefix in the archive bucket
# rather than its own bucket: the lifecycle rule below is the only thing that
# has to be right, and results are worthless after the request that made them.
resource "aws_s3_bucket_lifecycle_configuration" "athena_results" {
  bucket = aws_s3_bucket.archive.id
  rule {
    id     = "expire-athena-results"
    status = "Enabled"
    filter {
      prefix = "athena-results/"
    }
    expiration {
      days = 7
    }
  }
  depends_on = [aws_s3_bucket_lifecycle_configuration.archive]
}

resource "aws_athena_workgroup" "app" {
  name = "${var.name_prefix}-app"

  configuration {
    enforce_workgroup_configuration    = true
    publish_cloudwatch_metrics_enabled = true

    # A per-query byte cap is the only real guard against a `SELECT *` over the
    # whole archive. Set low deliberately: every legitimate query here is
    # partition-pruned to a handful of months.
    bytes_scanned_cutoff_per_query = var.athena_scan_limit_bytes

    result_configuration {
      output_location = "s3://${aws_s3_bucket.archive.bucket}/athena-results/"
      encryption_configuration {
        encryption_option = "SSE_S3"
      }
    }
  }
}

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

resource "aws_ssm_parameter" "glue_database" {
  name  = "/${var.app_name}/${var.environment}/data/glue_database"
  type  = "String"
  value = aws_glue_catalog_database.archive.name
}

resource "aws_ssm_parameter" "athena_workgroup" {
  name  = "/${var.app_name}/${var.environment}/data/athena_workgroup"
  type  = "String"
  value = aws_athena_workgroup.app.name
}
