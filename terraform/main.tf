#
# Gemini Enterprise Test Environment Terraform Configuration
# Mirrors testgebackupandrestorev2 architecture
#

terraform {
  required_version = ">= 1.5.0"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.30"
    }
    null = {
      source  = "hashicorp/null"
      version = "~> 3.2"
    }
  }
}

provider "google" {
  region = "us-central1"
}

# 1. Project Creation
resource "google_project" "test_env" {
  name            = var.project_id
  project_id      = var.project_id
  org_id          = var.org_id
  billing_account = var.billing_account_id
}

# 2. Enable Required APIs (exact services enabled in testgebackupandrestorev2)
locals {
  services = [
    "discoveryengine.googleapis.com",
    "dialogflow.googleapis.com",
    "iam.googleapis.com",
    "iamcredentials.googleapis.com",
    "cloudresourcemanager.googleapis.com",
    "serviceusage.googleapis.com",
    "aiplatform.googleapis.com",
    "storage.googleapis.com",
    "cloudkms.googleapis.com",
    "cloudtrace.googleapis.com",
    "logging.googleapis.com",
    "monitoring.googleapis.com"
  ]
}

resource "google_project_service" "apis" {
  for_each = toset(local.services)

  project                    = google_project.test_env.project_id
  service                    = each.key
  disable_on_destroy         = false
  disable_dependent_services = false

  depends_on = [google_project.test_env]
}

# 3. IAM Policy Bindings (mirroring testgebackupandrestorev2)

# 3a. DWD Migration Service Account -> Discovery Engine Admin
resource "google_project_iam_member" "dwd_sa_admin" {
  project = google_project.test_env.project_id
  role    = "roles/discoveryengine.admin"
  member  = "serviceAccount:${var.dwd_sa_email}"

  depends_on = [google_project_service.apis]
}

# 3b. Project Owner
resource "google_project_iam_member" "project_owner" {
  project = google_project.test_env.project_id
  role    = "roles/owner"
  member  = "user:${var.admin_user_email}"

  depends_on = [google_project_service.apis]
}

# 3c. Discovery Engine Editor
resource "google_project_iam_member" "de_editor" {
  project = google_project.test_env.project_id
  role    = "roles/discoveryengine.editor"
  member  = "user:${var.editor_user_email}"

  depends_on = [google_project_service.apis]
}

# 3d. Workforce Identity Federation (Entra ID) -> Agent User & Service Usage Consumer
resource "google_project_iam_member" "wif_agent_user" {
  project = google_project.test_env.project_id
  role    = "roles/discoveryengine.agentUser"
  member  = "principalSet://iam.googleapis.com/locations/global/workforcePools/${var.workforce_pool_id}/*"

  depends_on = [google_project_service.apis]
}

resource "google_project_iam_member" "wif_service_usage" {
  project = google_project.test_env.project_id
  role    = "roles/serviceusage.serviceUsageConsumer"
  member  = "principalSet://iam.googleapis.com/locations/global/workforcePools/${var.workforce_pool_id}/*"

  depends_on = [google_project_service.apis]
}

# 3e. Specific Entra ID User -> Discovery Engine User
resource "google_project_iam_member" "wif_specific_user" {
  count   = var.entra_user_email != "" ? 1 : 0
  project = google_project.test_env.project_id
  role    = "roles/discoveryengine.user"
  member  = "principal://iam.googleapis.com/locations/global/workforcePools/${var.workforce_pool_id}/subject/${var.entra_user_email}"

  depends_on = [google_project_service.apis]
}

# 4. Provision Discovery Engine Intranet App & Features
# Uses the exact configuration, feature flags, and modelConfigs matching testgebackupandrestorev2
resource "null_resource" "engine_provisioner" {
  triggers = {
    project_id   = google_project.test_env.project_id
    engine_id    = var.engine_id
    location     = var.location
    display_name = var.engine_display_name
  }

  provisioner "local-exec" {
    command = "bash ${path.module}/scripts/create_engine.sh \"${google_project.test_env.project_id}\" \"${var.location}\" \"${var.collection_id}\" \"${var.engine_id}\" \"${var.engine_display_name}\""
  }

  depends_on = [
    google_project_service.apis,
    google_project_iam_member.dwd_sa_admin,
    google_project_iam_member.project_owner
  ]
}
