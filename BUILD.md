# Building Rusty-IDE

## Prerequisites

All platforms need:
- [Node.js](https://nodejs.org/) 20.19+ or 22.12+
- [Rust](https://www.rust-lang.org/tools/install) (stable toolchain)

### Platform-specific

| Platform | Requirement |
|----------|-------------|
| **macOS** | Xcode Command Line Tools (`xcode-select --install`) |
| **Windows** | [Microsoft C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) (MSVC v143 + Windows 10/11 SDK) |
| **Linux** | System libraries (see below) |

#### Linux system libraries

Debian/Ubuntu:

```bash
sudo apt install -y libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf libssl-dev
```

Fedora:

```bash
sudo dnf install -y webkit2gtk4.1-devel libappindicator-gtk3-devel librsvg2-devel openssl-devel
```

Arch Linux:

```bash
sudo pacman -S --needed webkit2gtk-4.1 libappindicator-gtk3 librsvg openssl
```

openSUSE:

```bash
sudo zypper install -y libwebkit2gtk-4_1-0-devel libappindicator3-devel librsvg-devel libopenssl-devel
```

## Install dependencies (first time only)

```bash
npm install
cd agent-sidecar && npm install && cd ..
```

> `npm ci` (against the committed lockfiles) is unaffected, but plain
> `npm install` to *add or update* a root dependency can fail on npm 10.9.8
> with `Cannot read properties of null (reading 'edgesOut')` — a known bug in
> that version's peer-dependency resolver, reproducible on this repo's
> dependency graph. If you hit it, run the install with a newer npm instead
> of downgrading anything in this repo: `npx --yes npm@11 install <pkg>`.

## Build the application

The same command works on every platform:

```bash
npm run tauri build
```

This runs three steps automatically:

1. **Frontend** — `npm run build` (TypeScript + Vite)
2. **Sidecar** — `npm run build:sidecar` (bundles the Node.js sidecar into a single self-contained `server.js` via tsup, then copies it to `src-tauri/resources/sidecar/`)
3. **Tauri** — compiles the Rust app in release mode and bundles the app + Node.js runtime + sidecar

### Build a specific bundle target

```bash
# macOS — DMG only
npm run tauri build -- --bundles dmg

# Linux — AppImage only
npm run tauri build -- --bundles appimage

# Linux — deb only
npm run tauri build -- --bundles deb

# Linux — rpm only
npm run tauri build -- --bundles rpm

# Windows — NSIS installer only
npm run tauri build -- --bundles nsis

# Windows — MSI only
npm run tauri build -- --bundles msi
```

## Output

### macOS

| Bundle | Path |
|--------|------|
| App bundle | `src-tauri/target/release/bundle/macos/Rusty-IDE.app` |
| DMG | `src-tauri/target/release/bundle/dmg/Rusty-IDE_0.1.0_<arch>.dmg` |

### Windows

| Bundle | Path |
|--------|------|
| NSIS installer | `src-tauri/target/release/bundle/nsis/Rusty-IDE_0.1.0_<arch>-setup.exe` |
| MSI | `src-tauri/target/release/bundle/msi/Rusty-IDE_0.1.0_<arch>.msi` |

### Linux

| Bundle | Path |
|--------|------|
| AppImage | `src-tauri/target/release/bundle/appimage/Rusty-IDE_0.1.0_<arch>.AppImage` |
| Debian | `src-tauri/target/release/bundle/deb/Rusty-IDE_0.1.0_<arch>.deb` |
| RPM | `src-tauri/target/release/bundle/rpm/Rusty-IDE_0.1.0-1.<arch>.rpm` |

> **AppImage** is the most portable single-file option across distributions. **deb** targets Debian/Ubuntu/Mint, **rpm** targets Fedora/RHEL/openSUSE.

## Bundled Node.js runtime

The bundled Node binary lives in `src-tauri/bin/rusty-node-<target-triple>` and is excluded from git (downloaded locally). You need the matching binary for each target platform:

| Target triple | Platform | Binary name |
|---------------|----------|-------------|
| `aarch64-apple-darwin` | macOS Apple Silicon | `rusty-node-aarch64-apple-darwin` |
| `x86_64-apple-darwin` | macOS Intel | `rusty-node-x86_64-apple-darwin` |
| `x86_64-pc-windows-msvc` | Windows 64-bit | `rusty-node-x86_64-pc-windows-msvc.exe` |
| `x86_64-unknown-linux-gnu` | Linux 64-bit (most distros) | `rusty-node-x86_64-unknown-linux-gnu` |
| `aarch64-unknown-linux-gnu` | Linux ARM64 | `rusty-node-aarch64-unknown-linux-gnu` |

### Downloading Node binaries

Download from <https://nodejs.org/dist/> (use Node v22.x, e.g. v22.23.1) and extract the `node` binary:

**macOS:**

```bash
# Apple Silicon Mac (M1/M2/M3/M4)
cd src-tauri/bin
curl -LO https://nodejs.org/dist/v22.23.1/node-v22.23.1-darwin-arm64.tar.gz
tar xzf node-v22.23.1-darwin-arm64.tar.gz
cp node-v22.23.1-darwin-arm64/bin/node rusty-node-aarch64-apple-darwin
chmod +x rusty-node-aarch64-apple-darwin
rm -rf node-v22.23.1-darwin-arm64*

# Intel Mac
cd src-tauri/bin
curl -LO https://nodejs.org/dist/v22.23.1/node-v22.23.1-darwin-x64.tar.gz
tar xzf node-v22.23.1-darwin-x64.tar.gz
cp node-v22.23.1-darwin-x64/bin/node rusty-node-x86_64-apple-darwin
chmod +x rusty-node-x86_64-apple-darwin
rm -rf node-v22.23.1-darwin-x64*
```

**Windows (run in PowerShell on a Windows machine):**

```powershell
cd src-tauri\bin
curl.exe -LO https://nodejs.org/dist/v22.23.1/node-v22.23.1-win-x64.zip
tar xf node-v22.23.1-win-x64.zip
copy node-v22.23.1-win-x64\node.exe rusty-node-x86_64-pc-windows-msvc.exe
Remove-Item -Recurse node-v22.23.1-win-x64*
```

**Linux:**

```bash
# x86_64
cd src-tauri/bin
curl -LO https://nodejs.org/dist/v22.23.1/node-v22.23.1-linux-x64.tar.xz
tar xf node-v22.23.1-linux-x64.tar.xz
cp node-v22.23.1-linux-x64/bin/node rusty-node-x86_64-unknown-linux-gnu
chmod +x rusty-node-x86_64-unknown-linux-gnu
rm -rf node-v22.23.1-linux-x64*

# ARM64
curl -LO https://nodejs.org/dist/v22.23.1/node-v22.23.1-linux-arm64.tar.xz
tar xf node-v22.23.1-linux-arm64.tar.xz
cp node-v22.23.1-linux-arm64/bin/node rusty-node-aarch64-unknown-linux-gnu
chmod +x rusty-node-aarch64-unknown-linux-gnu
rm -rf node-v22.23.1-linux-arm64*
```

> The binary **must** be present in `src-tauri/bin/` with the exact target-triple name before running `npm run tauri build`, otherwise the build fails with "missing sidecar binary".

## Cross-platform builds via CI

You cannot natively build Windows or Linux binaries from macOS. The recommended approach is **GitHub Actions** using a matrix of OS runners. Each runner builds natively for its own platform:

```yaml
# .github/workflows/build.yml
name: Build
on:
  workflow_dispatch:

jobs:
  build:
    strategy:
      fail-fast: false
      matrix:
        include:
          - os: macos-14      # Apple Silicon
            target: aarch64-apple-darwin
          - os: macos-13      # Intel
            target: x86_64-apple-darwin
          - os: ubuntu-22.04
            target: x86_64-unknown-linux-gnu
          - os: windows-latest
            target: x86_64-pc-windows-msvc

    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 20

      - uses: dtolnay/rust-toolchain@stable
        with:
          targets: ${{ matrix.target }}

      - name: Install Linux deps
        if: runner.os == 'Linux'
        run: |
          sudo apt update
          sudo apt install -y libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf libssl-dev

      - name: Install deps
        run: |
          npm install
          cd agent-sidecar && npm install && cd ..

      - name: Download Node sidecar binary
        working-directory: src-tauri/bin
        run: |
          if [ "${{ runner.os }}" = "Windows" ]; then
            curl -LO https://nodejs.org/dist/v20.20.2/node-v20.20.2-win-x64.zip
            tar xf node-v20.20.2-win-x64.zip
            cp node-v20.20.2-win-x64/node.exe "rusty-node-${{ matrix.target }}.exe"
          else
            OS="linux"; EXT="tar.xz"; ARCH="x64"
            if [ "${{ runner.os }}" = "macOS" ]; then OS="darwin"; EXT="tar.gz"; fi
            if [ "${{ matrix.target }}" = "aarch64-apple-darwin" ]; then ARCH="arm64"; fi
            if [ "${{ matrix.target }}" = "x86_64-apple-darwin" ]; then ARCH="x64"; fi
            curl -LO "https://nodejs.org/dist/v20.20.2/node-v20.20.2-${OS}-${ARCH}.${EXT}"
            tar xf "node-v20.20.2-${OS}-${ARCH}.${EXT}"
            cp "node-v20.20.2-${OS}-${ARCH}/bin/node" "rusty-node-${{ matrix.target }}"
            chmod +x "rusty-node-${{ matrix.target }}"
          fi
          rm -rf node-v20.20.2-*
        shell: bash

      - name: Build
        run: npm run tauri build

      - uses: actions/upload-artifact@v4
        with:
          name: Rusty-IDE-${{ matrix.target }}
          path: |
            src-tauri/target/release/bundle/**/*
```

## Development

`npm run tauri dev` alone auto-spawns the bundled sidecar (built via `npm run
build:sidecar`) on the same dev port the frontend expects (4001, distinct
from release's 4000 so a dev instance never fights an installed copy — see
`src-tauri/src/lib.rs`'s `SIDECAR_PORT` and `src/config/sidecar.ts`). That is
enough if you are not editing `agent-sidecar`'s own source.

If you *are* changing sidecar code and want hot-reload without rebuilding the
bundle, start it manually first — it binds the same port, so the
auto-spawned bundled copy fails to bind behind it and exits harmlessly
(`reclaim_sidecar_port` recognizes and reclaims only its own bundled process,
never an unrelated one, so your manual instance is left alone):

```bash
# Terminal 1 — sidecar (hot-reload via ts-node)
cd agent-sidecar && npm run dev

# Terminal 2 — Tauri dev (frontend + Rust with HMR)
npm run tauri dev
```

## Running the test suite

```bash
npm run verify
```

Runs, in order: frontend test typecheck, frontend unit tests (vitest),
frontend production build (`tsc && vite build`), sidecar typecheck, sidecar
tests, and Rust tests. All of it works from a clean clone with plain `npm
install` / `npm --prefix agent-sidecar install` — none of it depends on the
bundled sidecar Node runtime described above.

Per-layer scripts, if you only need one piece:

```bash
npm run test              # frontend unit tests (vitest)
npm run test:watch        # frontend unit tests, watch mode
npm run typecheck:test    # typecheck test files (kept off the release tsc)
npm run test:sidecar      # agent-sidecar tests (node --test)
npm run test:rust         # cargo test (src-tauri)
```

`npm run fmt:rust` (`cargo fmt --check`) and `npm run lint:rust`
(`cargo clippy -D warnings`) also exist but are **not** part of `verify` or
any CI gate yet — `src-tauri/src/git.rs` has never been formatted, and
reformatting it now would produce a large mechanical diff that conflicts
with `REFACTOR_PLAN.md` PR 5's rewrite of the same file. Enforcement is
deferred to a dedicated formatting PR sequenced after PR 5.

### Stale Rust build artifacts

If `cargo check`/`cargo build` fails with an error like:

```
failed to read plugin permissions: failed to read file
'/some/other/checkout/src-tauri/target/debug/build/.../out/permissions/...':
No such file or directory (os error 2)
```

`src-tauri/target/` was copied or moved from a different checkout rather than
built in place — Cargo's build-script output caches absolute paths from
wherever it was originally built. Both `src-tauri/target/` and
`src-tauri/gen/schemas/` are gitignored and fully regenerable, so the fix is:

```bash
rm -rf src-tauri/target
cargo check --manifest-path src-tauri/Cargo.toml
```

If `cargo check` instead fails on a missing file under
`src-tauri/resources/sidecar/` (e.g. `resource path
resources/sidecar/node_modules/.bin/<name> doesn't exist`), that directory —
also gitignored, generated by `scripts/prepare-sidecar-runtime.mjs` — has
gone stale the same way (its `node_modules` symlinks can point at an old
checkout path). Regenerate it instead of hand-fixing symlinks:

```bash
npm run build:sidecar
```

There is no tooling guard against either of these — both directories are
gitignored, so git cannot detect or prevent the copy, and each was a one-time
result of moving or copying a checkout rather than cloning fresh. Knowing the
exact error strings above is what makes them findable.

### Missing or stale sidecar resources on a fresh checkout (or after pulling)

Any `cargo` command that goes through `tauri-build` — including
`cargo check` and `cargo test`, not just `cargo build` — fails on a fresh
checkout with:

```
resource path `resources/sidecar` doesn't exist
```

`tauri.conf.json` declares `"resources": ["resources/sidecar"]`, and Tauri's
build script checks that it exists before it will build anything, even
though unit tests never read from it. It's a gitignored, generated artifact
(`scripts/prepare-sidecar-runtime.mjs` builds it from `agent-sidecar`'s own
build output, staging the platform's bundled `rusty-node[.exe]` binary
inside it too — see "Bundled Node runtime for the agent sidecar" above).
`npm run test:rust` and `npm run lint:rust` provision it automatically via a
`pretest:rust` / `prelint:rust` hook, `scripts/ensure-sidecar-resources.mjs`
— idempotent, a no-op once a complete `resources/sidecar` (including the
node binary, not just the directory) already exists; run it directly if you
need it for a plain `cargo check` or `cargo build` (assumes
`agent-sidecar`'s own dependencies and the bundled node binary from the
table above are already in place):

```bash
node scripts/ensure-sidecar-resources.mjs
```

If the app itself fails a startup health check with something like
"Checking the agent sidecar failed", or LLM integration checks in the
Settings tab all show failed, `resources/sidecar/rusty-node[.exe]` is
usually the actual missing piece even though `resources/sidecar/` itself
already exists (this once had no node binary staged inside it at all,
before this build was reworked to be cross-platform) — `npm run
build:sidecar` rebuilds it from scratch unconditionally, regardless of
`ensure-sidecar-resources.mjs`'s own check.
