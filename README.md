# Rusty IDE

An AI-assisted coding IDE built with Tauri, React, and TypeScript. Rusty runs a
local agent sidecar that talks to multiple coding-agent backends and
gives them a structured task/reconciliation workflow instead of a single chat
window: delegate work to subagents, watch a live task graph, review generated
diffs, and reconcile results back into your working tree.

## Install

Prebuilt installers for each platform are attached to the
[latest GitHub Release](../../releases/latest). Pick the one for your OS below.
To build from source instead, see [BUILD.md](BUILD.md).

### macOS

Apple Silicon only, for now.

```bash
brew install --cask traian18/rusty/rusty-ide
```

The app is signed with a Developer ID certificate and notarized by Apple.

### Windows

Download the installer from the [latest Release](../../releases/latest) and run it:

- **`Rusty-IDE_<version>_x64-setup.exe`** — NSIS installer (recommended)
- **`Rusty-IDE_<version>_x64_en-US.msi`** — MSI package (for managed/enterprise deploys)

> The Windows builds are **not code-signed**, so SmartScreen shows an
> "unknown publisher" warning on first launch. Click **More info → Run anyway**.

### Linux

Download the package for your distro from the [latest Release](../../releases/latest):

```bash
# Debian / Ubuntu / Mint
sudo apt install ./Rusty-IDE_<version>_amd64.deb

# Fedora / RHEL / openSUSE
sudo dnf install ./Rusty-IDE-<version>-1.x86_64.rpm
```

Then launch from your app menu or run `tauri-app`.

> An AppImage isn't published — the bundled agent sidecar payload trips the
> AppImage tooling. Build one from source via [BUILD.md](BUILD.md) if you need
> a portable single-file binary.

> **Running under WSLg (WSL2 GUI):** works, but webkit rendering can come up
> blank or slow. If the window is black, force the software/compositing
> fallbacks:
>
> ```bash
> WEBKIT_DISABLE_COMPOSITING_MODE=1 WEBKIT_DISABLE_DMABUF_RENDERER=1 tauri-app
> ```

## Development

See [BUILD.md](BUILD.md) for prerequisites and build instructions across
macOS, Windows, and Linux, and [THEMING.md](THEMING.md) for the color/theming
system.

```bash
npm install
cd agent-sidecar && npm install && cd ..
npm run tauri dev
```
