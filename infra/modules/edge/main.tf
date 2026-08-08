# module: edge — the front door. Nothing in the platform is reachable around it.
#
# One CloudFront distribution fronts both the SPA and the API, because two
# distributions would mean two hostnames, two certificates, and a cross-origin
# problem that only exists because of the split.
#
# The certificate and the Lambda@Edge function MUST live in us-east-1 (ADR-0017);
# everything else follows the default provider.

locals {
  # Lambda@Edge has no environment variables, so everything the function needs
  # before its first network call is synthesized into the bundle as config.json.
  # THIS FILE DOES NOT EXIST ON DISK — do not go looking for it in src/auth/.
  edge_config = {
    fqdn        = var.fqdn
    extraHosts  = var.extra_hosts
    ssmPrefix   = "/${var.app_name}/${var.environment}"
    ssmRegion   = var.region
    environment = var.environment
  }

  s3_origin_id     = "spa"
  api_origin_id    = "api"
  api_origin_host  = replace(replace(var.api_function_url, "https://", ""), "/", "")
  auth_source_dir  = "${path.module}/src/auth"
  auth_bundle_path = "${path.module}/.build/${var.name_prefix}-edge-auth.zip"
}

# --- The authenticator bundle ------------------------------------------------
# Sources are listed EXPLICITLY. A module that is imported by index.mjs but not
# listed here passes every local test and then fails at the edge with a module
# resolution error, because the zip simply does not contain it.

data "archive_file" "auth" {
  type        = "zip"
  output_path = local.auth_bundle_path

  source {
    content  = file("${local.auth_source_dir}/index.mjs")
    filename = "index.mjs"
  }
  source {
    content  = file("${local.auth_source_dir}/routing.mjs")
    filename = "routing.mjs"
  }
  source {
    content  = file("${local.auth_source_dir}/crypto.mjs")
    filename = "crypto.mjs"
  }
  source {
    content  = file("${local.auth_source_dir}/providers.mjs")
    filename = "providers.mjs"
  }
  source {
    content  = file("${local.auth_source_dir}/config.mjs")
    filename = "config.mjs"
  }
  source {
    content  = jsonencode(local.edge_config)
    filename = "config.json"
  }
}

resource "aws_lambda_function" "auth" {
  provider = aws.us_east_1

  function_name = "${var.name_prefix}-edge-auth"
  description   = "Sole authenticator for ${var.fqdn}. Runs at viewer-request on every behaviour."

  filename         = data.archive_file.auth.output_path
  source_code_hash = data.archive_file.auth.output_base64sha256

  runtime = "nodejs22.x"
  handler = "index.handler"
  role    = aws_iam_role.edge.arn

  # Lambda@Edge viewer-request limits: 128MB, 5s, and no environment variables.
  # These are hard service limits, not tuning choices.
  memory_size = 128
  timeout     = 5

  # Required: CloudFront associates a specific numbered version, never $LATEST,
  # so every config change produces a new version and a distribution update.
  publish = true

  tags = { Name = "${var.name_prefix}-edge-auth" }
}

resource "aws_iam_role" "edge" {
  provider = aws.us_east_1
  name     = "${var.name_prefix}-edge-auth"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = {
        # BOTH principals. `edgelambda` is what actually invokes the replica;
        # omitting it produces a function that deploys fine and is never called.
        Service = ["lambda.amazonaws.com", "edgelambda.amazonaws.com"]
      }
      Action = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "edge" {
  provider = aws.us_east_1
  name     = "config"
  role     = aws_iam_role.edge.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "ReadOwnEnvironmentConfig"
        Effect = "Allow"
        Action = ["ssm:GetParameter", "ssm:GetParameters", "ssm:GetParametersByPath"]
        # Both forms: the prefix itself for GetParametersByPath, and everything
        # beneath it. Granting only the wildcard makes the recursive read fail
        # in a way that looks like an empty configuration.
        Resource = [
          "arn:aws:ssm:${var.region}:${var.account_id}:parameter/${var.app_name}/${var.environment}",
          "arn:aws:ssm:${var.region}:${var.account_id}:parameter/${var.app_name}/${var.environment}/*",
        ]
      },
      {
        Sid      = "DecryptSecureStrings"
        Effect   = "Allow"
        Action   = ["kms:Decrypt"]
        Resource = "*"
        Condition = {
          StringEquals = { "kms:ViaService" = "ssm.${var.region}.amazonaws.com" }
        }
      },
      {
        Sid    = "Logs"
        Effect = "Allow"
        Action = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
        # Edge replicas log into the region that served the request, under an
        # account-scoped group name this role cannot predict — so the resource
        # genuinely cannot be narrowed further than the account.
        Resource = "arn:aws:logs:*:${var.account_id}:log-group:/aws/lambda/us-east-1.${var.name_prefix}-edge-auth:*"
      },
    ]
  })
}

