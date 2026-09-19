# COROS Sync

A desktop app that copies music from a Spotify playlist to a mounted COROS watch. It reads playlist metadata from Spotify, uses `yt-dlp` and FFmpeg to obtain MP3 files, and writes them to the watch over USB. Packages, watch detection, and safe removal support macOS, Windows, and Linux.

![COROS Sync desktop app](public/coros-sync.png)

## Requirements

- macOS, Windows, or a Linux desktop session
- Node.js 24 and npm when building from source
- A COROS watch that mounts as a USB volume
- A Spotify account and Spotify developer app
- `yt-dlp` and FFmpeg
- Windows: Windows PowerShell and the Windows Shell (included in desktop Windows)
- Linux: `util-linux` (`lsblk` with JSON/MOUNTPOINTS support) and `udisks2` (`udisksctl`), with permission to unmount removable drives

## Install

Download packages from [GitHub Releases](https://github.com/jacobmalone28/coros-spotify-sync/releases) when available. Packaged apps include Electron, but you must still install `yt-dlp` and FFmpeg and configure your own Spotify client ID. Release builds are unsigned and not notarized; macOS Gatekeeper and Windows SmartScreen may warn or block them.

To build from source:

1. Clone the repository and install the JavaScript dependencies:

   ```sh
   git clone https://github.com/jacobmalone28/coros-spotify-sync.git
   cd coros-spotify-sync
   npm install
   ```

2. Install the media tools. On macOS:

   ```sh
   brew install ffmpeg pipx
   pipx install yt-dlp
   ```

   On Windows, install `yt-dlp` and FFmpeg using their official installation instructions or your package manager, and add their executables to `PATH`. On Linux, install FFmpeg, `util-linux`, and `udisks2` through your distribution's package manager, and install `yt-dlp` using its recommended installation method. Restart the app after changing `PATH`.

3. In the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard), create an app and add this redirect URI:

   ```text
   http://127.0.0.1:43821/callback
   ```

   Copy the app's client ID. A client secret is not required because COROS Sync uses OAuth PKCE.

4. Start the desktop app:

   ```sh
   npm run desktop
   ```

5. Open **Settings**, paste the Spotify client ID, and save.

## Use

1. Select **Connect Spotify** and approve playlist access in the browser.
2. Attach the COROS watch with its charging cable and wait for it to mount.
3. Select **Detect**. Automatic detection matches volume labels containing COROS or PACE. If your watch has a custom label, choose its mounted volume root in **Settings**, such as `/Volumes/COROS`, `E:\`, or `/run/media/your-user/COROS`. Do not select its `Music` subfolder. Clear an old configured path to resume automatic detection.
4. Choose a Spotify playlist and select **Download to COROS**.
5. Wait for the transfer to finish, then select **Eject** before disconnecting the watch.

macOS uses `diskutil eject`; Windows uses the Shell's Eject action and waits for the drive to become unavailable. Linux uses `udisksctl unmount` and checks for remaining mounts on the same block device; it does not power off the USB device. If removal fails because a file is open or permission is denied, close applications using the watch and use your OS's file manager or safe-removal controls before unplugging. The app never force-unmounts or requests elevated privileges.

> [!WARNING]
> A sync removes everything currently in the watch's `Music` folder before writing the selected playlist.

Downloaded tracks are cached in `~/Music/Coros Sync` by default. Change the download library in **Settings** if needed.

## Privacy and credentials

COROS Sync never requires a Spotify client secret. The client ID and local paths are stored in the app's per-user data directory, outside this repository. The Spotify refresh token is encrypted with Electron's macOS secure storage, and access tokens remain in memory.

Do not commit `.env` files, credential exports, or local cache files. They are excluded by the repository's `.gitignore`.

## Build

Use Node.js 24. Run the packaging command on its corresponding OS:

```sh
npm ci
npm run lint
npm test
npm run build
npm run package:mac -- --arm64 --x64
npm run package:win
npm run package:linux
```

| Platform | Architecture | Packages |
| --- | --- | --- |
| macOS | Apple Silicon (arm64), Intel (x64) | DMG, ZIP |
| Windows | x64 | NSIS installer (EXE) |
| Linux | x64 | AppImage, tar.gz |

Packages are written to `release/`, which is excluded from Git. Package filenames include the version, OS, and architecture. Packaging commands never publish automatically. Build resources in `build/` are source assets, not generated installers.

## GitHub Releases

The [build workflow](.github/workflows/release.yml) installs dependencies with `npm ci`, lints, runs device-service tests, builds, and packages on native macOS, Windows, and Linux runners. Pull requests, pushes to `main`, and manual workflow runs produce downloadable Actions artifacts retained for 14 days; they do not publish a release.

To publish a release after the workflow has been committed and pushed:

1. Set the version in `package.json` and `package-lock.json` (for example, `npm version 1.0.1 --no-git-tag-version`). Commit and push those changes.
2. Push a matching version tag:

   ```sh
   git tag v1.0.1
   git push origin v1.0.1
   ```

   Use `v1.0.0` for the existing version without a version bump. Tags must exactly match `v` followed by the package version; mismatches fail before packaging.

3. After all platform builds succeed, the workflow creates or updates the GitHub Release and attaches all packages. Tags containing a hyphen, such as `v1.1.0-beta.1`, are marked as prereleases.

Only the release job has `contents: write` permission. It uses the repository's automatic `GITHUB_TOKEN`; no personal access token or signing secrets are required. Code signing and notarization are not configured.

## Limitations

Device tests simulate OS command results, missing tools, busy volumes, and disconnected watches; they do not validate physical hardware transfers or safe removal. Test those workflows with your watch before relying on a release. Windows and Linux ARM builds are not included. Only mounted filesystem volumes are supported, not MTP-only devices; mount the watch with your OS first.

COROS does not publish a Bluetooth file-transfer API for music, so transfers require the watch's mounted USB storage. Watch Bluetooth support is intended for audio peripherals and media controls.

Spotify supplies playlist metadata only. `yt-dlp` retrieves audio from third-party providers; use the app only for media you have permission to download and follow the applicable service terms.
