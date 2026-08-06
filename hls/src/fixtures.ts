/**
 * Playlist fixtures shared by the specs.
 *
 * These are the shapes the encoder actually produces (see the master-playlist
 * assertions in `api/src/encode/services/ffmpeg.service.spec.ts` and the
 * byte-range rewrite in `api/src/encode/services/byte-range.worker.ts`), not
 * invented minimal examples — round-trip fidelity is only worth anything
 * against real output.
 *
 * Excluded from the package build in `tsconfig.json`.
 */

/** FFmpeg output after `fixMasterPlaylist` has injected the VIDEO groups. */
export const MULTI_ANGLE_MASTER = [
    '#EXTM3U',
    '#EXT-X-VERSION:6',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="group_tier_0",NAME="English",LANGUAGE="eng",DEFAULT=YES,URI="stream_English_128kbps/playlist.m3u8"',
    '#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="main",NAME="main",DEFAULT=YES',
    '#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="pulpit",NAME="pulpit",DEFAULT=NO',
    '#EXT-X-STREAM-INF:BANDWIDTH=4177777,AVERAGE-BANDWIDTH=3822202,RESOLUTION=1280x720,CODECS="avc1.640028,mp4a.40.2",VIDEO="main",AUDIO="group_tier_0"',
    'stream_main_1280x720/playlist.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=1868063,AVERAGE-BANDWIDTH=1724450,RESOLUTION=854x480,CODECS="avc1.4d401f,mp4a.40.2",VIDEO="pulpit",AUDIO="group_tier_0"',
    'stream_pulpit_854x480/playlist.m3u8',
    '',
].join('\n');

/** A plain ABR ladder — one video track, so no `TYPE=VIDEO` groups at all. */
export const SINGLE_ANGLE_MASTER = [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    '#EXT-X-INDEPENDENT-SEGMENTS',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="group_tier_0",NAME="English",LANGUAGE="eng",DEFAULT=YES,AUTOSELECT=YES,URI="stream_English_192kbps/playlist.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=5128000,AVERAGE-BANDWIDTH=4800000,RESOLUTION=1920x1080,FRAME-RATE=29.970,CODECS="avc1.640028,mp4a.40.2",AUDIO="group_tier_0",CLOSED-CAPTIONS=NONE',
    'stream_0_1920x1080/playlist.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=2628000,AVERAGE-BANDWIDTH=2400000,RESOLUTION=1280x720,FRAME-RATE=29.970,CODECS="avc1.64001f,mp4a.40.2",AUDIO="group_tier_0",CLOSED-CAPTIONS=NONE',
    'stream_1_1280x720/playlist.m3u8',
    '',
].join('\n');

/** Audio-only encode: audio groups and audio variants, no video anywhere. */
export const AUDIO_ONLY_MASTER = [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="group_tier_0",NAME="English",LANGUAGE="eng",DEFAULT=YES,URI="stream_English_128kbps/playlist.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=128000,CODECS="mp4a.40.2",AUDIO="group_tier_0"',
    'stream_English_128kbps/playlist.m3u8',
    '',
].join('\n');

/** Multi-angle plus a subtitle rendition group, as HLS-edit writes it. */
export const MULTI_ANGLE_WITH_SUBTITLES_MASTER = [
    '#EXTM3U',
    '#EXT-X-VERSION:6',
    '#EXT-X-INDEPENDENT-SEGMENTS',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="group_tier_0",NAME="English",LANGUAGE="eng",DEFAULT=YES,URI="stream_English_128kbps/playlist.m3u8"',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="group_tier_0",NAME="Deutsch",LANGUAGE="deu",DEFAULT=NO,URI="stream_Deutsch_128kbps/playlist.m3u8"',
    '#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="main",NAME="Main Camera",DEFAULT=YES',
    '#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="pulpit",NAME="Pulpit",DEFAULT=NO',
    '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES,URI="subtitles/en.m3u8"',
    '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="Forced",LANGUAGE="en",FORCED=YES,URI="subtitles/en-forced.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=4177777,RESOLUTION=1280x720,CODECS="avc1.640028,mp4a.40.2",VIDEO="main",AUDIO="group_tier_0",SUBTITLES="subs"',
    'stream_main_1280x720/playlist.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=1868063,RESOLUTION=854x480,CODECS="avc1.4d401f,mp4a.40.2",VIDEO="pulpit",AUDIO="group_tier_0",SUBTITLES="subs"',
    'stream_pulpit_854x480/playlist.m3u8',
    '#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=180000,RESOLUTION=1280x720,CODECS="avc1.640028",VIDEO="main",URI="stream_main_1280x720/iframes.m3u8"',
    '',
].join('\n');

/** Two audio quality tiers mapped to different video renditions. */
export const MULTI_TIER_AUDIO_MASTER = [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="group_tier_0",NAME="English",LANGUAGE="eng",DEFAULT=YES,URI="stream_English_192kbps/playlist.m3u8"',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="group_tier_1",NAME="English",LANGUAGE="eng",DEFAULT=YES,URI="stream_English_96kbps/playlist.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=5128000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2",AUDIO="group_tier_0"',
    'stream_0_1920x1080/playlist.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=896000,RESOLUTION=640x360,CODECS="avc1.4d401e,mp4a.40.2",AUDIO="group_tier_1"',
    'stream_1_640x360/playlist.m3u8',
    '',
].join('\n');

/** fMP4 media playlist after the byte-range worker has repacked it. */
export const BYTE_RANGE_MEDIA_PLAYLIST = [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    '#EXT-X-TARGETDURATION:4',
    '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXT-X-PLAYLIST-TYPE:VOD',
    '#EXT-X-MAP:URI="init.mp4"',
    '#EXT-X-KEY:METHOD=AES-128,URI="luminary://key",IV=0x8f3b1c0d5e6a7b8c9d0e1f2a3b4c5d6e',
    '#EXTINF:4.000000,',
    '#EXT-X-BYTERANGE:1048576@0',
    'media_0.m4s',
    '#EXTINF:4.000000,',
    '#EXT-X-BYTERANGE:1048576@1048576',
    'media_0.m4s',
    '#EXTINF:2.133333,',
    '#EXT-X-BYTERANGE:524288@0',
    'media_1.m4s',
    '#EXT-X-ENDLIST',
    '',
].join('\n');

/** MPEG-TS media playlist, one file per segment, no encryption. */
export const PLAIN_MEDIA_PLAYLIST = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-TARGETDURATION:4',
    '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXT-X-PLAYLIST-TYPE:VOD',
    '#EXTINF:4.000000,',
    'segment_00000.ts',
    '#EXTINF:4.000000,',
    'segment_00001.ts',
    '#EXTINF:1.500000,',
    'segment_00002.ts',
    '#EXT-X-ENDLIST',
    '',
].join('\n');
