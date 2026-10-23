#!/usr/bin/env python3
"""
Regenerates src/test/resources/encrypted-byterange/: two seconds of test pattern and tone, laid out
the way the encoder writes it. fMP4 segments are AES-128-CBC encrypted one by one under a single
explicit IV and packed into one chunk per chain (video, audio), addressed with #EXT-X-BYTERANGE;
#EXT-X-KEY follows #EXT-X-MAP, so the inits stay plaintext. Segment URLs carry {{BASE}}, which the
test replaces with its fake upstream's address.

Needs ffmpeg and openssl on PATH.
"""

import os
import re
import shutil
import subprocess
import tempfile

KEY_HEX = "000102030405060708090a0b0c0d0e0f"
IV_HEX = "0f0e0d0c0b0a09080706050403020100"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "resources", "encrypted-byterange")


def run(*args):
    subprocess.run(args, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def encode(work, name, inputs, codec_args):
    folder = os.path.join(work, name)
    os.makedirs(folder)
    run("ffmpeg", "-y", *inputs, "-t", "2", *codec_args,
        "-f", "hls", "-hls_time", "1", "-hls_playlist_type", "vod",
        "-hls_segment_type", "fmp4", "-hls_fmp4_init_filename", "init.mp4",
        "-hls_segment_filename", os.path.join(folder, "seg%d.m4s"),
        os.path.join(folder, "index.m3u8"))
    playlist = open(os.path.join(folder, "index.m3u8")).read()
    return folder, re.findall(r"#EXTINF:([\d.]+),\s*\n(seg\d+\.m4s)", playlist)


def pack(folder, name, segments):
    """Encrypts each segment and appends it to one chunk; returns the media playlist."""
    chunk = bytearray()
    lines = [
        "#EXTM3U", "#EXT-X-VERSION:7", "#EXT-X-TARGETDURATION:1", "#EXT-X-PLAYLIST-TYPE:VOD",
        f'#EXT-X-MAP:URI="{{{{BASE}}}}/{name}/init.mp4"',
        f'#EXT-X-KEY:METHOD=AES-128,URI="luminary://key",IV=0x{IV_HEX}',
    ]
    for duration, segment in segments:
        encrypted = subprocess.run(
            ["openssl", "enc", "-aes-128-cbc", "-K", KEY_HEX, "-iv", IV_HEX, "-in", os.path.join(folder, segment)],
            check=True, capture_output=True,
        ).stdout
        lines += [f"#EXTINF:{duration},", f"#EXT-X-BYTERANGE:{len(encrypted)}@{len(chunk)}",
                  f"{{{{BASE}}}}/media/{name}_0.m4s"]
        chunk += encrypted
    lines.append("#EXT-X-ENDLIST")
    os.makedirs(os.path.join(OUT, name), exist_ok=True)
    os.makedirs(os.path.join(OUT, "media"), exist_ok=True)
    shutil.copy(os.path.join(folder, "init.mp4"), os.path.join(OUT, name, "init.mp4"))
    open(os.path.join(OUT, "media", f"{name}_0.m4s"), "wb").write(chunk)
    open(os.path.join(OUT, f"{name}.m3u8"), "w").write("\n".join(lines) + "\n")


def main():
    shutil.rmtree(OUT, ignore_errors=True)
    with tempfile.TemporaryDirectory() as work:
        video, video_segments = encode(
            work, "video", ["-f", "lavfi", "-i", "testsrc=size=160x90:rate=25"],
            ["-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-profile:v", "baseline", "-g", "25", "-keyint_min", "25", "-sc_threshold", "0"])
        audio, audio_segments = encode(
            work, "audio", ["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000"],
            ["-vn", "-c:a", "aac", "-b:a", "64k", "-ac", "2"])
        pack(video, "video", video_segments)
        pack(audio, "audio", audio_segments)


if __name__ == "__main__":
    main()
