# luminary-media-convert

Media converter for the luminary project

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
  -F 'metadata={"originalName":"file.mp4","title":"My File","format":"mp4"}'
```

Notes:

- `metadata` is parsed from JSON and validated. Required fields: `originalName`, `title`, and `format`.
- Max upload size defaults to 1GB; adjust the limit in `src/modules/convert/convert.controller.ts` if needed.
