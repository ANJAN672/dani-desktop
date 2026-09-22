// PATH augmentation for GUI launches — the fix for "CLI not found" when
// the app is opened from Finder (issues #8, #12).
//
// A macOS app launched from Finder inherits a bare PATH
// (/usr/bin:/bin:...): no ~/.local/bin (the claude installer default),
// no /opt/homebrew/bin, and no nvm/volta/asdf shims — those only exist
// in interactive shells. The terminal sees the CLIs; the packaged app
// doesn't. So every spawn of an agent CLI goes through augmentedPath():
// the inherited PATH, plus the well-known install locations that exist
// on this machine, plus (async, best-effort) whatever PATH the user's
// real login shell reports.
import { execFile } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, extname, join } from "node:path";

/** nvm keeps every node version's bin dir separately; newest first so a
 * CLI installed under the latest node wins. */
function nvmBinDirs(): string[] {
  try {
    const base = join(homedir(), ".nvm", "versions", "node");
    return readdirSync(base)
      .filter((v) => v.startsWith("v"))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      .map((v) => join(base, v, "bin"));
  } catch {
    return [];
  }
}

function knownDirs(): string[] {
  const home = homedir();
  return [
    join(home, ".local", "bin"), // claude installer default
    join(home, ".npm-global", "bin"), // npm prefix ~/.npm-global (claude, opencode)
    join(home, ".kimi-code", "bin"), // kimi-code installer
    join(home, ".grok", "bin"), // x.ai installer
    join(home, ".opencode", "bin"), // opencode installer
    join(home, ".claude", "local"), // claude "local install"
    "/opt/homebrew/bin", // brew, Apple silicon
    "/usr/local/bin", // brew Intel / classic installs
    join(home, ".volta", "bin"),
    join(home, ".bun", "bin"),
    join(home, ".asdf", "shims"),
    join(home, ".deno", "bin"),
    join(home, "bin"),
    ...nvmBinDirs(),
  ];
}

/** Windows equivalents of knownDirs. A GUI app inherits the user PATH at
 * launch, but only at launch: a CLI installed while the app is running is
 * invisible until it restarts, because Windows never pushes PATH changes
 * into a live process. Scanning the standard install locations recovers
 * those without a restart — `~/.grok/bin` (the x.ai installer) and
 * `%APPDATA%\npm` (global npm shims), plus `%LOCALAPPDATA%\agy\bin`, cover
 * every engine we ship an install command for. */
function windowsKnownDirs(): string[] {
  const home = homedir();
  const appData = process.env.APPDATA ?? join(home, "AppData", "Roaming");
  const localAppData = process.env.LOCALAPPDATA ?? join(home, "AppData", "Local");
  return [
    join(appData, "npm"), // npm -g shims: claude, codex
    join(home, ".grok", "bin"), // x.ai installer
    join(localAppData, "agy", "bin"), // Antigravity installer
    join(home, ".local", "bin"), // claude native installer
    join(home, ".claude", "local"),
    join(home, "bin"), // Factory droid installer (%USERPROFILE%\bin)
    join(home, ".bun", "bin"),
    join(home, ".deno", "bin"),
    join(home, "go", "bin"),
  ];
}

let cached: string | null = null;
let probed = false;
let loginShellPath: string | null = null;

/** Drop the memoized PATH so the next augmentedPath() rescans. Called when
 * the app re-probes engines, so "check again" can find something installed
 * since launch instead of answering from the PATH we booted with. `probed`
 * must reset too: the login-shell probe merges rc-file PATH entries (e.g.
 * ~/.kimi-code/bin exported from .zshrc) into the cache asynchronously,
 * and without resetting it a rescan would rebuild the cache without those
 * entries and never re-probe — "check again" would permanently lose
 * anything only the login shell's rc file knows about. */
export function resetPathCache(): void {
  cached = null;
  probed = false;
}

