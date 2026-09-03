# Copilot Instructions

## Project Guidelines
- The openrct2-staff-manager project uses Conventional Commits enforced via husky commit-msg hook + commitlint, and release-please for automated versioning/changelog/releases (staying pre-1.0 with bump-minor-pre-major). No npm publish is needed; releases are GitHub-only with a bundled dist/staff-manager.js asset and an enriched release body built from a draft release that's published as the final workflow step (required for immutable releases).