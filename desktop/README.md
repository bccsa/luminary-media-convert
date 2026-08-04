# Desktop (Electron) — Phase 1 spike

Runs the encoder locally, against files already on the user's disk. Nothing is
uploaded: the source is read in place and only the HLS output goes to S3.

**This is a spike, not the product.** There is no renderer app, no SaaS service
and no local database yet — it exists to prove the parts that would be expensive
to discover late. See the phased plan for what comes next.

## Running it

```bash
npm -w desktop run stage      # build + stage api and saas into build/resources
npm -w desktop start          # stage the api, then launch Electron
npm -w desktop run pack       # unpacked .app / .exe / AppImage in release/
npm -w desktop run dist       # full installers (dmg, nsis, AppImage)
```

The window shows the encoder URL, the resolved ffmpeg paths, and where the work
and log directories are. `spike-handle.json` in the app's userData directory
carries the encoder URL and master key so a shell script can drive the running
app — that file is a spike affordance and goes away once there is a UI.

## ffmpeg is not bundled

A GPL ffmpeg build — the one with libx264/libx265, i.e. the one that can encode
without a GPU — would encumber this Apache-2.0 codebase, and an LGPL build
would leave machines without a supported GPU unable to encode at all. So the app
uses whatever ffmpeg the user already has.

Finding it is the interesting part. A GUI-launched app inherits almost none of
the user's shell environment: on macOS an app opened from Finder gets a PATH of
roughly `/usr/bin:/bin:/usr/sbin:/sbin`, so a Homebrew ffmpeg in
`/opt/homebrew/bin` is invisible even though `which ffmpeg` works in a terminal.
`src/ffmpeg-detect.js` therefore probes known install locations directly and
only falls back to PATH, and it verifies each candidate by running it rather
than trusting that the file exists.

This only reproduces in a packaged, GUI-launched build. To test it the way a
user would experience it:

```bash
env -i HOME="$HOME" USER="$USER" PATH=/usr/bin:/bin:/usr/sbin:/sbin \
  "release/mac-arm64/Luminary Media Convert.app/Contents/MacOS/Luminary Media Convert"
```

## Why the services are staged

The repo is an npm workspace: dependencies are hoisted to the root
`node_modules` and the workspace packages are symlinks. Neither survives
packaging. `scripts/stage-services.mjs` builds a fresh, self-contained
dependency tree per service instead — see the comments in that file for the two
rewrites that make it installable outside the workspace.

Neither service has a native dependency, so one staged tree serves macOS,
Windows and Linux; only the Electron binary differs per target.

The staged services ship in `Resources/` **outside the asar**, on purpose: the
encoder resolves its worker threads with `join(__dirname, '*.worker.js')`, and
those paths do not exist inside an asar.

## Testing an encode end to end

Any S3-compatible target works — the config takes `endPoint`, `port`, `useSSL`,
`bucket`, `region` and credentials, so R2, AWS, B2 and MinIO are all just
config. A local MinIO is the easiest for development:

```bash
docker run -d --name lmc-minio -p 9100:9000 -p 9101:9001 \
  -e MINIO_ROOT_USER=lmcadmin -e MINIO_ROOT_PASSWORD=lmcsecret123 \
  minio/minio server /data --console-address ":9001"
docker exec lmc-minio mc alias set local http://127.0.0.1:9000 lmcadmin lmcsecret123
docker exec lmc-minio mc mb local/media
```

Note that MinIO runs plaintext by default, so testing only against it leaves
`useSSL: true` — the path every hosted provider uses — unexercised.

## Not done yet

Builds are unsigned. On macOS that means Gatekeeper blocks launching the `.app`
from Finder (right-click → Open, or strip the quarantine attribute); on Windows
SmartScreen warns. Signing, the renderer, the local database and the offline
SaaS mode are later phases.
