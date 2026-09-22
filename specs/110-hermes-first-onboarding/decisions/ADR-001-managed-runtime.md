# ADR-001 - Bundle, verify, and atomically activate managed runtimes

Status: accepted for feasibility implementation; target shipment remains blocked on R-BOOT-001 evidence.

Use platform-specific bundled Hermes and supporting OpenCode payloads, verify them against the release manifest, activate into versioned Dani-owned storage, and use a verified update/repair path later. Reject first-run remote shell/package-manager installs. This is the only option that can support offline runtime preparation consistently across dmg, NSIS, AppImage, and deb. If a legal or compatible payload is unavailable for a target, fail that target and request a product decision rather than weakening the requirement.
