# Deploy a single-node enterprise server

Status: Superseded by [ADR 0024](./0024-adopt-a-personal-first-pi-rpc-workbench.md) on 2026-08-18.

ScopeGuard V1 will deploy its enterprise server as a single Docker Compose stack
containing the application service and PostgreSQL. The application owns login,
Member administration, Agent Templates, Provider and Model proxying, and the
read-only enterprise knowledge MCP client. Provider and MCP credentials are
encrypted at rest with a deployment-supplied master key, and TLS terminates at
the company's existing reverse proxy. Redis, message queues, object storage,
Kubernetes, high availability, and horizontal scaling are deferred; V1 must
instead provide tested PostgreSQL backup and restore procedures. The ten-Member
pilot baseline is 4 vCPU, 8 GB RAM, and 100 GB SSD, validated with 20 concurrent
Model streams and 10 concurrent enterprise knowledge MCP queries; Model
inference, embeddings, and enterprise RAG run outside this server.
