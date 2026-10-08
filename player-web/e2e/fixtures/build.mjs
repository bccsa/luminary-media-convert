// Builds the deterministic HLS fixtures the browser tests play. Output goes to
// ./out (gitignored) so nothing generated is committed.
import { execFileSync } from 'node:child_process';
import { createCipheriv, createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'out');

/** Fixed key so tests can hand it to the player without fetching it. */
export const KEY_HEX = '00112233445566778899aabbccddeeff';
const KEY = Buffer.from(KEY_HEX, 'hex');
const KEY_URI = 'luminary://key';
const DURATION = 12;
const SEGMENT = 2;

const run = (args) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'inherit' });

/** Encodes one clear fMP4 HLS ladder (two video renditions, one audio group). */
function encodeLadder(dir, { singleFile = false } = {}) {
    mkdirSync(dir, { recursive: true });
    const args = [
        '-f', 'lavfi', '-i', `testsrc2=size=640x360:rate=25:duration=${DURATION}`,
        '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${DURATION}`,
        '-filter_complex',
        '[0:v]split=2[a][b];[a]scale=640:360,setsar=1[v0];[b]scale=320:180,setsar=1[v1]',
        '-map', '[v0]', '-map', '[v1]', '-map', '1:a',
        '-c:v', 'libx264', '-preset', 'veryfast', '-g', '50', '-keyint_min', '50', '-sc_threshold', '0',
        '-b:v:0', '800k', '-b:v:1', '250k',
        '-c:a', 'aac', '-b:a', '64k',
        '-f', 'hls', '-hls_time', String(SEGMENT), '-hls_playlist_type', 'vod',
        '-hls_segment_type', 'fmp4', '-hls_flags', singleFile ? 'independent_segments+single_file' : 'independent_segments',
        ...(singleFile ? [] : ['-hls_segment_filename', join(dir, 'v%v_%03d.m4s')]),
        '-master_pl_name', 'master.m3u8',
        '-var_stream_map', 'v:0,agroup:aud v:1,agroup:aud a:0,agroup:aud,name:audio,default:yes',
        join(dir, 'v%v.m3u8'),
    ];
    run(args);
}

/** AES-128-CBC with a fresh IV per file, framed the way docs/encrypted-sidecar-format.md describes. */
function lmcenc(plain) {
    const iv = createHash('sha256').update(plain).digest().subarray(0, 16);
    const cipher = createCipheriv('aes-128-cbc', KEY, iv);
    return Buffer.concat([Buffer.from('LMCENC01'), iv, cipher.update(plain), cipher.final()]);
}

function buildClear() {
    encodeLadder(join(OUT, 'clear'));
}

const IV_HEX = 'a0a1a2a3a4a5a6a7a8a9aaabacadaeaf';

/**
 * ffmpeg refuses to encrypt fMP4, so segments are encrypted afterwards the way the encoder does:
 * AES-128-CBC over each whole .m4s, the init left clear, and an EXT-X-KEY ahead of the first segment.
 */
function buildEncrypted() {
    const dir = join(OUT, 'encrypted');
    encodeLadder(dir);
    const iv = Buffer.from(IV_HEX, 'hex');
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.m4s'))) {
        const p = join(dir, f);
        const cipher = createCipheriv('aes-128-cbc', KEY, iv);
        writeFileSync(p, Buffer.concat([cipher.update(readFileSync(p)), cipher.final()]));
    }
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.m3u8'))) {
        const p = join(dir, f);
        let text = readFileSync(p, 'utf8');
        if (!f.startsWith('master')) {
            text = text.replace(/(#EXT-X-MAP:[^\n]*\n)/, `$1#EXT-X-KEY:METHOD=AES-128,URI="${KEY_URI}",IV=0x${IV_HEX}\n`);
        }
        writeFileSync(p, lmcenc(Buffer.from(text)));
    }
}

/**
 * Byte-range output the way the encoder packs it: every video rendition shares ONE chunk object
 * (renditions interleaved by offset) and the audio has its own, so a cold chunk is cold for all of
 * them. ffmpeg's single_file output gives one object per rendition; they are concatenated here and
 * each playlist's #EXT-X-BYTERANGE offsets shifted by where its bytes landed.
 */
function buildByteRange() {
    const dir = join(OUT, 'byterange');
    encodeLadder(dir, { singleFile: true });
    mkdirSync(join(dir, 'media'), { recursive: true });
    const chains = { video: { name: 'video_0.m4s', parts: [], size: 0 }, audio: { name: 'audio_0.m4s', parts: [], size: 0 } };
    for (const f of readdirSync(dir).filter((n) => /^v(\d+|audio)\.m3u8$/.test(n))) {
        const chain = f.startsWith('vaudio') ? chains.audio : chains.video;
        const playlist = readFileSync(join(dir, f), 'utf8');
        const media = /^#EXT-X-BYTERANGE:.*\n(.+)$/m.exec(playlist)?.[1] ?? /^(?!#)(.+\.m4s)$/m.exec(playlist)?.[1];
        const bytes = readFileSync(join(dir, media));
        const base = chain.size;
        chain.parts.push(bytes);
        chain.size += bytes.length;
        // The init travels as its own file, as the encoder ships it; the rest stays a byte range.
        const map = /#EXT-X-MAP:URI="[^"]*",BYTERANGE="(\d+)@(\d+)"/.exec(playlist);
        const initName = `init_${f.replace('.m3u8', '')}.mp4`;
        if (map) writeFileSync(join(dir, initName), bytes.subarray(Number(map[2]), Number(map[2]) + Number(map[1])));
        const rewritten = playlist
            .replace(/#EXT-X-MAP:URI="[^"]*",BYTERANGE="\d+@\d+"/, `#EXT-X-MAP:URI="${initName}"`)
            .replace(/#EXT-X-BYTERANGE:(\d+)@(\d+)/g, (_m, len, off) => `#EXT-X-BYTERANGE:${len}@${Number(off) + base}`)
            .split('\n')
            .map((line) => (line === media ? `media/${chain.name}` : line))
            .join('\n');
        writeFileSync(join(dir, f), rewritten);
        rmSync(join(dir, media));
    }
    for (const chain of Object.values(chains)) {
        writeFileSync(join(dir, 'media', chain.name), Buffer.concat(chain.parts));
    }
}

rmSync(OUT, { recursive: true, force: true });
buildClear();
buildEncrypted();
buildByteRange();
console.log(`fixtures written to ${OUT}`);