/** Current best PATH, synchronously. Cheap after the first call. */
export function augmentedPath(): string {
  if (cached === null) {
    const extraPath = process.env.DANI_EXTRA_PATH ?? process.env.OMB_EXTRA_PATH;
    cached = mergePaths([
      ...(extraPath ? extraPath.split(delimiter) : []),
      ...(process.env.PATH ? process.env.PATH.split(delimiter) : []),
      // Keep the last successful login-shell result while a rescan starts a
      // fresh asynchronous probe. Otherwise resetPathCache() would make
      // rc-only CLIs disappear again for the response that triggered it.
      ...(loginShellPath ? loginShellPath.split(delimiter) : []),
      // Both platforms scan their standard install locations; only the
      // login-shell probe below stays unix-only, since Windows has no
      // equivalent rc file to source.
      ...(process.platform === "win32" ? windowsKnownDirs() : knownDirs()).filter((d) => existsSync(d)),
    ]);
  }
  // belt-and-braces: fold in the login shell's PATH once, in the
  // background — catches anything the known-dirs list doesn't (custom
  // rc exports). Never blocks a spawn; the next one benefits.
  if (!probed && !process.env.VITEST && process.platform !== "win32") {
    probed = true;
    probeLoginShellPath();
  }
  return cached;
}

function mergePaths(parts: string[]): string {
  return [...new Set(parts.filter(Boolean))].join(delimiter);
}

function probeLoginShellPath(): void {
  const shell = process.env.SHELL || "/bin/zsh";
  // -l -i: nvm and friends live in .zshrc/.bashrc, which only interactive
  // shells read. A marker isolates $PATH from any rc-file noise.
  execFile(
    shell,
    ["-l", "-i", "-c", 'printf "__DANI_PATH__%s" "$PATH"'],
    { timeout: 5000 },
    (err, stdout) => {
      if (err || !stdout) return;
      const m = /__DANI_PATH__([^\n]*)/.exec(stdout);
      if (!m || !m[1]) return;
      loginShellPath = m[1];
      cached = mergePaths([...(cached ?? "").split(delimiter), ...m[1].split(delimiter)]);
    },
  );
}

/** Test hook — the cache is process-wide otherwise. */
export function resetPathCacheForTests(): void {
  cached = null;
  probed = false;
  loginShellPath = null;
}

/** Every `name` binary on the augmented PATH as absolute paths, in PATH
 * order (first = what a bare name would run). Used by the Engines panel's
 * "detected" dropdown and the /api/cli-candidates endpoint. A path-ish
 * name is echoed back as-is — it already IS a location. */
export function findCliCandidates(name: string): string[] {
  if (!name || /[\n\r]/.test(name)) return [];
  if (/[/\\]/.test(name) || /^[a-zA-Z]:/.test(name)) return [name];
  const exts = process.platform === "win32" ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean) : [""];
  const out: string[] = [];
  for (const dir of augmentedPath().split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = join(dir, name + ext);
      if (existsSync(p)) {
        out.push(p);
        break;
      }
    }
  }
  return out;
}

// Windows CLI resolution ───────────────────────────────────────────────
// PATH alone is not enough on Windows. libuv ignores PATHEXT, so
// spawn("claude") never finds claude.cmd — and since Node's
// CVE-2024-27980 fix, spawning a .cmd without shell:true throws
// synchronously anyway. shell:true is not an option here: the drivers
// pass raw JSON in argv (claude's --mcp-config), which cmd would mangle.
// Windows also has no #! support, so a node-shebang script (every fake
// CLI in server/testing) is unspawnable as itself.
//
// So resolve the real file ourselves, PATHEXT-aware, and turn what we
// find into a spawn that needs no shell: npm's .cmd shims are parsed
// down to the .exe or node script they wrap, and shebang scripts become
// `node <script>`. An unknown shim is deliberately left unspawnable instead
// of crossing the repository's no-shell security boundary.

export interface ResolvedSpawn {
  command: string;
  args: string[];
  /**
   * Variables the launcher set before invoking the command.
   *
   * A `.cmd` launcher that configures its interpreter (a module search path,
   * a no-user-site flag) and then runs an executable is not decoration: run
   * the executable without them and it fails, or worse, silently resolves
   * different code. Resolving the command means resolving what it was going to
   * run with.
   */
  env?: Record<string, string>;
}

/** Split a `cli` string into [command, ...fixedArgs] on unquoted whitespace —
 * a mini tokenizer, never a shell. Quotes group segments (paths with spaces,
 * fixed args with spaces); no escapes, no substitution, nothing evaluated. */
export function splitCliString(cli: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  for (const ch of cli.trim()) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (cur) out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur) out.push(cur);
  return out;
}

