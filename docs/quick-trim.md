# Quick trim (smart cut)

How a trimmed all-copy encode is produced, and why each mechanism exists. The
reader is a maintainer looking at `quick-trim-plan.ts` / `quick-trim-runner.ts`
and wondering which parts are load-bearing. All of it is: every rule below was
established by measurement on a multi-stream reference source whose streams
start 0.06 / 0.62 / 1.06 s apart (video) and ~0.98 s (audio), 1 s GOP, 50 fps.

## What it is

A trim submitted with **every** video rendition and audio group in copy mode is
cut as a _smart cut_: whole GOPs are remuxed from the source, and only the
partial GOP at each cut point is re-encoded as a short closed-GOP "bridge".
Per stream, each kept range becomes exactly three parts — head span, copied
middle, tail span — spliced with `#EXT-X-DISCONTINUITY` and per-part
`#EXT-X-MAP`. Cuts are frame-exact on any source, because every stream is
bridged on its **own** keyframe grid, at near-remux speed (a 40 s two-range
edit runs in seconds). No config field selects this: the copy checkboxes are
the intent, and mixed copy/re-encode configs are refused (the discontinuity
structure of one output must be identical in every playlist, and copied and
re-encoded streams splice at different instants).

## The rules and where they came from

- **Keyframe grids are scanned with `-copyts -avoid_negative_ts disabled`**
  (`FfmpegService.scanKeyframeGrid`). Without `-copyts` the segment-muxer scan
  reports times short by the container start time; without the
  `avoid_negative_ts` override a B-frame source shifts the whole list by its
  reorder delay. Either error makes every planned cut target a non-keyframe.
  The muxer also reports the _first_ row as 0.000 regardless of the stream's
  real first keyframe, so the first grid entry is replaced with the stream's
  ffprobe-measured first packet PTS.
- **Video copy parts are produced with an input seek and verified by
  measurement.** `-ss <keyframe>` lands wherever the demuxer's default-stream
  DTS positioning says — on multi-stream sources reliably one GOP early. The
  runner probes the produced part's first PTS (always against
  `init + first segment` concatenated: fragments carry zero-based `tfdt`, the
  absolute start lives in the init's `elst`, which the retiming below removes
  only later, at assembly) and retries once with the target
  bumped by the deficit; measured to converge in one retry every time. A second
  miss aborts to the precise-mode fallback — a mis-cut is never shipped.
- **Audio copy parts are one-pass**: `-copyts` + output-side `-ss`/`-to` +
  `-output_ts_offset <start>` cuts on the AAC frame grid exactly (~21 ms
  granularity), no retry loop.
- **Bridges are cut in the filter graph**, `-ss <start−2> -copyts` +
  `trim=start:end` — plain input `-ss` accurate-seek thresholds operate in the
  input-normalized clock and land frames late by the source start time.
  Encoder params are pinned from the probe (`profile`, `pixFmt`) and
  rate-matched to the rendition's source-mirrored config so the seam stays
  subtle. One segment, own init.
- **A job is not a part.** What a quick trim costs is the number of ffmpeg
  runs, not the content they touch: on a 22-stream two-range reference edit,
  132 sequential jobs took 32.9 s, of which 3165 s of _copied_ content
  accounted for 11.9 s and 28 sub-second bridges for 20.6 s. So all the copy
  parts of one kept range are produced by **one** job spanning the whole copy
  span (`buildQuickTrimJobs`), and jobs run through a pool of
  `QUICK_TRIM_JOB_CONCURRENCY` (4). Same edit: 72 jobs, 8.0 s. The pool stops
  at the first error, kills the children running beside it and rejects with
  that error, so the fallback verdict is unchanged; a cancel still presents as
  a cancel. A range too short for the muxer to give every part a segment of its
  own falls back to one job per part.
- **Segment numbering** is `segment_%07d.m4s` with `startNumber =
partIndex * 100000`: jobs mux independently into one directory, the segment
  pipeline discovers files by prefix/suffix and lexical order, and seven digits
  keep lexical == numeric for the 99-part cap. A collapsed job numbers from its
  _first_ part and the numbers its later parts reserved go unused, which cannot
  collide (no plannable part writes 100 000 segments) and cannot reorder (the
  largest number in play is 98 × 100 000 + n, still seven digits).
