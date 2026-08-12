# Shipping FFmpeg: what licence we are actually under, and what it obliges

**This is a technical investigation, not legal advice.** It establishes the facts
from the binary and from the licensors' own documents, so that whoever at BCC
signs off a public release is deciding from evidence rather than from
recollection. Everything below was checked against the binary in
`electron/bin/darwin-arm64/` on 12 Aug 2026.

---

## 1. Which licence, established from the binary

`ffmpeg -L` reports:

> ffmpeg is free software; you can redistribute it and/or modify it under the
> terms of the GNU General Public License as published by the Free Software
> Foundation; **either version 2 of the License, or (at your option) any later
> version.**

`ffmpeg -buildconf` confirms why:

| Flag | Present | Consequence |
|---|---|---|
| `--enable-gpl` | **yes** | The whole binary is GPL rather than LGPL |
| `--enable-version3` | **no** | So it is **GPL v2-or-later**, not v3-or-later |
| `--enable-nonfree` | **no** | **Redistribution is permitted at all** — see §2 |
| `--enable-libx264` | yes | GPL library; this is what forces `--enable-gpl` |
| `--enable-libx265` | yes | GPL library, same |

**`LICENSE-ffmpeg.txt` was wrong.** It claimed "version 3 or later". The build is
v2-or-later, which is a *more* permissive position for our recipients — under
"or later" they may choose either version — and it changes which source-delivery
options are available to us (§4). Corrected in the same change as this document.

## 2. The check that matters most, and it passes

FFmpeg's own legal page divides the world by two flags. A build with
`--enable-nonfree` **cannot be redistributed at all**, because it combines code
under licences that are mutually incompatible with the GPL; the resulting binary
is undistributable regardless of what notices accompany it. That is the trap in
this area, and typically arrives via `libfdk-aac`.

This build does not have it. Nothing in the 32 configure flags enables nonfree
components. So the question is not *whether* we may distribute, but *on what
conditions*.

## 3. Our own code is not affected — the aggregate is sound

The app spawns `ffmpeg` as a child process with command-line arguments and reads
its stdout/stderr. It never links FFmpeg's libraries. The FSF's own FAQ draws the
line exactly there:

> We believe that a proper criterion depends both on the mechanism of
> communication (exec, pipes, rpc, function calls within a shared address space,
> etc.) and the semantics of the communication… **pipes, sockets and command-line
> arguments are communication mechanisms normally used between two separate
> programs. So when they are used for communication, the modules normally are
> separate programs.**

and, on `fork`/`exec` specifically:

> A main program that uses simple fork and exec to invoke plug-ins and does not
> establish intimate communication between them **results in the plug-ins being a
> separate program.**

So this Apache-2.0 codebase is not a derivative work of FFmpeg, and shipping the
two together is an "aggregate", which the GPL explicitly permits:

> The GPL permits you to create and distribute an aggregate, even when the
> licenses of the other software are nonfree or GPL-incompatible.

**With one condition that is ours to keep:**

> The only condition is that you cannot release the aggregate under a license
> that prohibits users from exercising rights that each program's individual
> license would grant them.

In practice: if the installer ever grows an EULA, it must not forbid what the GPL
grants for the FFmpeg part — copying, redistributing, reverse engineering it.

## 4. The licence text itself — now shipped

GPLv2 §1 requires that a distributor "give any other recipients of the Program a
copy of this License along with the Program". A link in a notice is not a copy,
and until 12 Aug 2026 a link was all we shipped: a 642-byte `LICENSE-ffmpeg.txt`
pointing at gnu.org.

The full texts of **GPL-2.0** and **GPL-3.0** are now vendored in
`electron/bin/licenses/`, copied beside the binaries by the fetch script, and
carried into the app by `extraResources`. Both versions travel because the build
is "v2 or later": v2 is the licence we convey under, and a recipient exercising
the "or later" option should not have to go looking for v3.

They are committed rather than downloaded at build time — 53 KB of text that
never changes, which has to ship whether or not anyone reruns the fetch. The
`electron/bin/*/` ignore rule needed a negation for exactly that reason.

## 5. The obligation we still do **not** meet: corresponding source