function isFile(p: string): boolean {
  try {
    return statSync(p, { throwIfNoEntry: false })?.isFile() ?? false;
  } catch {
    return false;
  }
}

/** PATHEXT-aware `which`. A path-ish cli is probed where it points. */
function whichWin(cli: string): string | null {
  const exts = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  // an extensionless name is not runnable on Windows, so PATHEXT wins over
  // the bare file — npm installs both `claude` (a sh script) and `claude.cmd`
  const probe = (base: string) => {
    const order = extname(base) ? [base, ...exts.map((e) => base + e)] : [...exts.map((e) => base + e), base];
    return order.find(isFile) ?? null;
  };
  if (/[\\/]/.test(cli) || /^[a-zA-Z]:/.test(cli)) return probe(cli);
  for (const dir of augmentedPath().split(delimiter)) {
    if (!dir) continue;
    const hit = probe(join(dir, cli));
    if (hit) return hit;
  }
  return null;
}

/** node.exe to run a script with: the one npm's shim would pick, else PATH,
 * else this executable only when it really is Node. In a packaged app,
 * process.execPath is Electron and must never be mistaken for node.exe. */
function nodeExe(near: string): string | null {
  const local = join(near, "node.exe");
  if (isFile(local)) return local;
  // Ask for the executable explicitly so a custom PATHEXT ordering cannot
  // make a stray node.cmd hide the real node.exe beside it.
  const onPath = whichWin("node.exe");
  if (onPath && extname(onPath).toLowerCase() === ".exe") return onPath;
  return (process.versions as Record<string, string | undefined>).electron ? null : process.execPath;
}

/**
 * Expand `%~dp0` and any `set "NAME=..."` the shim defined, relative to it.
 *
 * Still a parser and never a shell: only literal assignments from this same
 * file are substituted, nothing is executed, and the environment of this
 * process is deliberately not consulted, so a shim cannot be steered by an
 * ambient variable. The passes are bounded because `set` can reference an
 * earlier `set`, and a self-referential pair must terminate rather than spin.
 */
function expandCmdVars(value: string, dir: string, vars: Map<string, string>): string {
  let out = value;
  for (let pass = 0; pass < 5 && out.includes("%"); pass++) {
    const next = out
      .replace(/%~dp0/gi, `${dir}\\`)
      .replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (whole, name: string) => vars.get(name.toUpperCase()) ?? whole);
    if (next === out) break;
    out = next;
  }
  return out;
}

/** Quoted tokens on a line, in order. Quotes group; nothing is evaluated. */
function quotedTokens(line: string): string[] {
  return [...line.matchAll(/"([^"]*)"/g)].map((m) => m[1]!);
}

/**
 * What a `.cmd` shim actually runs.
 *
 * npm and pnpm shims name their target directly as `"%~dp0\..."`. Launchers
 * that ship inside a relocatable payload usually take one step more, setting a
 * root variable first and invoking through it, and they carry fixed arguments
 * that are part of the command rather than decoration:
 *
 *     set "ROOT=%~dp0.."
 *     "%ROOT%\runtime\python.exe" -m some_module %*
 *
 * Both shapes resolve here to a real executable plus the arguments the shim
 * would have passed. Dropping those arguments would be worse than failing:
 * the command would launch and do the wrong thing. An unparseable shim still
 * returns null, so it stays unspawnable rather than crossing the no-shell
 * boundary this module exists to hold.
 */
