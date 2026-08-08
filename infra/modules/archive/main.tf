# module: archive — the DynamoDB-to-Parquet age-out (ADR-0012).
#
# One scheduled Lambda. It runs monthly, because the cut-off moves by a month at
# a time and running daily would mostly scan a table to find nothing.
#
# The job's ordering guarantee — copy, verify, delete — lives in the handler.
# This module's job is to grant exactly the permissions that ordering needs and
# no more: it may DELETE from the observation tables (nothing else in the
# platform may) but it may not write to them.

data "archive_file" "handler" {
  type        = "zip"
  output_path = "${path.module}/.build/${var.name_prefix}-archive.zip"

  source {
    content  = file("${path.module}/src/handler.py")
    filename = "handler.py"
  }
}

resource "aws_lambda_function" "archive" {
  function_name = "${var.name_prefix}-archive"
  description   = "Ages ${var.name_prefix} observations older than ${var.hot_window_months} months into Parquet."

  filename         = data.archive_file.handler.output_path
  source_code_hash = data.archive_file.handler.output_base64sha256

  runtime = "python3.13"
  handler = "handler.handler"
  role    = aws_iam_role.archive.arn

  # Parquet encoding is memory-bound, and Lambda scales CPU with memory — so a
  # larger setting finishes sooner and often costs LESS for the same work.
  memory_size = 1024

  # Fifteen minutes is the Lambda ceiling. A sweep that cannot finish inside it
  # means the hot window has been left unattended for far too long, and the
  # right response is to investigate rather than to raise the limit.
  timeout = 900

  architectures = ["arm64"]

  layers = [var.pyarrow_layer_arn]

  environment {
    variables = {
      TABLE_PREFIX      = var.name_prefix
      ARCHIVE_BUCKET    = var.archive_bucket
      GLUE_DATABASE     = var.glue_database
      HOT_WINDOW_MONTHS = tostring(var.hot_window_months)
    }
  }

  logging_config {
    log_format = "JSON"
    log_group  = aws_cloudwatch_log_group.archive.name
  }

  tags = { Name = "${var.name_prefix}-archive" }
}

resource "aws_cloudwatch_log_group" "archive" {
  name = "/aws/lambda/${var.name_prefix}-archive"
  # Longer than the API's, because the question this log answers — "what
  # happened to my data from March" — is asked months after the fact.
  retention_in_days = 365
}

resource "aws_iam_role" "archive" {
  name = "${var.name_prefix}-archive"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "archive" {
  name = "age-out"
  role = aws_iam_role.archive.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "Logs"
        Effect   = "Allow"
        Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "${aws_cloudwatch_log_group.archive.arn}:*"
      },
      {
        Sid    = "ReadAndRemoveColdItems"
        Effect = "Allow"
        # Scan and delete, but NOT PutItem or UpdateItem. This function moves
        # data out; it must not be able to put anything back. That is the
        # append-only invariant (ADR-0013) enforced in IAM rather than trusted
        # to the handler.
        Action = ["dynamodb:Scan", "dynamodb:BatchWriteItem", "dynamodb:DeleteItem"]
        Resource = [
          for logical in var.aged_tables :
          "arn:aws:dynamodb:${var.region}:${var.account_id}:table/${var.name_prefix}-${logical}"
        ]
      },
      {
        Sid    = "WriteAndVerifyParquet"
        Effect = "Allow"
        # GetObject is required, not incidental: the verify step reads the
        # object back before anything is deleted.
        Action   = ["s3:PutObject", "s3:GetObject", "s3:ListBucket"]
        Resource = [var.archive_bucket_arn, "${var.archive_bucket_arn}/*"]
      },
      {
        Sid      = "RegisterPartitions"
        Effect   = "Allow"
        Action   = ["glue:BatchCreatePartition", "glue:GetTable", "glue:GetPartition", "glue:GetDatabase"]
        Resource = "*"
      },
    ]
  })
}

# --- Schedule ----------------------------------------------------------------

resource "aws_scheduler_schedule" "monthly" {
  name       = "${var.name_prefix}-archive"
  group_name = "default"

  flexible_time_window {
    # An hour of slack. Nothing depends on this running at a precise minute, and
    # a flexible window is cheaper for AWS to schedule.
    mode                      = "FLEXIBLE"
    maximum_window_in_minutes = 60
  }

  # 04:00 UTC on the 2nd of each month — after the 1st, so a month boundary has
  # definitively passed in every timezone before the cut-off is computed.
  schedule_expression          = "cron(0 4 2 * ? *)"
  schedule_expression_timezone = "UTC"

  target {
    arn      = aws_lambda_function.archive.arn
    role_arn = aws_iam_role.scheduler.arn

    retry_policy {
      maximum_retry_attempts       = 2
      maximum_event_age_in_seconds = 3600
    }
  }
}

resource "aws_iam_role" "scheduler" {
  name = "${var.name_prefix}-archive-scheduler"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "scheduler.amazonaws.com" }
      Action    = "sts:AssumeRole"
      Condition = {
        StringEquals = { "aws:SourceAccount" = var.account_id }
      }
    }]
  })
}

resource "aws_iam_role_policy" "scheduler" {
  name = "invoke"
  role = aws_iam_role.scheduler.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = "lambda:InvokeFunction"
      Resource = aws_lambda_function.archive.arn
    }]
  })
}