# --- SPA assets --------------------------------------------------------------

resource "aws_s3_bucket" "spa" {
  bucket = "${var.name_prefix}-spa-${var.account_id}"
  tags   = { Name = "${var.name_prefix}-spa" }
}

resource "aws_s3_bucket_public_access_block" "spa" {
  bucket                  = aws_s3_bucket.spa.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "spa" {
  bucket = aws_s3_bucket.spa.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_cloudfront_origin_access_control" "spa" {
  name                              = "${var.name_prefix}-spa"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# The Function URL is AWS_IAM-authenticated; this OAC is how CloudFront signs
# for it. Without it the origin returns 403 to every request.
resource "aws_cloudfront_origin_access_control" "api" {
  name                              = "${var.name_prefix}-api"
  origin_access_control_origin_type = "lambda"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_s3_bucket_policy" "spa" {
  bucket = aws_s3_bucket.spa.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "AllowCloudFrontOAC"
      Effect    = "Allow"
      Principal = { Service = "cloudfront.amazonaws.com" }
      Action    = "s3:GetObject"
      Resource  = "${aws_s3_bucket.spa.arn}/*"
      Condition = {
        StringEquals = { "AWS:SourceArn" = aws_cloudfront_distribution.app.arn }
      }
    }]
  })
}

# --- Certificate -------------------------------------------------------------

resource "aws_acm_certificate" "cert" {
  provider = aws.us_east_1

  domain_name               = var.fqdn
  subject_alternative_names = var.extra_hosts
  validation_method         = "DNS"

  lifecycle {
    # A certificate cannot be replaced while a distribution references it, so
    # the replacement has to exist first.
    create_before_destroy = true
  }
}

resource "aws_route53_record" "cert_validation" {
  for_each = {
    for opt in aws_acm_certificate.cert.domain_validation_options :
    opt.domain_name => {
      name   = opt.resource_record_name
      record = opt.resource_record_value
      type   = opt.resource_record_type
    }
  }

  zone_id         = var.zone_id
  name            = each.value.name
  type            = each.value.type
  records         = [each.value.record]
  ttl             = 60
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "cert" {
  provider                = aws.us_east_1
  certificate_arn         = aws_acm_certificate.cert.arn
  validation_record_fqdns = [for r in aws_route53_record.cert_validation : r.fqdn]
}

# --- Distribution ------------------------------------------------------------

data "aws_cloudfront_cache_policy" "optimized" {
  name = "Managed-CachingOptimized"
}

data "aws_cloudfront_cache_policy" "disabled" {
  name = "Managed-CachingDisabled"
}

data "aws_cloudfront_origin_request_policy" "all_viewer_except_host" {
  # Forwards every viewer header EXCEPT Host. Host must not be forwarded to a
  # Lambda Function URL: the SigV4 signature covers it, and a mismatched Host
  # makes every signed request fail with 403.
  name = "Managed-AllViewerExceptHostHeader"
}

resource "aws_cloudfront_distribution" "app" {
  enabled             = true
  is_ipv6_enabled     = true
  comment             = "${var.name_prefix} — ${var.fqdn}"
  aliases             = concat([var.fqdn], var.extra_hosts)
  http_version        = "http2and3"
  price_class         = var.price_class
  default_root_object = "index.html"

  origin {
    domain_name              = aws_s3_bucket.spa.bucket_regional_domain_name
    origin_id                = local.s3_origin_id
    origin_access_control_id = aws_cloudfront_origin_access_control.spa.id
  }

  origin {
    domain_name              = local.api_origin_host
    origin_id                = local.api_origin_id
    origin_access_control_id = aws_cloudfront_origin_access_control.api.id

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
      origin_read_timeout    = 30
    }
  }

  default_cache_behavior {
    target_origin_id       = local.s3_origin_id
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]
    cache_policy_id        = data.aws_cloudfront_cache_policy.optimized.id
    compress               = true

    lambda_function_association {
      event_type = "viewer-request"
      # The qualified ARN, so the distribution pins a specific version. An
      # unqualified ARN is rejected by CloudFront outright.
      lambda_arn = aws_lambda_function.auth.qualified_arn
      # Viewer-request functions cannot read the request body, and this one has
      # no need to — every decision it makes is from headers and the URI.
      include_body = false
    }
  }

  ordered_cache_behavior {
    path_pattern           = "/api/*"
    target_origin_id       = local.api_origin_id
    viewer_protocol_policy = "https-only"
    allowed_methods        = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods         = ["GET", "HEAD"]
    # Never cache the API. A cached response would also serve one user's data
    # to a request that CloudFront considers equivalent.
    cache_policy_id          = data.aws_cloudfront_cache_policy.disabled.id
    origin_request_policy_id = data.aws_cloudfront_origin_request_policy.all_viewer_except_host.id
    compress                 = true

    lambda_function_association {
      event_type   = "viewer-request"
      lambda_arn   = aws_lambda_function.auth.qualified_arn
      include_body = false
    }
  }

  ordered_cache_behavior {
    path_pattern           = "/oauth2/*"
    target_origin_id       = local.s3_origin_id
    viewer_protocol_policy = "https-only"
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]
    cache_policy_id        = data.aws_cloudfront_cache_policy.disabled.id

    # Answered entirely at the edge — the origin is never reached on this path,
    # which is why its target origin is arbitrary.
    lambda_function_association {
      event_type   = "viewer-request"
      lambda_arn   = aws_lambda_function.auth.qualified_arn
      include_body = false
    }
  }

  # SPA deep links. Scoped to 403/404 from the S3 origin only; the API behaviour
  # has caching disabled so its own 404s are never rewritten into index.html.
  custom_error_response {
    error_code            = 403
    response_code         = 200
    response_page_path    = "/index.html"
    error_caching_min_ttl = 0
  }

  custom_error_response {
    error_code            = 404
    response_code         = 200
    response_page_path    = "/index.html"
    error_caching_min_ttl = 0
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn      = aws_acm_certificate_validation.cert.certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }

  tags = { Name = var.fqdn }
}

