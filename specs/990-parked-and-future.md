# 990 - Parked and future work (referenced, never scheduled)

## Parked by the founder (2026-09-21)

Do not schedule, do not build, do not let other specs depend on these:

- **Domain migration** - danlab.dev subdomains (accounts/devices style),
  Cloudflare Tunnel architecture for per-device reachability. Decision on
  record: Worker route for the cloud control plane, per-device tunnels for
  remote access - to be applied when the founder hands over domain access.
- **Mobile-to-cloud and mobile-to-desktop connection work.**
- **Rebrand items in parked tracks:** android, ios, cloudflare/enterprise/SBOM,
  dani-web. Rebrand slices 1-6 (desktop app + docs/Dockerfile) are NOT parked.

## Future, not scheduled (decisions on record)

- **Laya.** The founder asked whether Laya is in the current build; it is not,
  per his own settled architecture decision. Plan on record: ship Hermes-only,
  collect real routing data, then shadow-test Laya on three narrow decisions
  (intent class, tool family, needs-human-review) and enable it only if it
  beats the Hermes-only baseline. Laya never grants permission, invents tool
  arguments, owns retries, or executes effects.
- **Versioned memory sidecar** (append-only event log + derived records +
  background reconciler). Deferred by the founder: "implement later."
- **Local Whisper/Kokoro voice mode.** Models bundled (~153 MB) but native
  cross-platform inference unfinished; stays disabled until packaged native
  assets execute offline on every claimed platform with licensing documented.
- **Android** beyond debug-APK stage.
- **Promotion of `prod` to `main`.** Founder's explicit call, deferred until
  product integration is finished.
