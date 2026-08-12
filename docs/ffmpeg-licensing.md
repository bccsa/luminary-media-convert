# Shipping FFmpeg: what licence we are actually under, and what it obliges

**This is a technical investigation, not legal advice.** It establishes the facts
from the binary and from the licensors' own documents, so that whoever at BCC
signs off a public release is deciding from evidence rather than from
recollection. Everything below was checked against the binaries actually shipped —
`electron/bin/darwin-arm64/`, `darwin-x64/` and `win32-x64/` — on 12 Aug 2026, the
Windows one by running it on a Windows CI runner.

---

## 1. Which licence, established from the binary

`ffmpeg -L` reports:

> ffmpeg is free software; you can redistribute it and/or modify it under the
> terms of the GNU General Public License as published by the Free Software
> Foundation; **either version 2 of the License, or (at your option) any later
> version.**

**The licence is not the same on all three builds, and this is the correction that
matters most in this document.** It was originally written from the macOS arm64
binary alone and generalised to "the build". Each binary was then asked
separately, with `-L` and `-buildconf`:

| Target         | Builder        | FFmpeg | `--enable-version3` | Licence             |
| -------------- | -------------- | ------ | ------------------- | ------------------- |
| `darwin-arm64` | osxexperts.net | 8.1    | no                  | **GPL v2-or-later** |
| `darwin-x64`   | osxexperts.net | 8.0    | **yes**             | **GPL v3-or-later** |
| `win32-x64`    | BtbN           | 8.1.2  | **yes**             | **GPL v3-or-later** |

All three share the flags that decide the rest:

| Flag               | Present | Consequence                                     |
| ------------------ | ------- | ----------------------------------------------- |
| `--enable-gpl`     | **yes** | The whole binary is GPL rather than LGPL        |
| `--enable-nonfree` | **no**  | **Redistribution is permitted at all** — see §2 |
| `--enable-libx264` | yes     | GPL library; this is what forces `--enable-gpl` |
| `--enable-libx265` | yes     | GPL library, same                               |

The Windows figures are confirmed by running the binary on a Windows runner, not
by extracting strings from the `.exe` on a Mac — the weaker evidence that had
already misled this project once.

**Two faults in what we shipped, both now fixed.** `LICENSE-ffmpeg.txt` was a
single hardcoded string, so it credited **osxexperts.net for BtbN's Windows
build**, and claimed **v2-or-later for all three** when two of them are v3. The
notice is now generated per target from values read off each binary. Which GPL
text travels follows the build too: a v2-or-later build ships both texts, because
"or later" genuinely offers v3; a v3-or-later build ships only v3, because it does
not offer v2 and implying otherwise would misstate the recipient's options.

**Practical consequence of v3 for us: none that bites, and one that helps.** The
separate-process aggregate in §3 holds identically under either version. v3 adds
an explicit patent grant (in our favour) and the anti-tivoization rules of §6,
which apply to locked-down "User Products" — we ship an installer that imposes no
restriction on replacing the binary, so nothing there is triggered. And v3 §6(d)
accepts a network location for source, which is the easier route in §4.

## 2. The check that matters most, and it passes

FFmpeg's own legal page divides the world by two flags. A build with
`--enable-nonfree` **cannot be redistributed at all**, because it combines code
under licences that are mutually incompatible with the GPL; the resulting binary
is undistributable regardless of what notices accompany it. That is the trap in
this area, and typically arrives via `libfdk-aac`.

This build does not have it. Nothing in the 32 configure flags enables nonfree
components. So the question is not _whether_ we may distribute, but _on what
conditions_.

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
carried into the app by `extraResources`. Which of them travels depends on the
build (§1): the v2-or-later arm64 build ships both, because "or later" genuinely
offers v3 and a recipient taking that option should not have to go looking for the
text; the v3-or-later Intel and Windows builds ship v3 only, because v2 is not on
offer for them.

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

- the FFmpeg source **at each shipped version** — 8.1 (mac arm64), 8.0 (mac Intel),
  8.1.2 (Windows). Three binaries means three sets, not one
- the x264 source at the revision used
- the x265 source at the version used
- the configure line for each, so the binary can actually be rebuilt

Nothing in the repository currently records the x264/x265 versions per build, so
assembling this means going back to each builder — which is a reason to do it while
the pinned URLs still resolve.

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
royalties for _their_ distributed binary — a condition that does not automatically
transfer to a binary someone else builds), which needs the encoder detection in
`FfmpegService` adapting.

So "use LGPL to be safe" is not free: it trades a licensing question for a
capability loss, and does not remove the patent question.

---

## 8. Which platforms can be served at all

Embedding only removes the install prompt on platforms we can actually get a
binary for, so this is part of the licence picture rather than separate from it.
Checked on 12 Aug 2026:

| Target             | FFmpeg build available? | Source                                             |
| ------------------ | ----------------------- | -------------------------------------------------- |
| macOS arm64        | yes                     | osxexperts.net (`ffmpeg9arm`/`ffmpeg81arm`)        |
| macOS x64 (Intel)  | yes                     | osxexperts.net (`ffmpeg80intel`), also evermeet.cx |
| Windows x64        | yes                     | BtbN, also gyan.dev                                |
| **Windows 32-bit** | **no**                  | —                                                  |

**No maintained 32-bit Windows FFmpeg build exists.** BtbN's releases carry
`win64`, `linux64` and `linuxarm64` only; gyan.dev states 64-bit only; Zeranoe, the
last publisher of 32-bit Windows builds, shut down in 2020 and its last release was
FFmpeg 4.3. Electron itself is not the constraint — it still publishes `win32-ia32`
— so the blocker is FFmpeg alone.

Serving 32-bit Windows would therefore mean building FFmpeg for it ourselves and
maintaining that build, including its security updates. Against that: Windows 11
has no 32-bit edition, and Windows 10 32-bit left support in October 2025, so the
audience is machines already running an unsupported OS.

Linux is out of scope by decision, not by availability — BtbN publishes `linux64`
and `linuxarm64`, so it could be added if that decision changes.

---

## What this means, in short

| Question                               | Answer                                                                                               |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| May we distribute this binary?         | Yes — no `--enable-nonfree`                                                                          |
| Under which licence?                   | **Per build**: v2-or-later on mac arm64; v3-or-later on mac Intel and Windows                        |
| Does it affect our Apache-2.0 licence? | No — separate process, arm's-length communication, an aggregate                                      |
| Licence text shipped?                  | **Yes** — the text matching each build travels with it (fixed 12 Aug 2026)                           |
| Which platforms can we serve?          | mac arm64, mac Intel, Windows x64. **Not 32-bit Windows** — no maintained FFmpeg build exists (§8)   |
| Are we compliant today?                | **Not yet** — the _corresponding source_ is still not offered; we point at upstream's current source |
| Cheapest fix                           | Mirror binary + corresponding source together, and point the notice at it (folds into item 40)       |
| Still needs a human decision           | BCC sign-off on the GPL position, and the separate H.264 patent question                             |