# --- DNS ---------------------------------------------------------------------

resource "aws_route53_record" "app" {
  for_each = toset(concat([var.fqdn], var.extra_hosts))

  zone_id = var.zone_id
  name    = each.value
  type    = "A"

  alias {
    name    = aws_cloudfront_distribution.app.domain_name
    zone_id = aws_cloudfront_distribution.app.hosted_zone_id
    # No health check: CloudFront is the health boundary, and an alias health
    # check on a global distribution has nothing meaningful to fail over to.
    evaluate_target_health = false
  }
}

resource "aws_route53_record" "app_ipv6" {
  for_each = toset(concat([var.fqdn], var.extra_hosts))

  zone_id = var.zone_id
  name    = each.value
  type    = "AAAA"

  alias {
    name                   = aws_cloudfront_distribution.app.domain_name
    zone_id                = aws_cloudfront_distribution.app.hosted_zone_id
    evaluate_target_health = false
  }
}

# --- The invoke permission, and why it lives here ---------------------------
#
# CloudFront signs origin requests to the Function URL with SigV4 through the
# OAC above; this permission is what makes that signature acceptable to Lambda.
#
# It sits in `edge` rather than `api` because it needs BOTH the function name
# and the distribution ARN. In `api` that would make `api` depend on `edge` for
# the ARN while `edge` already depends on `api` for the origin domain — a cycle
# between stacks, escapable only by widening the scope to every distribution in
# the account. Here the dependency runs one way and the scope stays exact.

resource "aws_lambda_permission" "api_invoke" {
  statement_id           = "AllowCloudFrontOAC"
  action                 = "lambda:InvokeFunctionUrl"
  function_name          = var.api_function_name
  principal              = "cloudfront.amazonaws.com"
  source_arn             = aws_cloudfront_distribution.app.arn
  function_url_auth_type = "AWS_IAM"
}

resource "aws_ssm_parameter" "distribution_id" {
  name        = "/${var.app_name}/${var.environment}/edge/distribution_id"
  description = "Target of the frontend deploy's cache invalidation."
  type        = "String"
  value       = aws_cloudfront_distribution.app.id
}

resource "aws_ssm_parameter" "spa_bucket" {
  name        = "/${var.app_name}/${var.environment}/edge/spa_bucket"
  description = "Sync target for the built SPA."
  type        = "String"
  value       = aws_s3_bucket.spa.bucket
}
