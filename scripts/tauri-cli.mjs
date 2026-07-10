#!/usr/bin/env node
// Cross-platform wrapper around `npx tauri <cmd>`, replacing the old
// `PATH="$HOME/.cargo/bin:$PATH" tauri dev|build` npm scripts. That syntax
// is bash-only: Windows' cmd.exe understands neither `$HOME` nor the
// `VAR="value" command` prefix form, so the scripts silently did nothing
// there. This does the same PATH prepend (rustup's install location for
// the `cargo`/`tauri`-adjacent toolchain isn't always on PATH in the
// non-interactive shell npm scripts run under) using Node's cross-platform
// os.homedir()/path.delimiter instead of shell syntax, so it works
// unmodified on macOS, Windows, and Linux.
//
// Usage: node scripts/tauri-cli.mjs <dev|build>

import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join, delimiter } from "node:path";

const cargoBin = join(homedir(), ".cargo", "bin");
const env = { ...process.env, PATH: `${cargoBin}${delimiter}${process.env.PATH ?? ""}` };

const args = process.argv.slice(2);
const result = spawnSync("npx", ["tauri", ...args], { stdio: "inherit", env, shell: true });
process.exit(result.status ?? 1);