This is the finding that needs action. The FSF FAQ is direct about the case we
are in — an unmodified binary someone else built:

> **I downloaded just the binary from the net. If I distribute copies, do I have
> to get the source and distribute that too?** Yes. The general rule is, if you
> distribute binaries, you must distribute the complete corresponding source code
> too.

FFmpeg's legal page says the same in its own words: provide "the source code of
FFmpeg, no matter if you modified it or not", matching the distributed binaries.

**What "corresponding" means here is wider than FFmpeg alone.** `otool -L` shows
this binary links only system frameworks — VideoToolbox, CoreMedia, libSystem and
friends — and carries **no dynamic reference to x264 or x265**. Both GPL libraries
are therefore **statically linked into the binary we ship**, so they are part of
the work being conveyed, and the corresponding source covers:

- FFmpeg 8.1 source
- the x264 source at the revision used
- the x265 source at the version used
- the configure line, so the binary can actually be rebuilt

**What we ship today is not that.** `LICENSE-ffmpeg.txt` points at
`https://ffmpeg.org/download.html` — the upstream project's download page, which
offers current source rather than the corresponding source for this build. The
FAQ addresses that too:

> Corresponding source means the source from which users can rebuild the same
> binary.

### How to discharge it

Because the work is "v2 or later", the recipient may take it under v3, whose
delivery options are the practical ones:

> **Can I put the binaries on my Internet server and put the source on a
> different Internet site?** Yes. Section 6(d) allows this. However, you must
> provide clear instructions people can follow to obtain the source, and you must
> take care to make sure that the source remains available for as long as you
> distribute the object code.

So the workable shape, and it **pairs exactly with the mirroring question already
open in item 40**: host the binary and its corresponding source together in a
place we control — a GitHub release asset on this repository, or BCC storage —
and have `LICENSE-ffmpeg.txt` point at that, not at ffmpeg.org. One action solves
both the availability problem (a single third-party host today) and the source
obligation, and keeps the two in step for as long as we ship that binary.

Under v2 the options are narrower (§3: accompany with source, or a written offer
valid three years, and a physical-media request must be honourable), which is a
second reason the v2/v3 distinction in §1 was worth getting right.

## 6. A separate axis: patents, which the GPL does not address

FFmpeg's legal page notes that the standards it implements

> contain vague hints that any conforming implementation might be subject to some
> patent rights

and that companies distributing H.264 encoders have had licensing demands from
pools such as MPEG LA. This is **independent of copyright licensing**: complying
perfectly with the GPL says nothing about patent exposure for shipping an H.264
encoder. `libx264` is the exposed piece; the VideoToolbox and NVENC paths use
encoders provided by the OS or driver, which is a materially different position.

Worth a separate answer from BCC, and not something this repository can settle.

## 7. If GPL turns out to be unacceptable

The alternative is an LGPL build — `--enable-gpl` dropped, which means **dropping
`libx264` and `libx265`**. The consequence is concrete and is already recorded in
`electron/bin/README.md`: `libx264` is the CPU fallback in `FfmpegService`, so a
machine with neither VideoToolbox nor NVENC could not encode at all. That is the
exact case bundling exists to serve.

The other route is `libopenh264` (BSD-licensed, with Cisco covering patent
royalties for *their* distributed binary — a condition that does not automatically
transfer to a binary someone else builds), which needs the encoder detection in
`FfmpegService` adapting.

So "use LGPL to be safe" is not free: it trades a licensing question for a
capability loss, and does not remove the patent question.

---

## What this means, in short

| Question | Answer |
|---|---|
| May we distribute this binary? | Yes — no `--enable-nonfree` |
| Under which licence? | GPL **v2 or later** (not v3, as previously stated) |
| Does it affect our Apache-2.0 licence? | No — separate process, arm's-length communication, an aggregate |
| Licence text shipped? | **Yes** — GPL-2.0 and GPL-3.0 travel with the binaries (fixed 12 Aug 2026) |
| Are we compliant today? | **Not yet** — the *corresponding source* is still not offered; we point at upstream's current source |
| Cheapest fix | Mirror binary + corresponding source together, and point the notice at it (folds into item 40) |
| Still needs a human decision | BCC sign-off on the GPL position, and the separate H.264 patent question |
