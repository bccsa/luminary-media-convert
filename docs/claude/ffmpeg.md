# FFmpeg and GPU detection (detail)

## FFmpeg is a hard requirement

`ffmpeg-availability.ts` probes `ffmpeg -version` / `ffprobe -version` at startup and answers **presence**, which is a different question from the acceleration detection below and must not be confused with it: every capability probe fails identically whether a binary is absent or merely lacks NVENC, so asking only about capability reported a machine with no FFmpeg at all as "No GPU found, using CPU encoding".

- The **Electron host** refuses to open a window without it, offering _Get FFmpeg_ / _Quit_ — there is nothing useful to do in a window that cannot probe, preview, thumbnail or encode. It closes the server before exiting rather than quitting out from under Nest
- The **API** refuses ingest and encode start with `503` and the same user-facing text. Ingest is the one that matters: attaching a source probes it immediately, so a missing install used to present as a failed probe, which reads as a bad file
- `probeFfmpegBinaries` / `missingBinariesMessage` / `FFMPEG_DOWNLOAD_URL` are re-exported from `bootstrap.ts` so the host reaches the same verdict the API does. Call them _after_ `createServer` (or after setting `FFMPEG_PATH` / `FFPROBE_PATH`) — the paths are read per call, so probing earlier asks about PATH instead of the bundled binaries
- **FFmpeg 4.4 or newer is required**, and that is what the user is told. The requirement is _enforced_ by probing the binary for the options the pipeline uses unconditionally (`ffmpeg-capabilities.ts`), never by comparing version strings — real builds report `4.4.2-0ubuntu0.22.04.1`, `7.1.1_2` and `N-113140-gd12b0e6f4b`, and the nightly has no version to compare. `MIN_FFMPEG_VERSION` exists to tell people what to install; it was established by reading FFmpeg's own source at release tags (`-stats_period` is absent in `n4.3`, present in `n4.4`, and is the newest option required)
- **User-facing text says the version; the log says the options.** "The installed FFmpeg is too old (version 3.4.8). Luminary Media Convert needs FFmpeg 4.4 or newer" goes to the dialog; the list of unsupported flags goes to the log, where the reader is us

## GPU Detection

`AccelMode` (`encoder-selection.ts`) has seven values: `none`, `cpu`, `nvidia`, `apple`, `intel`, `amd`, `mediafoundation`; `ENCODER_FOR` maps each but `none` to its H.264 encoder. At startup `FfmpegService.onModuleInit()` picks one (`detectAcceleration()`), in this order:

1. **NVIDIA**: `nvidia-smi` available + `ffmpeg -hwaccels` includes `cuda` → `h264_nvenc`, `scale_cuda`, `-hwaccel cuda -hwaccel_output_format cuda`
2. **Apple Silicon**: `darwin` + `arm64` + `videotoolbox` in `-hwaccels` + `h264_videotoolbox` in `-encoders` + `scale_vt` in `-filters` → `h264_videotoolbox`, `scale_vt`, `-hwaccel videotoolbox -hwaccel_output_format videotoolbox_vld`
3. **Intel Quick Sync** (Windows): `h264_qsv`
4. **`cpu`**: `libx264`, only when the FFmpeg in use has it — a user's own GPL build. The bundled FFmpeg is LGPL and has no libx264, so there is no software H.264 fallback in a packaged app
5. **`none`**: nothing usable; an encode is refused with a message that says so

`amd` (`h264_amf`) and `mediafoundation` (`h264_mf`) have argument tables and a place in `WINDOWS_CHAIN`, but startup detection does not select them yet. Audio always encodes on the CPU.

`PreviewService` shares the same detection for the converted preview (sources the browser cannot play directly): a transcoded preview segment is encoded with the encoder the ladder would use (at preview presets), and waits for an encoder session, one of which the ladder leaves free while such a preview is in use. The active mode is reported as `encoder` on status responses and SSE events.

This is exactly why the packaged app ships its own ffmpeg: hardware encoding is a compile-time decision, and a user's own build may have none of it.
