variable "VERSION" { default = "migration-candidate" }
variable "REGISTRY" { default = "canvas-grove" }
variable "TARGET_PLATFORMS" { default = ["linux/amd64"] }
variable "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY" { default = "" }

group "default" {
  targets = ["app", "migrator", "worker", "orchestrator", "browser"]
}

target "web-base" {
  context = "."
  dockerfile = "Dockerfile"
  platforms = TARGET_PLATFORMS
  args = { NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY }
}

target "app" {
  inherits = ["web-base"]
  target = "runner"
  tags = ["${REGISTRY}/app:${VERSION}"]
}

target "migrator" {
  inherits = ["web-base"]
  target = "builder"
  tags = ["${REGISTRY}/migrator:${VERSION}"]
}

target "worker" {
  inherits = ["web-base"]
  target = "sync-worker"
  tags = ["${REGISTRY}/worker:${VERSION}"]
}

target "orchestrator" {
  context = "services/browser-orchestrator"
  dockerfile = "Dockerfile"
  platforms = TARGET_PLATFORMS
  tags = ["${REGISTRY}/orchestrator:${VERSION}"]
}

target "browser" {
  context = "browser/browser-image"
  dockerfile = "Dockerfile"
  platforms = TARGET_PLATFORMS
  tags = ["${REGISTRY}/browser:${VERSION}"]
}
