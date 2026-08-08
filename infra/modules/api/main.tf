# module: api — one Lambda behind a Function URL.
#
# Scale-to-zero without a wake path (ADR-0003): there is no container to start,
# no VPC to attach to, and therefore no NAT gateway. Idle cost is zero.
#
# The Function URL is `AWS_IAM`-authenticated and reachable ONLY through
# CloudFront's origin access control. That is what stops the API being called
# around the edge authenticator — without it, the URL is a public endpoint and
# every guarantee in ADR-0009 evaporates.

data "archive_file" "bundle" {
  type        = "zip"
  source_dir  = var.bundle_dir
  output_path = "${path.module}/.build/${var.name_prefix}-api.zip"
}

resource "aws_lambda_function" "api" {
  function_name = "${var.name_prefix}-api"
  description   = "fit API for ${var.environment}. Reads DynamoDB hot window, Athena cold archive."

  filename         = data.archive_file.bundle.output_path
  source_code_hash = data.archive_file.bundle.output_base64sha256

  runtime = "nodejs22.x"
  handler = "index.handler"
  role    = aws_iam_role.api.arn

  # 512MB is well past what the workload needs, and that is the point: Lambda
  # scales CPU with memory, so a larger setting finishes faster and often costs
  # LESS for the same work. At this request volume the bill is noise either way.
  memory_size = 512
  timeout     = 29 # one second under CloudFront's 30s origin read timeout

  architectures = ["arm64"] # ~20% cheaper per GB-second than x86_64

  # DuckDB, which replaced Glue and Athena (ADR-0025). A LAYER rather than a
  # bundled dependency, so an application deploy re-uploads kilobytes instead of
  # 30MB.
  #
  # It must be built for linux-arm64: npm and bun resolve the native binding for
  # the BUILD HOST, so a layer built on a laptop ships the darwin binary and
  # fails at cold start with a module-resolution error that says nothing about
  # architecture.
  layers = [var.duckdb_layer_arn]

  environment {
    variables = {
      APP_NAME       = var.app_name
      ENVIRONMENT    = var.environment
      SSM_PREFIX     = "/${var.app_name}/${var.environment}"
      TABLE_PREFIX   = var.name_prefix
      ARCHIVE_BUCKET = var.archive_bucket
      # The FinOps stack is global and its identifiers do not vary per
      # environment — every environment reads the same cost data (ADR-0015).
      FINOPS_BUCKET = var.finops_bucket
      FINOPS_PREFIX = var.finops_prefix
      NODE_OPTIONS  = "--enable-source-maps"
    }
  }

  logging_config {
    log_format = "JSON"
    log_group  = aws_cloudwatch_log_group.api.name
  }

  tags = { Name = "${var.name_prefix}-api" }
}

resource "aws_cloudwatch_log_group" "api" {
  name = "/aws/lambda/${var.name_prefix}-api"
  # Logs are the only observability surface here; 30 days is long enough to
  # investigate anything and short enough that the retention cost stays at cents.
  retention_in_days = var.environment == "prod" ? 90 : 30
}

resource "aws_lambda_function_url" "api" {
  function_name = aws_lambda_function.api.function_name

  # NOT `NONE`. A public Function URL would be an un-authenticated path to the
  # API that bypasses the edge entirely.
  authorization_type = "AWS_IAM"
}

# NOTE: the `aws_lambda_permission` that lets CloudFront invoke this URL lives
# in the EDGE module, not here, and that placement is deliberate.
#
# The permission needs two facts: this function's name, and the distribution's
# ARN. If it lived here, `api` would depend on `edge` for the ARN while `edge`
# already depends on `api` for the origin domain — a cycle between two stacks
# that cannot be broken by ordering, only by weakening the permission to a
# wildcard over every distribution in the account.
#
# Putting it in `edge` makes the dependency one-directional: `api` publishes its
# identifiers to SSM, `edge` reads them, and the permission stays scoped to
# exactly one distribution.

# --- Permissions -------------------------------------------------------------

resource "aws_iam_role" "api" {
  name = "${var.name_prefix}-api"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "api" {
  name = "app"
  role = aws_iam_role.api.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat(
      [
        {
          Sid    = "Logs"
          Effect = "Allow"
          Action = ["logs:CreateLogStream", "logs:PutLogEvents"]
          # Scoped to this function's own group. A wildcard here would let a
          # compromised handler write into any other service's logs.
          Resource = "${aws_cloudwatch_log_group.api.arn}:*"
        },
        {
          Sid    = "HotData"
          Effect = "Allow"
          Action = [
            "dynamodb:GetItem",
            "dynamodb:BatchGetItem",
            "dynamodb:Query",
            "dynamodb:PutItem",
            "dynamodb:BatchWriteItem",
          ]
          # No DeleteItem and no UpdateItem: observations are append-only
          # (ADR-0013), and the age-out job is the only thing that deletes.
          # Enforcing that in IAM means a handler bug cannot rewrite history.
          Resource = concat(
            values(var.table_arns),
            [for arn in values(var.table_arns) : "${arn}/index/*"],
          )
        },
        {
          Sid      = "ReadConfig"
          Effect   = "Allow"
          Action   = ["ssm:GetParameter", "ssm:GetParameters", "ssm:GetParametersByPath"]
          Resource = "arn:aws:ssm:${var.region}:${var.account_id}:parameter/${var.app_name}/${var.environment}/*"
        },
        {
          Sid      = "ArchiveObjects"
          Effect   = "Allow"
          Action   = ["s3:GetObject", "s3:ListBucket", "s3:PutObject", "s3:GetBucketLocation"]
          Resource = [var.archive_bucket_arn, "${var.archive_bucket_arn}/*"]
        },
      ],
      # FinOps data is account-scoped and lives outside this environment's
      # namespace (ADR-0015). Read-only, and only when a bucket was supplied —
      # so an environment deployed before the global stack still works.
      var.finops_bucket_arn == "" ? [] : [
        {
          Sid      = "FinOpsRead"
          Effect   = "Allow"
          Action   = ["s3:GetObject", "s3:ListBucket", "s3:GetBucketLocation"]
          Resource = [var.finops_bucket_arn, "${var.finops_bucket_arn}/*"]
        },
      ],
    )
  })
}

resource "aws_ssm_parameter" "function_url" {
  name        = "/${var.app_name}/${var.environment}/api/function_url"
  description = "Origin domain for the edge stack. Published here rather than via remote state (ADR-0008)."
  type        = "String"
  value       = aws_lambda_function_url.api.function_url
}