- **Playlists are authored, not muxer-written** (`assembleSplicedMediaPlaylist`
  in `@luminary-media-converter/hls-core`): EXTINF comes from the plan (the copy
  tail spills 3–5 frames past `-to` — DTS-based stop — and exact authored
  EXTINF makes players overwrite the spill by timeline). The clamp is per
  _job_, so a collapsed job's authored durations sum to exactly the span its
  parts were planned to cover. Inside such a job each copy-split junction snaps
  to the nearest boundary between segments the muxer actually wrote: the
  content is continuous across that junction and only the _count_ of
  discontinuities has to match across playlists, so its position may drift half
  a target duration and differ between streams. Every timestamp is still the
  source's own (`-copyts`), and nothing derives a position from where a
  discontinuity was placed. The byte-range rewrite and key injection are
  model-level passes over the same library, so the spliced structure survives
  them.
- **Every part is moved onto the output timeline before its playlist is
  authored** (`fmp4-timeline.ts`, called from `assembleStreamPlaylist`). Each
  part is muxed by its own ffmpeg run, and the HLS fMP4 muxer gives every run
  the same convention: fragment `tfdt` counts from zero and the run's absolute
  start goes into the init's edit list (measured: a part cut at 19.62 s has
  `elst` `[[19620, -1], [0, 5400]]` and a first `tfdt` of 0). The players this
  output is for read `tfdt` and **ignore** `elst` — hls.js's passthrough
  remuxer anchors each discontinuity domain to the first `tfdt` it sees and the
  audio track borrows the main track's anchor for that domain — so every part
  of every stream claimed to start at zero, and the part-boundary differences
  that are _by design_ (each stream splices on its own grid) landed directly on
  the audio as desync: audio fully out of sync, wrong duration, unplayable
  tail. So each job's segments gain the job's position in the finished playlist
  (the sum of the planned spans of the parts before it) and each init's `edts`
  box is renamed `free`, which every reader skips. Nothing is resized, so
  `trun` offsets, `sidx` sizes and enclosing box lengths stay valid; the
  timescale is read per job, because a copied part keeps the source's and a
  bridge gets whatever its encoder chose. This runs at assembly — after the
  copy measurements, which read the very edit lists it removes, and before the
  segment pipeline the caller starts afterwards. Verified against the reference
  file: every segment of every part decodes at exactly its playlist position,
  video and audio alike. Presentation still leads decode by the stream's
  B-frame reorder delay — a property of the bitstream, the same before and
  after, and the same as the ordinary encode path's; measured 0.060 s on the
  copied parts of the reference file and 0.040 s on its bridges, so a bridge
  join shifts the picture against the sound by at most one frame.
- **Encryption fences every mid-list MAP**: per RFC 8216 a `#EXT-X-KEY`
  governs every MAP that follows it, and this pipeline's inits are plaintext —
  so each part boundary carries `METHOD=NONE`, the MAP, then the re-armed
  session key. (The alternative — encrypting inits with the key placed first —
  exists as spike case 8; `MAP_EVERY_PART` in the runner and the fencing in
  `EncryptionService.injectKeyTag` are the two switch points if the player
  verdict ever changes.)
- **Eligibility is the relaxed gate** (`quickTrimGateRejection`): the cadence
  rules of copy mode, without the alignment rule. A quick cut never seeks
  streams to a shared offset — each stream splices at exact presentation times
  on its own grid — so mutually offset start times are not a defect here; they
  are the case the feature exists for. A stream that starts after the trim-in
  simply gets a shorter head bridge, the same head geometry the source itself
  plays.
- **Fallback is automatic**: planner rejection or a runner error flips every
  stream to re-encode (the copy renditions already carry source-mirrored
  width/height/bitrate) and runs the precise path, with a `fallbackNote` on the
  session status saying why. In the quick path the segment pipeline starts only
  **after** the runner finishes — a retried copy part rewrites its segment
  numbers, and a live pipeline would already have packed the first attempt.

## Known limitation

ffmpeg's own HLS demuxer mishandles mid-playlist `EXT-X-MAP` switches (stale
decoder extradata), so `ffmpeg -i master.m3u8` over a quick-trim output reports
decode errors even though every part is clean. This is a client limitation, not
a spec violation — multi-MAP splicing is the standard SSAI mechanism and the
supported players (hls.js, Safari native, `player-core` adapters) handle it.
Output that must survive arbitrary ffmpeg-based tooling should use the precise
trim (all streams re-encoded). See `docs/stock-player-check/` cases 6–9.
