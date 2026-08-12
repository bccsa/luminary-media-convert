# Privacy review — local-only desktop architecture

**Scope:** the encoder as it exists after the local-only migration (issue #154).
**Date:** 6 August 2026.
**Supersedes:** `docs/archive-saas/privacy-review.md`, which reviewed a hosted
multi-tenant service.

The short version: the migration removed almost everything the previous review
was about. There is no operator, no account, no user database, and no data
leaving the machine except to storage the user's own CMS configured. What remains
worth writing down is where things sit on disk, how long they stay, and the two
places where a decision was made rather than defaulted.

---

## 1. Who holds what

| Party | What they hold |
|---|---|
| The user's machine | Everything: source media, session records, encrypted S3 credentials, encryption keys, trust decisions |
| The CMS | `hlsUrl` and `hlsKey`, which it asked for |
| The S3 bucket | The encoded output — a destination the CMS chose and holds the credentials for |
| The project / any operator | **Nothing.** There is no server, no account, no telemetry |

That last row is the whole change. Previously an operator held S3 credentials,
session history and user identities for every customer.

**Verified, not assumed:** grepping `api/src`, `app/src` and `electron/src` for
analytics, telemetry, Sentry, PostHog, Mixpanel and `crashReporter` returns
nothing, and there is no hardcoded outbound URL anywhere in the app or the
desktop shell. The only network destinations are the S3 endpoint the CMS supplied
and the loopback API itself.

---

## 2. Personal data

**No accounts, so no account data.** No name, email, identity provider, or
password exists anywhere in this system. Auth0 went with the SaaS.

**Media is personal data by proxy.** A video may contain anything, including
identifiable people. What matters is that the encoder does not move it anywhere
the user did not ask for:

- The source is **read where it lies**. It is never copied into the app's
  directories, never moved, and never written to or deleted — including on
  failure. What crosses the API is an absolute path, not bytes.
- The output goes only to the S3 destination the CMS supplied.
- Nothing is uploaded to the project or to any third party.

**Derived artefacts** — waveform peaks, storyboard sprites, preview segments —
are made from the source and live under `<userData>/work/<sessionId>/`. They are
removed when the session is deleted, which removes the directory whole.

---

## 3. What is written to disk, and where

All under the OS's per-user application directory
(`~/Library/Application Support/Luminary Media Convert` on macOS):

| Path | Contents | Protection | Removed |
|---|---|---|---|
| `work/<id>/session.json` | Session record. S3 keys are `<redacted>`; **holds `readToken` and `encryptionKeyHex` in plaintext** | `0600` | On delete, and at boot for finished sessions |
| `work/<id>/credentials.enc` | S3 access and secret key | `0600`, encrypted with an OS-keychain key | With the session |
| `work/<id>/preview/`, `preview-thumbnails/`, `waveform.json` | Derived media | `0600` dir | With the session |
| `settings.json` | Allowed and blocked origins | Default | Never; editable in-product |

**The one thing worth flagging.** `session.json` deliberately redacts S3
credentials but does **not** redact `encryptionKeyHex` or `readToken`. That is
consistent — anything able to read that file is the logged-in user, who could
read `credentials.enc` through `safeStorage` anyway — but it means the AES key
protecting a finished encode sits in plaintext under the user's home directory
until the session is deleted. Someone with disk access but not keychain access
(an unencrypted backup, a cloned drive) gets the media key without getting the
S3 credentials. If that gap matters, the fix is to encrypt those two fields with
the same cipher.

**Retention.** Idle sessions (`created`, `uploading`, `uploaded`) are swept after
6 hours by default. Finished sessions are discarded at boot, work directory and
all. Nothing accumulates indefinitely — with one exception below.

---

## 4. What is logged

Session identifiers, statuses, and refused origins. Verified by inspection: no
file paths, no S3 credentials, no encryption keys, and no media content are
written to the log. Logs go to the process's stdout, which in a packaged app
means nowhere persistent unless the user launched it from a terminal.

---

## 5. Data leaving the machine

Three flows, all initiated by the user or their own CMS:

1. **To the S3 bucket** — the encoded output, to a destination the CMS supplied
   and holds credentials for. The encoder is a conduit, not a party.
2. **To the CMS** — `sessionId`, `readToken`, `eventsUrl`, `apiVersion` on
   creation; then status, progress, `hlsUrl` and `encryptionKeyHex` over SSE. The
   API never echoes back the S3 credentials or the title it was given, and never
   sends the session token.
3. **At build time only** — `ffmpeg-build/build.sh` fetches FFmpeg's source from
   `ffmpeg.org`, x264 from `code.videolan.org`, libwebp from Google's release host,
   and the NVENC headers from GitHub. Not at runtime, and not on a user's machine.
   (Until 12 Aug 2026 this was a prebuilt binary from `osxexperts.net`; we build our
   own now.)

There is no fourth. No update check, no crash reporting, no usage statistics.

**One was found and removed, 12 Aug 2026.** `app/index.html` linked Google Fonts —
`preconnect` to `fonts.googleapis.com` and `fonts.gstatic.com`, plus a stylesheet —
so every launch of a local-only app reached out to Google. It had not been working:
the CSP is `styleSrc 'self'` with no `fontSrc`, so the packaged app blocked the
stylesheet and fell back to the system font. But `preconnect` is a resource hint and
is not governed by CSP, so what survived was a connection to Google on every launch
for a font that never loaded. Removed; `--font-sans` still names Inter first, so a
machine that has it installed uses it.

---

## 6. Decisions, not defaults

- **Encryption keys are random per encode.** Nothing derives them from a shared
  secret, so a leaked key compromises exactly one piece of media. The previous
  architecture derived them from an `HLS_ENCRYPTION_SEED` held by the service —
  one secret whose loss would have exposed every customer's output.
- **Credentials are held in memory only when there is no keychain.** On a Linux
  desktop with no keyring, `safeStorage` is unavailable and the app writes **no**
  credential sidecar rather than one containing plaintext. Sessions then do not
  survive a restart, and the app says so. A stranded session is a smaller problem
  than a plaintext key in a home directory.
- **Trust decisions are remembered, including refusals.** So a site that keeps
  asking cannot wear the user down, and so a mistaken click is not permanent —
  both lists are reviewable and revocable in the app.

---

## 7. Open points

- **`encryptionKeyHex` and `readToken` are plaintext in `session.json`** (§3).
  A deliberate consistency, but the backup/cloned-disk case is real. Worth a
  decision rather than leaving it implied by the code.
- **`settings.json` grows without bound.** Every origin ever allowed or blocked
  stays listed. Harmless in volume, but it is a small record of which CMS
  instances a user has touched, kept for the life of the install. The trusted
  sites panel makes it prunable; nothing prunes it automatically.
- **If the API is ever run as a shared service again**, this review does not
  apply. Every conclusion here rests on one process, one user, one machine.
  Tracked as Todo item 0c.
