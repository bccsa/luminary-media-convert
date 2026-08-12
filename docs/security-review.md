# Security review — local-only desktop architecture

**Scope:** the encoder as it exists after the local-only migration (issue #154).
**Date:** 6 August 2026.
**Supersedes:** `docs/archive-saas/security-review.md` and `security-audit-v1.md`, which
reviewed a multi-tenant hosted service that no longer exists.

Method: an automated review of the whole branch diff against `main`, followed by
adversarial verification of each candidate finding by an independent pass whose
default was to refute it. Two findings survived; both were fixed before this
document was written. A third of the candidate findings were discarded at the
verification stage, and the corrections that verification forced are recorded
below, because a review that only records what it confirmed is not evidence of
much.

---

## 1. What changed in the threat model

The old reviews assumed a hosted service holding many customers' data. Almost
none of their conclusions transfer.

|                               | Before                             | Now                                                     |
| ----------------------------- | ---------------------------------- | ------------------------------------------------------- |
| Deployment                    | Shared service, public ingress     | One process on one user's machine                       |
| Bind address                  | Public interface                   | `127.0.0.1`, unconditionally                            |
| Accounts                      | Auth0 identities, user database    | None                                                    |
| Tenant isolation              | The central concern                | No tenants                                              |
| S3 credentials                | Held by the service for many users | Supplied per session, encrypted with an OS-keychain key |
| Media transfer                | Uploaded through the service       | Never uploaded; read where it lies                      |
| Remote surface                | The whole REST API                 | `GET /api/cms/health` and `POST /api/cms/sessions`      |
| Perimeter for a remote caller | API key                            | Browser `Origin` allowlist                              |

**The one genuinely new surface** is the CMS handshake. A web page on another
origin asks a program on someone's laptop to do work. Both findings below are in
that surface, which is where the attention belonged.

---

## 2. Findings

### 2.1 — HIGH: origin allowlist bypassed by an opaque origin — **fixed**

`api/src/cors.config.ts`, `api/src/encode/cms.controller.ts`

Both halves of the perimeter exempted the literal string `"null"`:

```ts
if (!origin || origin === 'null') {
    /* trusted */
}
```

A **missing** `Origin` header and `Origin: null` are not the same thing. The
first is not a browser page — curl, a local tool — and there is nothing for CORS
to protect. The second is what a browser sends for an _opaque_ origin: a
sandboxed iframe, a `data:` document, some cross-origin redirects. That is
precisely the caller the allowlist exists to stop. The comment's premise, "a
request with no Origin is not a browser", was correct for the first and wrong
for the second.

The loopback fallback in the controller was no defence: the browser sending
`Origin: null` runs on the user's own machine, so it is always a loopback peer.

`POST /api/cms/sessions` carries no `@UseGuards` by design — it is gated by
origin alone. So any website could open a session on someone's encoder through a
sandboxed iframe, bypassing both the trust-on-first-use dialog and the memory of
every origin the user had already refused. The CORS layer reflected
`Access-Control-Allow-Origin: null`, which the Fetch CORS check accepts for an
opaque origin, so the response — `sessionId`, `readToken`, `eventsUrl` — was
readable cross-origin. Creating a session also fires `CMS_SESSION_HOOK`, which
brings the desktop window to the front on a session the attacker titled and
pointed at their own bucket.

Firefox and Safari have no local-network gate today. Chrome's newer
permission-based Local Network Access would block it, and an opaque origin cannot
hold a permission.

**Corrections that verification forced.** The first-pass description overstated
the impact twice. There is **no automatic exfiltration**: the session is created
empty, and media reaches the attacker's bucket only if the user then picks a file
and encodes — a social-engineering step, not a technical one, though the forced
window-focus is what makes it plausible. And `readToken` is **not** a privilege
escalation: it reaches only `GET /api/sessions/:id` and the SSE stream for that
one session.

**Fix.** `'null'` falls through to `OriginRegistry.isAllowed`, which refuses it —
`null` can never be an allowlisted origin. The `!origin` + loopback path is kept;
it was always sound.

Removing the exemption was verified safe before it was done: the packaged
renderer is served from the API's own origin (auto-approved after binding), and
there is no `file://` load anywhere in `electron/src` — the only mentions of
`file://` in the repository were the two comments justifying the branch.

### 2.2 — LOW: `documentId` reuse leaked a read token between approved sites — **fixed**

`api/src/encode/cms.controller.ts`

The idempotency branch matched on `documentId` alone and returned the existing
session's `readToken`. Nothing bound a session to its creating origin. Document
ids are the CMS's own post identifiers and are routinely public, so a second site
the user had also approved could name one and collect that session's read token —
and with it `hlsUrl` and `encryptionKeyHex`, the AES-128 key protecting the
output.

**Verification downgraded this from Medium to Low**, and the reasoning matters
more than the rating. No unapproved caller can reach or read it: even if a hostile
page got the POST through, CORS withholds `Access-Control-Allow-Origin`, so the
response is unreadable to it. A local process gains nothing either — `session.json`
already holds `readToken` and `encryptionKeyHex` in plaintext at `0600`, so it
would skip the API entirely. The realistic attacker is a **second origin the user
already approved**, which must also know the target `documentId` and hit inside
the active window.

That residue is still worth closing: cross-origin access between two approved
sites is the one thing approval is not supposed to grant, and `documentId` reuse
was the only channel by which it could happen — session ids are UUIDs and there
is no CMS-facing list endpoint.

**Fix.** Sessions record the normalised origin that created them, and reuse
requires it to match. Idempotency is a per-origin property: "this site clicked
twice", not "somebody named this document".

---

## 3. Examined and found sound

Recorded because the value of a review is as much in what it cleared as in what
it found.

**Authentication.** Tier ordering in `AuthResolverGuard` is correct; a
present-but-wrong `X-API-Key` is rejected outright rather than falling through to
a weaker tier; `timingSafeEqual` is length-guarded. Every route declaring
`'session'` or `'read'` uses the `sessionId` param the scoping check reads, so one
session's token cannot open another's. Tokens derive from `randomUUID()` (CSPRNG,
122 bits).

**Command injection.** Every ffmpeg and ffprobe call site uses `spawn`/`execFile`
with an argv array — never `shell: true`. The only `execSync` calls interpolate
`FFMPEG_PATH` alone, which is trusted and quoted.

**Path traversal.** The local-file endpoint requires the instance or session token
(never the CMS read token), and validates absolute → `stat` → `isFile` →
extension allow-list; the file is only ever read, never written or moved. Preview
and storyboard routes bound their indices numerically and pin filenames with
anchored regexes. S3 keys pass through `canonicalPrefix`.

**Read tokens** reach exactly one route plus the SSE stream for their own session.
They cannot start, cancel, or reach the source file.

**Electron shell.** `contextIsolation: true`, `nodeIntegration: false`,
`sandbox: true`. The preload exposes five narrow calls and no general escape
hatch. External links go to the system browser. There is no renderer navigation
sink an attacker-controlled string could drive.

**Client-side playback.** Playlists are fetched without credentials; blob URLs are
minted as media types, never `text/html`.

**Build supply chain.** Updated 12 Aug 2026: the encoder is **built from source**
rather than downloaded. `ffmpeg-build/build.sh` fetches FFmpeg's own release tarball,
checks a pinned SHA-256, and verifies the project's **GPG signature** with `gpgv`
against the fingerprint published on ffmpeg.org — the key is vendored and asserted to
match that fingerprint, so a substituted key fails rather than silently vouching for
a substituted tarball. x264 is pinned to a commit, libwebp to a digest. Tested in
both directions: a tampered tarball is rejected before anything compiles, and
swapping the signing key for a different real one also fails.

Two supply-chain properties this replaced: the binaries used to come from
third-party build hosts (osxexperts.net, unlisted and unsigned, for both Macs), and
nothing verified that the _result_ was relocatable. `build.sh` now audits its own
output with `otool` (Mach-O) or `objdump` (PE) and fails on any dependency outside the
OS set, requiring a known-present library in the listing first so an unreadable table
cannot pass as "nothing foreign". `verify-package.mjs` covers a different axis: that
the packaged app contains both binaries, of the right architecture, with their licence
texts.

**Transport.** The API binds `127.0.0.1` unconditionally. CSP keeps
`script-src 'self'`; the widening for media sources applies only when the API also
serves the web client.

---

## 4. Residual risks, accepted

These are decisions, not oversights. Each is recorded so a later reader can
disagree with the reasoning rather than rediscover the fact.

- **Read tokens do not expire.** Their lifetime is the session's, which is
  already bounded — sessions are purged at boot and swept when idle. A shorter
  expiry would break the case they exist for: a CMS watching an encode that can
  legitimately run for hours. What makes this acceptable is how little they grant
  and how far they travel — read-only, one session, loopback, to an approved
  origin. Widen any of those and it should be revisited.
- **Approving an origin is durable and total.** A site the user approves can open
  sessions until they revoke it. Revocation now exists in-product (the trusted
  sites panel); before this work it required editing a JSON file by hand.
- **Unsigned builds.** macOS Gatekeeper requires right-click → Open on first
  launch; there is no notarization and no auto-update. Tracked as Todo item 2.
- **A GPL ffmpeg is shipped.** It runs as a separate process and is never linked,
  so the obligation travels with ffmpeg, not with this Apache-2.0 codebase. A
  technical reading, not legal advice — see `electron/bin/README.md`.
- **Running the API as a remote service would invalidate this review.** The
  deploy workflows and Dockerfile that still described that mode have since been
  removed (Todo item 0c), which is why this is now a note rather than an open
  risk. Should it ever be reversed, the origin allowlist stops being a sufficient
  perimeter: a native approval dialog only means something when someone is
  sitting at the machine.

---

## 5. What would invalidate this review

- Running the API anywhere but a user's own machine.
- Any new route accepting a `read_*` token, or any widening of what one grants.
- A renderer that navigates to a URL from data, rather than only pushing external
  links to the system browser.
- Bundling ffmpeg differently, or losing the pinned digests.
- Adding a CMS-facing endpoint that enumerates sessions.
