# Archive — the multi-tenant SaaS era

These documents describe a product this repository no longer contains. They are
kept because they record decisions and findings that were real at the time, and
because an audit is evidence of what was examined and when — deleting one does
not make its findings untrue, it only makes them unfindable.

**Do not read any of these as a description of the current system.**

| Document | What it describes |
|---|---|
| `URS-saas-adaptation.md` | Requirements for the hosted multi-tenant product |
| `FDS-saas-adaptation.md` | Its functional design |
| `implementation-plan.md` | The plan that built it |
| `security-review.md` | Security review of that codebase |
| `security-audit-v1.md` | Audit of that codebase |
| `privacy-review.md` | Privacy review of that codebase |

## Why the audits do not carry over

The threat model changed completely with the local-only migration, so their
conclusions do not transfer — favourably or otherwise. What changed:

- **No shared service and no user database.** There is no tenant boundary to get
  wrong, and no store of other people's data to breach. The previous audits are
  largely about exactly that.
- **Credentials moved into an OS keychain.** S3 keys live in a `safeStorage`
  sidecar readable only by the logged-in user, and never in `session.json`.
  Previously they were held by a service on behalf of many users.
- **The perimeter is a browser origin allowlist, not an API key.** A new
  network-facing surface that did not exist before: a page on another origin
  asking a program on someone's laptop to do work, gated by a trust-on-first-use
  dialog.
- **Nothing is uploaded.** The encoder reads a file where it lies, so the whole
  transfer surface — tus, upload size limits, storage of other people's media —
  is gone.
- **The API binds loopback only.** Most of what the old reviews treat as remote
  attack surface is not reachable at all.

A fresh security and privacy review against the local-only architecture is
tracked in `Todo.md`. These are the record of what came before, not a substitute
for it.
