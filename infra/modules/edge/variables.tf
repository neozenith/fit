variable "app_name" { type = string }
variable "environment" { type = string }
variable "name_prefix" { type = string }
variable "account_id" { type = string }

variable "region" {
  description = <<-EOT
    Region the SSM parameters live in — NOT the region this module deploys to.
    The edge function runs wherever the viewer is, so its SSM client has to be
    pinned to one region explicitly or it looks for parameters in whichever
    replica region served the request and finds nothing.
  EOT
  type        = string
}

variable "fqdn" {
  description = "Canonical hostname. Any other Host is answered with 421."
  type        = string
}

variable "extra_hosts" {
  description = <<-EOT
    Additional hostnames this distribution answers on. Every entry must ALSO be
    registered as a redirect URI on the identity provider, because the OAuth
    redirect follows the viewer's host.
  EOT
  type        = list(string)
  default     = []
}

variable "zone_id" {
  description = "Route53 zone holding the apex. Looked up by name in the stack, never wired from a sibling stack's state."
  type        = string
}

variable "api_function_url" {
  description = "Full Function URL of the API lambda, read from SSM by the stack."
  type        = string
}

variable "api_function_name" {
  description = "API function name, so the invoke permission can be scoped to this distribution."
  type        = string
}

variable "price_class" {
  description = <<-EOT
    Edge locations to serve from. `PriceClass_100` (North America + Europe) is
    the cheapest, and wrong here: the only user is in Australia, which it does
    NOT cover. `PriceClass_All` is the correct choice for an Australian
    audience even though it is the most expensive class, because at this
    request volume the difference is cents and the latency difference is not.
  EOT
  type        = string
  default     = "PriceClass_All"

  validation {
    condition     = contains(["PriceClass_All", "PriceClass_200", "PriceClass_100"], var.price_class)
    error_message = "price_class must be one of PriceClass_All, PriceClass_200, PriceClass_100."
  }
}
