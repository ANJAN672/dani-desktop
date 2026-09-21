# Baseline test evidence

Combined prod integration at `11c5f3f3` passed local typecheck, lint with zero errors, production build, and 147 focused tests with one skip. CI run https://github.com/somdipto/dani-desktop/actions/runs/35553259211 passed control-plane, Ubuntu, macOS, Swift/iOS and Kotlin/Android jobs. It failed on two infrastructure-owned cases: Windows speech-manifest path separators and Linux SBOM Cargo package identity. Those failures are not waived.

The SDD documentation integration must pass: owner-supplied kit checker, frontmatter/name validation for project-local skills, no-secret scan, Markdown link/path checks, repository typecheck, and clean diff inspection. Production functionality is not inferred from a documentation checker.
