# ultimate-harness

This repo holds the full config for the [pi coding agent](https://github.com/earendil-works/pi). `agent/` is pi's agent dir. `mise.toml` sets `PI_CODING_AGENT_DIR` to it, so pi run from this folder reads only what is committed here.

## Setup

```sh
mise trust
mise install      # pinned pi + node, then the postinstall hook runs `npm ci`
mise run check    # typecheck, tests, drift
mise exec -- pi   # or plain `pi` with mise activated in your shell
```

Log in once per machine with `/login`, or export the provider env var (for example `ANTHROPIC_API_KEY`). Credentials land in `agent/auth.json`, which is gitignored.

## Layout

| Path                               | Pi reads it as                                                     |
| ---------------------------------- | ------------------------------------------------------------------ |
| `agent/settings.json`              | global settings                                                    |
| `agent/models.json`                | custom providers and models; keys only as `$ENV_VAR` or `!command` |
| `agent/keybindings.json`           | keybindings                                                        |
| `agent/AGENTS.md`                  | global context file, loaded before any project AGENTS.md           |
| `agent/APPEND_SYSTEM.md`           | appended to the default system prompt                              |
| `agent/SYSTEM.md`                  | replaces the default system prompt (absent on purpose)             |
| `agent/skills/<name>/SKILL.md`     | skills, also callable as `/skill:<name>`                           |
| `agent/prompts/<name>.md`          | prompt templates, called as `/<name>`                              |
| `agent/extensions/<name>/index.ts` | extensions, loaded with jiti (no build step)                       |
| `agent/themes/<name>.json`         | themes                                                             |

To commit, use the `commit` tool in `agent/extensions/git-commit/`; its prompt guidelines hold the `<type>: <summary>` rules. There is no `/skill:commit-message` command.

`agent/.gitignore` is an allowlist. Pi writes `auth.json`, `trust.json`, `sessions/`, `models-store.json`, `bin/` and other state into `agent/`, and git ignores all of them by default, including any new state files future pi versions add.

## Determinism rules

- `mise.toml` pins pi to an exact version and `mise.lock` pins the checksummed binary. `package.json` pins the SDK to the same version, and `tests/versions.test.ts` enforces the match.
- Pi's own `pi install` has no lockfile, so it is not used here. Add a third-party pi package to `package.json` as an exact version or a `git+https://...#<sha>` dependency, run `npm install`, and reference it in `settings.json` as `"packages": ["../node_modules/<name>"]`. `tests/packages.test.ts` rejects `npm:`, `git:` and URL sources.
- Do not run `pi update`. Upgrade pi as described below.
- `mise.toml` sets `PI_TELEMETRY=0` and `PI_SKIP_VERSION_CHECK=1`, and `settings.json` sets `enableInstallTelemetry: false`.

## Snapshots

`mise run test` builds the effective config and compares it to `tests/snapshots/`:

- `resources.json` lists the loaded skills, prompts, extensions, themes, context files and system prompt sources, all loaded with no diagnostics.
- `system-prompt.txt` holds the full system prompt that pi sends, as assembled by the SDK.
- `commands.json` lists every command the pinned `pi` binary reports over RPC, pi's built-ins included.

The tests point `HOME` and `cwd` at empty temp dirs, so `~/.agents/skills` and ancestor `AGENTS.md` files do not leak in. After an intended change, run `mise run snapshot` and commit the diff.

The SDD prompt and markdown renderers have byte-exact goldens under `tests/fixtures/sdd-golden/`. `tests/jinja-golden.test.ts` renders each `.jinja` template with fixed inputs and compares the output. After an intended prompt change, run `mise run golden` and commit the diff.

## Runtime drift

Pi writes to `agent/settings.json` when you save a model with Ctrl+S in `/model`, change `/settings`, or upgrade. `mise run drift` fails when that happens. Commit the change if you want it, or run `mise run reset` to discard it.

## Upgrading pi

1. Bump `pi` in `mise.toml`, `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` in `package.json`, and `lastChangelogVersion` in `agent/settings.json` to the same version.
2. Run `npm install`, `mise install` and `mise lock --platform macos-arm64,linux-x64`.
3. Run `mise run check`. Read the snapshot diffs against the "Breaking Changes" sections of `node_modules/@earendil-works/pi-coding-agent/CHANGELOG.md`.
4. Run `mise run snapshot` and commit.