function parseCmdShim(shim: string): ResolvedSpawn | null {
  let text: string;
  try {
    text = readFileSync(shim, "utf8");
  } catch {
    return null;
  }
  const dir = dirname(shim);

  // The historic direct form, kept exactly as it was.
  const direct = [...text.matchAll(/"%~?dp0%?\\?([^"]+)"/g)]
    .map((m) => join(dir, m[1]!))
    .filter((p) => isFile(p) && basename(p).toLowerCase() !== "node.exe");
  const script = direct.find((p) => /\.[cm]?js$/i.test(p));
  if (script) {
    const node = nodeExe(dir);
    if (node) return { command: node, args: [script] };
  }
  const exe = direct.find((p) => extname(p).toLowerCase() === ".exe");
  if (exe) return { command: exe, args: [] };

  // Indirect form: collect assignments, then find the line that invokes a real
  // executable through them and keep that line's fixed arguments.
  const vars = new Map<string, string>();
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const set = /^\s*set\s+"([A-Za-z_][A-Za-z0-9_]*)=([^"]*)"\s*$/.exec(line);
    if (set) vars.set(set[1]!.toUpperCase(), expandCmdVars(set[2]!, dir, vars));
  }
  for (const line of lines) {
    if (/^\s*set\s/i.test(line)) continue;
    const tokens = quotedTokens(line);
    if (tokens.length === 0) continue;
    const candidate = expandCmdVars(tokens[0]!, dir, vars);
    if (!isFile(candidate) || extname(candidate).toLowerCase() !== ".exe") continue;
    // Everything after the command token on that line, minus cmd's own
    // forward-all placeholder, which the caller's own args replace.
    const tail = line.slice(line.indexOf(`"${tokens[0]!}"`) + tokens[0]!.length + 2);
    const args = splitCliString(tail)
      .filter((token) => token !== "%*" && token !== "%1" && token !== "%~1")
      .map((token) => expandCmdVars(token, dir, vars));
    const env: Record<string, string> = {};
    for (const [name, value] of vars) env[name] = value;
    return { command: candidate, args, env };
  }
  return null;
}

/** `#!/usr/bin/env node` → `node <script>`. Only node: nothing else has a
 * meaningful Windows equivalent worth guessing at. */
function parseNodeShebang(file: string): ResolvedSpawn | null {
  let head = "";
  let fd: number | null = null;
  try {
    fd = openSync(file, "r");
    const buf = Buffer.alloc(128);
    const n = readSync(fd, buf, 0, buf.length, 0);
    head = buf.subarray(0, n).toString("utf8").split("\n", 1)[0];
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* best-effort descriptor cleanup */
      }
    }
  }
  if (!/^#!.*\bnode(\.exe)?\b/.test(head)) return null;
  const node = nodeExe(dirname(file));
  return node ? { command: node, args: [file] } : null;
}

/**
 * How to actually spawn `cli` with `args` on this platform. Identity
 * everywhere but win32 — POSIX already resolves PATH and #! itself.
 */
/** Resolve a single command word (no tokenizer) — the platform spawn rules. */
function resolveWord(cli: string, args: string[]): ResolvedSpawn {
  if (process.platform !== "win32") return { command: cli, args };
  const file = whichWin(cli);
  // not found: hand back the name so spawn reports its own ENOENT
  if (!file) return { command: cli, args };
  const ext = extname(file).toLowerCase();
  if (ext === ".cmd" || ext === ".bat") {
    const direct = parseCmdShim(file);
    return direct
      ? { command: direct.command, args: [...direct.args, ...args], ...(direct.env ? { env: direct.env } : {}) }
      : { command: file, args };
  }
  if (ext === ".exe" || ext === ".com") return { command: file, args };
  const viaNode = parseNodeShebang(file);
  return viaNode ? { command: viaNode.command, args: [...viaNode.args, ...args] } : { command: file, args };
}

export function resolveCliSpawn(cli: string, args: string[]): ResolvedSpawn {
  // An EXISTING FILE wins over the tokenizer: paths with spaces come from
  // our own candidate list unquoted ("/Applications/My Tools/claude"), and
  // splitting those would shred them. Only a bare word (no spaces) or an
  // explicitly-quoted/wrapper string reaches the split below.
  const trimmed = cli.trim();
  if (trimmed.includes(" ") && existsSync(trimmed)) return resolveWord(trimmed, args);
  // A `cli` value may carry fixed leading arguments — wrapper scripts like
  // `/usr/local/bin/ag claude agp` are one string in the Engines panel. ONE
  // tokenizer pass, then resolve the head directly (never re-tokenized: a
  // quoted token may itself contain spaces, so feeding it back through the
  // splitter would shred it). Fixed args go BEFORE invocation args — a
  // wrapper's subcommand must lead (`ag claude agp --help`), or the wrapper
  // swallows the flag itself.
  const split = splitCliString(cli);
  if (split.length > 1 || split[0] !== trimmed) {
    const [head, ...fixed] = split;
    // empty input → hand the raw string to spawn so IT reports the ENOENT
    if (!head) return { command: cli, args };
    return resolveWord(head, [...fixed, ...args]);
  }
  return resolveWord(cli, args);
}
