// Harness internals are a developer surface, not a product one (spec 110
// R-UI-001). Dani Bot ships exactly one user-facing runtime, so the engine
// matrix, install commands, Terminal actions and setup-guide links must not
// exist in a release build.
//
// `import.meta.env.DEV` resolves at build time, so Vite drops the guarded
// branches from the release bundle entirely. That is the point: the spec
// rejects runtime hiding, because CSS-hidden markup is still shipped, still
// in the DOM and still reachable.
export const HARNESS_UI = import.meta.env.DEV;
