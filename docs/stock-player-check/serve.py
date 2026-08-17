#!/usr/bin/env python3
"""Serve the harness and collect its verdicts.

`python3 -m http.server` is enough to run the page, but the results then live
only in the browser, which means reading them back by hand. This serves the
same directory and additionally accepts `POST /report`, appending one JSON line
per verdict to `results.jsonl` so the outcome can be read from a terminal.

    python3 docs/stock-player-check/serve.py [port]
"""

import json
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
RESULTS = HERE / "results.jsonl"


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(HERE), **kwargs)

    def do_POST(self):
        if self.path.rstrip("/") != "/report":
            self.send_error(404)
            return
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length)
        try:
            record = json.loads(raw)
        except ValueError:
            self.send_error(400, "expected JSON")
            return
        with RESULTS.open("a") as fh:
            fh.write(json.dumps(record) + "\n")
        self.send_response(204)
        self.end_headers()

    def log_message(self, fmt, *args):
        # The access log is noise here; the results file is the output.
        pass


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8899
    RESULTS.unlink(missing_ok=True)
    print(f"harness on http://127.0.0.1:{port}/  ->  {RESULTS}")
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
