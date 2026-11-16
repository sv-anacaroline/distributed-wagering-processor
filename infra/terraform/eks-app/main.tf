resource "kubernetes_namespace_v1" "wagering" {
  metadata { name = "wagering" }
}

resource "kubernetes_service_account_v1" "api" {
  metadata {
    name      = "wagering-api"
    namespace = kubernetes_namespace_v1.wagering.metadata[0].name
  }
}

resource "kubernetes_deployment_v1" "api" {
  metadata {
    name      = "wagering-api"
    namespace = kubernetes_namespace_v1.wagering.metadata[0].name
    labels    = { app = "wagering-api" }
  }

  spec {
    replicas = var.replicas
    selector { match_labels = { app = "wagering-api" } }
    strategy {
      type = "RollingUpdate"
      rolling_update {
        max_unavailable = "1"
        max_surge       = "1"
      }
    }
    template {
      metadata { labels = { app = "wagering-api" } }
      spec {
        service_account_name             = kubernetes_service_account_v1.api.metadata[0].name
        termination_grace_period_seconds = 60
        security_context { fs_group = 1000 }

        volume {
          name = "db-credentials"
          empty_dir { medium = "Memory" }
        }

        # EKS Pod Identity provides temporary credentials to fetch the RDS-managed secret.
        init_container {
          name  = "read-db-credentials"
          image = "public.ecr.aws/aws-cli/aws-cli:2"
          command = ["/bin/sh", "-ec"]
          args = [<<-EOT
            aws secretsmanager get-secret-value --region "$AWS_REGION" --secret-id "$DB_SECRET_ARN" --query SecretString --output text > /secrets/db.json
            chgrp 1000 /secrets/db.json
            chmod 0640 /secrets/db.json
          EOT
          ]
          env {
            name  = "AWS_REGION"
            value = var.aws_region
          }
          env {
            name  = "DB_SECRET_ARN"
            value = var.postgres_secret_arn
          }
          volume_mount {
            name       = "db-credentials"
            mount_path = "/secrets"
          }
        }

        container {
          name              = "api"
          image             = "${var.image_repository}:${var.image_tag}"
          image_pull_policy = "IfNotPresent"
          command           = ["/bin/sh", "-ec"]
          # Password is read at runtime, never copied into Terraform state or k8s resources.
          args = [<<-EOT
            export DB_PASSWORD="$(bun -e "const fs=require('fs'); process.stdout.write(JSON.parse(fs.readFileSync('/secrets/db.json', 'utf8')).password)")"
            exec bun dist/main.js
          EOT
          ]
          port {
            name           = "http"
            container_port = 3000
          }
          env {
            name  = "NODE_ENV"
            value = "production"
          }
          env {
            name  = "PORT"
            value = "3000"
          }
          env {
            name  = "DB_HOST"
            value = var.postgres_host
          }
          env {
            name  = "DB_PORT"
            value = "5432"
          }
          env {
            name  = "DB_NAME"
            value = "wagering"
          }
          env {
            name  = "DB_USER"
            value = "wagering"
          }
          env {
            name  = "AWS_REGION"
            value = var.aws_region
          }
          env {
            name  = "SQS_WAGER_TRANSACTIONS_URL"
            value = var.sqs_wager_transactions_url
          }
          env {
            name  = "SQS_WAGER_EVENTS_URL"
            value = var.sqs_wager_events_url
          }
          volume_mount {
            name       = "db-credentials"
            mount_path = "/secrets"
            read_only  = true
          }
          security_context {
            run_as_user                = 1000
            run_as_group               = 1000
            run_as_non_root            = true
            allow_privilege_escalation = false
            read_only_root_filesystem  = true
            capabilities { drop = ["ALL"] }
          }
          resources {
            requests = { cpu = "100m", memory = "128Mi" }
            limits   = { cpu = "500m", memory = "512Mi" }
          }
          # Public health endpoints. Ready additionally checks PostgreSQL and SQS reachability.
          startup_probe {
            http_get {
              path = "/health/live"
              port = "http"
            }
            failure_threshold = 20
            period_seconds    = 5
          }
          readiness_probe {
            http_get {
              path = "/health/ready"
              port = "http"
            }
            period_seconds = 5
          }
          liveness_probe {
            http_get {
              path = "/health/live"
              port = "http"
            }
            period_seconds = 10
          }
        }
      }
    }
  }
  wait_for_rollout = true
}

resource "kubernetes_service_v1" "api" {
  metadata {
    name      = "wagering-api"
    namespace = kubernetes_namespace_v1.wagering.metadata[0].name
  }
  spec {
    selector = { app = "wagering-api" }
    type     = "ClusterIP"
    port {
      name        = "http"
      port        = 80
      target_port = "http"
    }
  }
}
