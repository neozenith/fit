# module: finops — cost reporting for the WHOLE account, deployed once.
#
# Not per-environment, and that is the central decision (ADR-0015). A Cost and
# Usage Report is account-scoped: three copies would export the same rows three
# times and triple the storage to answer the same question. One export, one
# catalogue, and every environment's API gets a read grant.
#
# The CUR definition itself must live in us-east-1 — AWS offers no choice.

locals {
  cur_prefix = "cur"
  # Data Exports writes to `{prefix}/{export-name}/data/...`, and the API's
  # Parquet glob has to point at exactly that path. Deriving it once here means
  # the two cannot drift - see `finops.prefix` in infra/stacks/api/config.yml.
  cur_data_path = "${local.cur_prefix}/${var.name_prefix}/data"
}

resource "aws_s3_bucket" "cur" {
  bucket = "${var.name_prefix}-${var.account_id}"
  tags   = { Name = var.name_prefix }
}

resource "aws_s3_bucket_public_access_block" "cur" {
  bucket                  = aws_s3_bucket.cur.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "cur" {
  bucket = aws_s3_bucket.cur.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "cur" {
  bucket = aws_s3_bucket.cur.id

  rule {
    id     = "archive-old-billing-periods"
    status = "Enabled"
    filter {
      prefix = "${local.cur_prefix}/"
    }
    # Billing data past two years is of historical interest only, and every
    # query the FinOps page makes is over the last six months.
    transition {
      days          = 400
      storage_class = "GLACIER_IR"
    }
  }
}

# The export service writes here on AWS's behalf, so the bucket policy has to
# name the billing principal explicitly. Without both statements the export
# reports "access denied" from a service that has no obvious identity.
resource "aws_s3_bucket_policy" "cur" {
  bucket = aws_s3_bucket.cur.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AllowBillingRead"
        Effect    = "Allow"
        Principal = { Service = "billingreports.amazonaws.com" }
        Action    = ["s3:GetBucketAcl", "s3:GetBucketPolicy"]
        Resource  = aws_s3_bucket.cur.arn
        Condition = {
          StringEquals = { "aws:SourceAccount" = var.account_id }
        }
      },
      {
        Sid       = "AllowBillingWrite"
        Effect    = "Allow"
        Principal = { Service = "billingreports.amazonaws.com" }
        Action    = "s3:PutObject"
        Resource  = "${aws_s3_bucket.cur.arn}/*"
        Condition = {
          StringEquals = { "aws:SourceAccount" = var.account_id }
        }
      },
      {
        Sid       = "DenyInsecureTransport"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:*"
        Resource  = [aws_s3_bucket.cur.arn, "${aws_s3_bucket.cur.arn}/*"]
        Condition = {
          Bool = { "aws:SecureTransport" = false }
        }
      },
    ]
  })
}

# --- The export --------------------------------------------------------------
# CUR 2.0 through Data Exports rather than the legacy report definition: it
# emits Parquet natively and carries the resource-level tag columns the FinOps
# page groups by, which legacy CUR only provides with extra configuration.

resource "aws_bcmdataexports_export" "cur" {
  provider = aws.us_east_1

  export {
    name = var.name_prefix

    data_query {
      # `resource_tags` is the column family that makes ADR-0014's tagging
      # useful — without selecting it, every row is attributable to a service
      # but to no project and no environment.
      query_statement = join(" ", [
        "SELECT",
        "bill_billing_period_start_date,",
        "line_item_usage_start_date,",
        "line_item_product_code,",
        "line_item_operation,",
        "line_item_unblended_cost,",
        "line_item_resource_id,",
        "resource_tags",
        "FROM COST_AND_USAGE_REPORT",
      ])
      table_configurations = {
        COST_AND_USAGE_REPORT = {
          # Include resources so per-resource tags survive into the export. This
          # multiplies row count substantially, which is why the lifecycle rule
          # above matters.
          INCLUDE_RESOURCES                     = "TRUE"
          INCLUDE_MANUAL_DISCOUNT_COMPATIBILITY = "FALSE"
          INCLUDE_SPLIT_COST_ALLOCATION_DATA    = "FALSE"
          TIME_GRANULARITY                      = "DAILY"
        }
      }
    }

    destination_configurations {
      s3_destination {
        s3_bucket = aws_s3_bucket.cur.bucket
        s3_prefix = local.cur_prefix
        s3_region = var.bucket_region

        s3_output_configurations {
          compression = "PARQUET"
          format      = "PARQUET"
          # OVERWRITE, not CREATE_NEW_REPORT: AWS restates a billing period for
          # days after it closes, and appending would leave both the draft and
          # the final figures in the table with no way to tell them apart.
          overwrite   = "OVERWRITE_REPORT"
          output_type = "CUSTOM"
        }
      }
    }

    refresh_cadence {
      frequency = "SYNCHRONOUS"
    }
  }
}

# --- No catalogue ------------------------------------------------------------
#
# Deleted with Glue and Athena (ADR-0025). The CUR is Parquet in S3 and the API
# Lambda reads it directly with DuckDB:
#
#   SELECT ... FROM read_parquet('s3://bucket/cur/**/*.parquet',
#                                hive_partitioning = true)
#
# The crawler that used to live here was the worst part of the old design: it
# ran on a schedule, so a freshly delivered export was invisible for hours, and
# it needed CombineCompatibleSchemas because a CUR gains columns whenever AWS
# adds a service — without which it silently created a NEW table and left the
# old one to go stale.

# --- Cross-stack contract ----------------------------------------------------
# Published at a GLOBAL path, not under an environment, because the values are
# identical everywhere. Publishing them per environment would imply a per
# environment truth that does not exist.

resource "aws_ssm_parameter" "bucket" {
  name  = "/${var.app_name}/global/finops/bucket"
  type  = "String"
  value = aws_s3_bucket.cur.bucket
}

resource "aws_ssm_parameter" "prefix" {
  name        = "/${var.app_name}/global/finops/prefix"
  description = "Where the export lands. The API globs beneath it; there is no catalogue to consult."
  type        = "String"
  value       = local.cur_data_path
}

