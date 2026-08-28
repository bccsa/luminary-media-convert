# Patents

This project implements video and audio coding standards, including H.264/AVC
and AAC. **In some jurisdictions, techniques used by those standards are covered
by patents.**

## No patent rights are granted by the copyright licences

The licences under which this software and its dependencies are distributed —
Apache-2.0, GPL, LGPL, BSD, MIT — are **copyright** licences. They govern
copying, modification and redistribution of the code. They do not grant, and
cannot grant, rights under third-party patents.

Where a licence contains a patent clause (Apache-2.0 §3, GPL-3.0 §11), it grants
only the patents held by that software's own contributors. It reaches no further.
Complying perfectly with every copyright licence involved says nothing about
patent exposure.

## Users are responsible for the licences their own use requires

Whether your use of this software requires a patent licence depends on what you
do with it, where you are, and where your output is distributed. That assessment
is yours to make. If you are unsure, take your own legal advice — nothing here
is legal advice, and nothing here is a representation about the patent position
of any particular use.

## This project does not administer patent rights on anyone's behalf

No patent licence is obtained, held, brokered or passed through on behalf of
users of this software. There is no arrangement under which a user's use is
covered by anything this project has secured. Each user carries their own patent
relationships.

## What this project does about it

These are engineering decisions, recorded so you can see what the software
actually does. They are not claims about your legal position.

- **No software H.264 encoder is bundled.** Encoding uses an encoder already
  present on the machine — VideoToolbox on macOS, or NVENC, Quick Sync, AMF or
  the Media Foundation encoder on Windows.
- **No H.265/HEVC support**, in any form.
- **AAC-LC only**, using FFmpeg's native AAC encoder.
- FFmpeg is **built from source** by `ffmpeg-build/build.sh` from the versions
  pinned in `ffmpeg-build/versions.sh`, rather than taken from a prebuilt
  distribution. The exact configuration is recorded in `BUILDCONF.txt` beside
  the shipped binary.

Note that decoders as well as encoders may implement patented techniques. This
software decodes the source files you give it.

## Reporting

If you believe something in this repository infringes a patent, please open an
issue describing the concern, or contact the maintainers directly.
