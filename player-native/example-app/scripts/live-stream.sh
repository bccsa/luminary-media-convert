#!/bin/sh
# A live HLS stream for the Lab, served by the dev server at /live/master.m3u8.
#
# ffmpeg loops SOURCE in real time into LAB_LIVE_DIR (the dev server's default): a sliding window
# of six 4-second segments, AES-128 with the key URI luminary://key, so the player answers the key
# from memory as it does for an encoder's output. The key is the Lab's LIVE_KEY.
#
#   scripts/live-stream.sh [SOURCE]
set -eu

SOURCE=${1:-"$HOME/Movies/Test Media/Luminary/spike-source-2h-2angle.mp4"}
DIR=${LAB_LIVE_DIR:-"${TMPDIR:-/tmp}/luminary-lab-live"}
DIR=${DIR%/}
KEY_HEX=6c756d696e6172792d6c697665a4e2c0

rm -rf "$DIR" && mkdir -p "$DIR"
printf '%s' "$KEY_HEX" | xxd -r -p > "$DIR/.key"
printf 'luminary://key\n%s\n' "$DIR/.key" > "$DIR/.keyinfo"

exec ffmpeg -hide_banner -loglevel warning -re -stream_loop -1 -i "$SOURCE" \
    -map 0:v:0 -map 0:a:0 \
    -c:v h264_videotoolbox -b:v 2500k -vf scale=-2:720 -g 48 -force_key_frames 'expr:gte(t,n_forced*4)' \
    -c:a aac -b:a 128k -ac 2 \
    -f hls -hls_time 4 -hls_list_size 6 -hls_flags delete_segments+independent_segments \
    -hls_key_info_file "$DIR/.keyinfo" \
    -master_pl_name master.m3u8 -hls_segment_filename "$DIR/v_%05d.ts" "$DIR/live.m3u8"
