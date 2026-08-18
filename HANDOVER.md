# Handover — player-web-legacy (issue #184)

> **⚠️ Temporary branch note — delete this file (drop its commit) before merging to `main`.**

## What this branch adds

`player-web-legacy/` — a Video.js 8 based player with the **same contract as `player-web`**
(`player-core`'s `PlayerAdapter` + the `LuminaryPlayer` component API), replicating the
bccsa/luminary app's video.js skin exactly, with LMC encryption support:

- **Engine**: video.js `8.23.4` (exact pin; bundled VHS resolved to 3.17.5) + `videojs-mobile-ui@1.1.1` + `videojs-youtube@3.0.1`.
- **Key delivery**: in-memory — `luminary://key` answered by wrapping VHS's per-handler xhr
  factory (`src/adapter/vhsKeyInterceptor.ts`), installed on the `xhr-hooks-ready` event.
  Verified against the installed VHS 3.17.5 source. Fallback: `keyDelivery: 'url'` adapter
  option (pipeline-minted key blob URL) if a VHS upgrade moves the seam.
- **Skin**: ported from the real Luminary files (local checkout `~/repos/luminary`), Tailwind
  `@apply` expanded to plain CSS under `.lmpl-root`; dark mode via `.dark` ancestor.
- **Legacy-only props**: `poster` (artwork behind transparent player), `preferredLanguage`
  (ISO-639 2↔3-letter matching with manual-override suspension).
- **YouTube mode**: bypasses the LMC pipeline (as in Luminary); exposed `controller` stays
  null there — documented in `player-web-legacy/README.md`.
- Small cross-package fixes that fell out of review: `player-core` `toPlayerError` now maps
  `unsupported-browser`; `player-web/src/adapter/chunkWarming.ts` fetch-receiver fix
  (kept byte-identical with the legacy copy); CLAUDE.md updated for the new workspace.

## State

- Builds green (`npm run build:libs`), `vue-tsc` strict clean, player-core 192 + player-web 96
  tests pass, shipped `.d.ts` clean of CSS/module side-effect imports.
- 8-angle code review done; 16 confirmed findings fixed (see PR/branch history).

## Outstanding before merge

1. **Manual verification** (not yet done): `npm -w player-web-legacy run demo` → http://localhost:5182
   — plain master; LMCENC master + key (network tab must show no `luminary://` request and no
   key bytes); angle/audio/quality switches; audio-only toggle; YouTube URL; Safari spot check;
   side-by-side visual against the Luminary app.
2. **Tests**: the `__tests__/` suite is deliberately deferred until after manual verification
   (`vitest.config.ts` has `passWithNoTests` until then).
3. **Decision**: `subsCapsButton` was added to the control bar (self-hides when no text tracks,
   so Luminary content looks identical) to make LMC subtitle sidecars reachable in fullscreen —
   drop it if strict control-bar parity is preferred.
4. **Known pre-existing issue, out of scope here**: `player-web`'s built declarations leak
   `import '../styles.css'` (breaks consumers with `skipLibCheck: false`). The `<style>`-block
   pattern used in `player-web-legacy` is the proven remedy.
5. Consumption by bccsa/luminary: git submodule + file-reference installs of `hls`,
   `player-core`, `player-web-legacy` — flow documented in `player-web-legacy/README.md`.

> **Reminder: delete this file before merging.**
