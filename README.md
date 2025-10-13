# luminary-media-convert

Media converter for the luminary project

## Prerequisites

This project uses GStreamer via GObject Introspection. You must install GStreamer and the appropriate plugins on your system (macOS in this example):

- Core runtime: gstreamer, gst-plugins-base
- Additional codecs/containers used by pipelines:
    - x264enc: typically in gst-plugins-ugly or system package providing x264
    - avenc_aac: provided by gst-libav (FFmpeg-based)
    - lamemp3enc: in gst-plugins-ugly
    - vp8enc/vorbisenc/webmmux: in gst-plugins-good/bad
    - wavenc, flacenc: in base/good

On macOS (Homebrew), common installs are:

```bash
brew install gstreamer gst-plugins-base gst-plugins-good gst-plugins-bad gst-plugins-ugly gst-libav
```

Ensure the `gst-inspect-1.0` command lists the encoders/muxers used in the pipeline (x264enc, avenc_aac, lamemp3enc, vp8enc, vorbisenc, wavenc, flacenc, mp4mux, webmmux, matroskamux).

## Environment variables

```bash
QUEUE_FILE_PATH="queue.json" # path to the queue file
```

## Uploading files via multipart/form-data

Endpoint: `POST /api/convert/:dispatchId`

Form fields:

- `file`: the binary file to convert
- `metadata`: JSON string with details. Example: `{"originalName":"video.mp4","title":"My Video","format":"mp4"}`

Example request using curl (macOS zsh):

```bash
curl -X POST "http://localhost:3000/api/convert/your-dispatch-id" \
  -F "file=@/path/to/file.mp4" \
  -F 'metadata={"originalName":"file.mp4","title":"My File","convertedFormat":"mp4"}'
```

Notes:

- `metadata` is parsed from JSON and validated against `MetadataDto`.
    - Required: `convertedFormat` must be one of `mp4|mov|avi|mkv|flv|wmv|webm|mp3|wav|aac|ogg|opus|flac`.
        - Optional: `originalName`, `title`, `description`, `author`, `copyright`, `bitrate`.
        - Unknown fields are ignored.
        - On validation errors, the API responds with 400 Bad Request and a message like `Invalid metadata: convertedFormat must be one of the following values: mp4, mov, ...`.
- Max upload size defaults to 1GB; adjust the limit in `src/modules/convert/convert.controller.ts` if needed.

## Supported output formats

The converter supports these output targets:

- Video containers/codecs:
    - mp4 (H.264 + AAC)
    - mov (H.264 + AAC)
    - avi (MPEG-4 Part 2 + MP3)
    - mkv (H.264 + AAC)
    - flv (H.264 + AAC)
    - wmv (WMV2 + WMA2 in ASF)
    - webm (VP8 + Vorbis)
- Audio:
    - mp3 (LAME)
    - wav (PCM)
    - aac (ADTS)
    - ogg (Vorbis)
    - opus (Opus in Ogg)
    - flac (FLAC)

Notes:

- Bitrate (if provided) is applied to the encoders that support it.

## API-run conversion flow

1. POST the file with metadata to `/api/convert/:dispatchId` to queue the job.

- Example metadata: `{ "originalName": "input.mov", "convertedFormat": "mp4", "bitrate": 1800 }`

2. Poll `GET /api/convert/:dispatchId?status=all|pending|processing|completed|failed`.
3. When status=completed, call `GET /api/convert/:dispatchId?status=completed` to fetch completed items.

- The response will include the converted file bytes (Buffer) and the item will be removed from the queue and the file deleted from disk.

## Local usage notes

- Input files are stored under `files/` and converted outputs under `processed/`.
- Temporary source files are removed once conversion succeeds.
- Errors during conversion will mark the job as `failed`.

## Env file

```bash
PORT=3001
```
