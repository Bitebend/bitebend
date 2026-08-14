---
name: Imported project verification constraints
description: Environment-specific compatibility findings from validating the Bitebend monorepo without changing application logic.
---

The imported workspace currently runs on Node 24 while the root package declares a Node 20 engine. The main application builds and typechecks successfully under Node 24, but the standalone WhatsApp Bridge TypeScript build exposes inferred Express types that are not portable with the installed dependency graph. The combined launcher also overlaps with separate artifact workflows on ports 8080, 5000, and 5173.

**Why:** Replit can expose both the generated artifact workflows and the repository's combined launcher, so starting all of them together creates misleading port-conflict errors even though the individual services are reachable.

**How to apply:** Preserve the existing application structure during inspection. Before changing workflows, choose one launch model explicitly and verify port ownership. Treat bridge typecheck errors and the menu snapshot mock mismatch as separate follow-up work, not setup changes.