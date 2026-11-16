output "namespace" { value = kubernetes_namespace_v1.wagering.metadata[0].name }
output "service" { value = kubernetes_service_v1.api.metadata[0].name }
output "replicas" { value = var.replicas }
