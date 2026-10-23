#!/usr/bin/env python3
"""
Scrub frames, chapters and subtitles for the Lab's "Apple bipbop" preset.

Apple's stream carries none of the sidecars an encode has, and they cannot be added beside a
master on Apple's CDN. The Lab offers them by URL instead (`bipbopSidecars` in
example-app/src/lab/sources.ts), served by the dev server at /bipbop/, so they are the one thing
about the preset that is local. Plain text, as the stream is not encrypted.

Usage: python3 make-bipbop-sidecars.py     (needs ffmpeg and ffprobe)
"""

import math
import os
import subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "bipbop-sidecars")
MASTER = "https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_fmp4/master.m3u8"
THUMB_SECONDS, THUMB_W, THUMB_H, THUMB_COLUMNS, THUMB_ROWS = 10, 160, 90, 10, 6


def vtt_time(seconds):
    return f"{int(seconds // 3600):02d}:{int(seconds % 3600 // 60):02d}:{seconds % 60:06.3f}"


def main():
    duration = float(subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", MASTER],
        check=True, capture_output=True, text=True).stdout)
    print(f"bipbop: {duration:.0f} s")
    for sub in ("thumbnails", "chapters", "subtitles"):
        os.makedirs(os.path.join(OUT, sub), exist_ok=True)

    frames = math.ceil(duration / THUMB_SECONDS)
    per_sheet = THUMB_COLUMNS * THUMB_ROWS
    cues = ["WEBVTT", ""]
    for sheet in range(math.ceil(frames / per_sheet)):
        start = sheet * per_sheet * THUMB_SECONDS
        print(f"sprite {sheet}")
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", str(start), "-i", MASTER, "-an", "-sn",
                        "-frames:v", "1", "-vf", f"fps=1/{THUMB_SECONDS},scale={THUMB_W}:{THUMB_H},tile={THUMB_COLUMNS}x{THUMB_ROWS}",
                        "-q:v", "5", os.path.join(OUT, "thumbnails", f"sprite_{sheet}.jpg")], check=True)
        for i in range(min(per_sheet, frames - sheet * per_sheet)):
            t = start + i * THUMB_SECONDS
            col, row = i % THUMB_COLUMNS, i // THUMB_COLUMNS
            cues += [f"{vtt_time(t)} --> {vtt_time(min(t + THUMB_SECONDS, duration))}",
                     f"sprite_{sheet}.jpg#xywh={col * THUMB_W},{row * THUMB_H},{THUMB_W},{THUMB_H}", ""]
    open(os.path.join(OUT, "thumbnails", "thumbnails.vtt"), "w").write("\n".join(cues))

    titles = {"en": ["Opening", "Setup", "Middle", "Turn", "Finale"],
              "es": ["Apertura", "Preparación", "Desarrollo", "Giro", "Final"]}
    lines = {"en": "Subtitle line", "es": "Línea de subtítulo"}
    for lang, names in titles.items():
        step = duration / len(names)
        chapters = ["WEBVTT", ""]
        for i, name in enumerate(names):
            chapters += [f"{vtt_time(i * step)} --> {vtt_time((i + 1) * step)}", name, ""]
        open(os.path.join(OUT, "chapters", f"{lang}.vtt"), "w").write("\n".join(chapters))
        subs = ["WEBVTT", ""]
        for i in range(int(duration // 5)):
            subs += [f"{vtt_time(i * 5)} --> {vtt_time(i * 5 + 3)}", f"{lines[lang]} {i + 1} ({vtt_time(i * 5)})", ""]
        open(os.path.join(OUT, "subtitles", f"{lang}.vtt"), "w").write("\n".join(subs))


if __name__ == "__main__":
    main()
