# OmniDesk Desktop

Local-first desktop security and productivity toolkit built with React, Tailwind, and Tauri.

## Development

Install dependencies:

```bash
pnpm install
```

Run the web UI:

```bash
pnpm dev
```

Run the desktop app:

```bash
pnpm desktop:dev
```

Build release assets:

```bash
pnpm build
pnpm desktop:build
```

## GitHub & Release

Code repository:

```bash
git@github.com:k2safe/OmniDesk.git
```

Desktop auto-update uses the public code repository releases directly:

```text
k2safe/OmniDesk
```

The updater checks:

```text
https://github.com/k2safe/OmniDesk/releases/latest/download/latest.json
```

Local release helpers:

```bash
make build
make package
make release BUMP=patch
make local-mac-release BUMP=patch TOKEN=<github_token>
```

`make package` defaults to `.app` plus updater artifacts. To also build a local dmg, run:

```bash
TAURI_BUILD_ARGS="--bundles dmg,app" make package
```

The updater signing private key is generated locally at `.tauri/omnidesk-updater.key` and is ignored by git. If GitHub Actions is used later, add it to repository secrets:

```bash
make github-secrets TOKEN=<github_token>
```

Required GitHub secrets:

- `TAURI_SIGNING_PRIVATE_KEY`
- `RELEASES_REPO_TOKEN`

If you later split release assets into a separate public repository, create it with:

```bash
make create-release-repo TOKEN=<github_token>
```

## Storage

OmniDesk stores workspace data in a local SQLite database under the app data directory. The Rust side keeps an in-memory cache after unlock, accepts collection-level updates from the UI, then writes changed data back to SQLite with a short debounce. Sensitive collections such as the password vault and TOTP secrets are encrypted by the Rust side before they are written to SQLite.
