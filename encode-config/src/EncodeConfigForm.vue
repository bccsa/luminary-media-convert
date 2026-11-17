<script setup lang="ts">
import { reactive, computed, ref, watch } from 'vue';
import type {
    ProbeResult,
    EncodeConfig,
    VideoRendition,
    AudioGroup,
    AudioTrackInfo,
    VideoTrackInfo,
    TrimCopyMode,
} from './types';
import {
    computeLayoutKey,
    getStoredConfig,
    getStoredContentPreset,
    saveContentPreset,
} from './layoutStorage';
import { CONTENT_PRESETS, sourceCapKbps, suggestLadder } from './ladder';
import { displayDimensionsOf } from './aspect';
import {
    audioLanguageOf,
    buildSuggestedAudioGroups,
    getAudioTierForHeight,
    rankAudioTracks,
} from './audioGroups';
import { applySavedTrackLabels } from './trackLabels';
import {
    anglesOf,
    angleNames,
    initialAssignment,
    moveTrack,
    normalize,
    rankTracks,
    type AngleAssignment,
} from './angles';
import LanguageSelect from './LanguageSelect.vue';
import SelectMenu, { type SelectMenuOption } from './SelectMenu.vue';
import {
    copyModeBlockedReason,
    latestStreamStart,
    quickTrimBlockedReason,
} from './copyMode';

const props = withDefaults(
    defineProps<{
        probeResult: ProbeResult;
        byteRange: boolean;
        /** When `next-to-trim`, primary CTA navigates to trim instead of submitting encode. */
        encodePrimaryAction?: 'start-encoding' | 'next-to-trim';
        /** `session` — light slate panels for embedding in the web app session card. */
        appearance?: 'default' | 'session';
        /**
         * Something has been cut, so a submitted encode would take the quick
         * (smart cut) path rather than a straight copy. The API gates that path
         * on cadence alone — no alignment rule — so the Copy tick boxes relax
         * with it, or a mutually offset multi-stream source could never reach
         * the very path built for it.
         */
        trimActive?: boolean;
        /**
         * The settings an earlier encode of this source ran with. The form
         * opens on them instead of a suggestion, so running it again repeats
         * that encode rather than quietly making a different one.
         */
        restoreConfig?: EncodeConfig | null;
    }>(),
    {
        encodePrimaryAction: 'start-encoding',
        appearance: 'default',
        trimActive: false,
    }
);

const emit = defineEmits<{
    submit: [config: EncodeConfig];
    back: [];
    'next-to-trim': [];
    'can-submit-change': [valid: boolean];
    /**
     * How a trim submitted with this ladder would be cut. Derived from the copy
     * checkboxes — the form has no trim-mode control, because the copy ticks
     * already are one — so the host can say which of the two paths the Start
     * button is about to take.
     */
    'trim-mode-change': [mode: TrimCopyMode];
}>();

const encodingType = reactive<{ value: 'video' | 'audio' }>({
    value: props.probeResult.videoTracks.length > 0 ? 'video' : 'audio',
});

const segmentDuration = reactive<{ value: number }>({
    value: 6,
});

const videoRenditions = reactive<VideoRendition[]>([]);

/**
 * The suggested bitrate each rendition row opened at, index-aligned with
 * `videoRenditions`.
 *
 * The ladder-max dial rescales from this snapshot rather than from whatever is
 * in the fields: rescaling from the current values compounds its own rounding,
 * so dragging the dial down and back would not return the ladder it started
 * from. A copied row's entry is carried along for alignment but ignored by the
 * dials, and is re-derived when that row stops copying.
 */
const ladderBaseKbps = reactive<number[]>([]);

/** Top-rung dial. Every `reanalyze()` resets it to the suggestion. */
const ladderMax = reactive<{ value: number }>({ value: 1 });

/** The last value the dial accepted, to put back when the field is cleared. */
let lastGoodLadderMax = 1;

/**
 * Where the dial currently stands relative to the suggestion: the max last
 * typed (`ladderScaleNum`) over the top re-encoded rung's suggestion at that
 * moment (`ladderScaleDen`). 1/1 on a fresh suggestion.
 *
 * Kept rather than re-derived from the max field, because the field is a
 * rounded number and the rungs the operator has already set were priced from
 * this ratio. A row that stops copying, or is added, joins at the same ratio,
 * and the field is re-synced from it — so unticking an angle neither re-scales
 * the rungs already set nor leaves the max showing a number no rung has.
 *
 * Held as the two numbers rather than their quotient, so a rung is priced as
 * `base * max / suggestion` — the arithmetic the max dial has always done. A
 * precomputed quotient rounds some exact half-kbps ties the other way.
 */
let ladderScaleNum = 1;
let ladderScaleDen = 1;

/**
 * The suggestions of the rungs a dial can actually move: the re-encoded ones.
 *
 * Copied rows are left out because a copy's bitrate is the source's own. Were
 * one the largest, the max would read — and scale against — a number it cannot
 * set: after unticking the one 720p angle of a pair that both opened copying,
 * the field showed the 1080p copy's 5000, and typing 2500, that rung's own
 * value, halved it.
 */
const reencodedBaseKbps = computed(() =>
    ladderBaseKbps.filter(
        (_, i) => videoRenditions[i] != null && !videoRenditions[i].copyStream
    )
);

/**
 * Where the dial sits when it matches the suggestion — the largest suggested
 * re-encoded rung, so typing a number sets that rung to it exactly.
 * `Math.max(1, ...)` rather than `Math.max(...)`: with no re-encoded rung (audio
 * mode, or every row copying) the list spreads to `Math.max(1)`, so the 1 both
 * floors the value and keeps `applyLadder`'s divisor off zero.
 */
const suggestedLadderMax = computed(() =>
    Math.max(1, ...reencodedBaseKbps.value)
);

/**
 * Bottom-rung dial, `null` meaning auto.
 *
 * Auto by default, and that is the whole design of it: a second anchor that
 * started out pinned would silently change what the max dial does, because two
 * fixed ends define a remap where one end plus a ratio defined a scale. Left
 * alone it tracks whatever the max dial implies, so the max dial's behaviour is
 * byte-identical to before this field existed.
 */
const ladderMin = reactive<{ value: number | null }>({ value: null });

/** The last pin the min field accepted; null while it has never been pinned. */
let lastGoodLadderMin: number | null = null;

/**
 * The smallest suggested re-encoded rung — the bottom of the shape being
 * remapped. Copied rows are left out for the same reason as at the top.
 */
const suggestedLadderMin = computed(() =>
    reencodedBaseKbps.value.length
        ? Math.max(1, Math.min(...reencodedBaseKbps.value))
        : 1
);

/** Where the bottom rung lands when only the max dial is driving. */
const autoLadderMin = computed(() =>
    Math.max(
        1,
        Math.round(
            (suggestedLadderMin.value * ladderMax.value) /
                suggestedLadderMax.value
        )
    )
);

/**
 * How hard this material is to encode, as a multiplier on the table.
 *
 * The ABR table is sized for generic material, and a lot of what goes through
 * here is not: a church service is three static camera positions and a talking
 * head, which reaches the same quality on appreciably fewer bits than the table
 * assumes. `custom` is the escape hatch for material that is neither.
 */
const contentPreset = reactive<{
    value: 'low' | 'standard' | 'high' | 'custom';
}>({ value: 'standard' });

const customFactor = reactive<{ value: number }>({ value: 0.6 });

/**
 * The multiplier `suggestLadder` is actually given.
 *
 * A custom factor is clamped to 0.1–2 rather than refused: this is the field an
 * operator types into, and a stray keystroke should not be able to ask for a
 * ladder a hundred times the table's. Anything unparseable falls back to 1, so
 * an empty box suggests the generic ladder instead of nothing at all. The field
 * is then rewritten to this number (`onContentPresetChange`), so it shows what
 * is applied and what is remembered.
 */
const contentFactor = computed(() =>
    contentPreset.value === 'custom'
        ? Number.isFinite(customFactor.value) && customFactor.value > 0
            ? Math.min(2, Math.max(0.1, customFactor.value))
            : 1
        : (CONTENT_PRESETS.find((p) => p.id === contentPreset.value)?.factor ??
          1)
);

const audioGroups = reactive<AudioGroup[]>([]);

const editableVideoTracks = reactive<VideoTrackInfo[]>(
    props.probeResult.videoTracks.map((t) => ({ ...t }))
);

const editableAudioTracks = reactive<AudioTrackInfo[]>(
    props.probeResult.audioTracks.map((t) => ({ ...t }))
);

/**
 * Source tracks left out of the output, by track index. Every suggestion is
 * built from the tracks still included, so Re-analyze and the ladder dial
 * cannot bring one back.
 */
const excludedVideo = reactive(new Set<number>());
const excludedAudio = reactive(new Set<number>());
const includedVideoTracks = computed(() =>
    editableVideoTracks.filter((t) => !excludedVideo.has(t.index))
);
const includedAudioTracks = computed(() =>
    editableAudioTracks.filter((t) => !excludedAudio.has(t.index))
);

/** Source track picker shown whenever there are multiple video tracks to choose from. */
const showVideoRenditionSourceColumn = computed(
    () => editableVideoTracks.length > 1
);

/**
 * The segment length the encode will actually use — byte-range output pins it
 * at 6 s. Copy eligibility turns on this number, so it has to be the same one
 * `buildEncodeConfig` submits.
 */
const effectiveSegmentDuration = computed(() =>
    props.byteRange ? 6 : segmentDuration.value
);

/** Where the encoder will seek to, 0 when the source needs no aligning. */
const alignmentStart = computed(() => latestStreamStart(props.probeResult));

/**
 * Why this rendition cannot be copied, or null when it can.
 *
 * A courtesy so nobody ticks a box the API refuses — see `copyMode.ts`. It is
 * asked of the track the rendition is currently pointed at, so changing the
 * source picker changes the answer, and it follows whichever of the API's two
 * gates the submit would meet: the quick cut's cadence-only rule while
 * something is trimmed, the full rule otherwise.
 */
function copyBlockedReason(rendition: VideoRendition): string | null {
    const track = editableVideoTracks[rendition.sourceTrackIndex ?? 0];
    if (!track) return null;
    return props.trimActive
        ? quickTrimBlockedReason(track, effectiveSegmentDuration.value)
        : copyModeBlockedReason(
              track,
              alignmentStart.value,
              effectiveSegmentDuration.value
          );
}

/**
 * Un-tick any Copy the tightening rule no longer allows.
 *
 * Clearing the last cut takes the quick path away with it, and a rendition left
 * copying under the relaxed rule would sit greyed out and still ticked, with no
 * way back — the same dead end `onCopySourceChange` avoids when a copy
 * rendition is pointed at a track that does not qualify, handled the same way.
 * An un-ticked rendition is re-encoded from here on, so it is re-priced as one.
 */
watch(
    () => props.trimActive,
    (active, wasActive) => {
        if (active || !wasActive) return;
        // A ladder that was copied whole falls back whole, to a full ladder
        // per angle, rather than rung by rung into a mix nobody chose.
        if (fallBackFromCopy()) return;
        for (const [i, rendition] of videoRenditions.entries()) {
            if (rendition.copyStream && copyBlockedReason(rendition) != null) {
                rendition.copyStream = false;
                sourceFromBestTrack(rendition);
                rejoinLadder(i);
                continue;
            }
            if (rendition.copyStream && rendition.sourceTrackIndex != null) {
                const track = editableVideoTracks[rendition.sourceTrackIndex];
                if (track) {
                    // Coded dimensions, and correctly so: a copy publishes the
                    // source's own bytes. It is only reached for a track whose
                    // coded and display sizes agree, because an anamorphic one
                    // was un-ticked by the guard above.
                    rendition.width = track.width;
                    rendition.height = track.height;
                    rendition.videoBitrateKbps =
                        track.bitrateKbps || rendition.videoBitrateKbps;
                }
            }
        }
    }
);

function mapTierToGroupId(standardGroupId: string, tierIds: string[]): string {
    if (tierIds.includes(standardGroupId)) return standardGroupId;
    const tierIndex =
        standardGroupId === 'hd' ? 0 : standardGroupId === 'mid' ? 1 : 2;
    return (
        tierIds[Math.min(tierIndex, tierIds.length - 1)] ??
        tierIds[0] ??
        'tier_0'
    );
}

/**
 * A multi-angle row is one angle at its own size, so its budget is the track's
 * measured bitrate — the same ceiling the single-track ladder's cap imposes —
 * on the same asymmetric terms as that ladder: a Low-motion factor scales it
 * down, because spending less is always the operator's to choose, while a
 * raising factor is ignored, because spending more than the source carries
 * buys nothing. It used to be the measurement outright, and on a source that
 * arrives as six pre-cut angles the content preset visibly did nothing. A
 * copied angle mirrors the source's own number because that *is* the stream.
 * An angle whose probe gave no bitrate takes the fps-adjusted table top for its
 * own size: a 4K one opened at 1000 kbps once — a 240p budget for a 2160p
 * picture — and the table is the honest guess, uncapped by construction since
 * the cap is Infinity exactly when the source bitrate is the thing that is
 * missing.
 *
 * At module scope because an angle that stops copying is priced by the same
 * rule it would have been given had it opened re-encoded.
 */
function angleBudgetKbps(track: VideoTrackInfo, copied: boolean): number {
    const measured = track.bitrateKbps;
    if (!measured)
        return suggestLadder(track, contentFactor.value)[0].bitrateKbps;
    if (copied) return measured;
    return Math.max(1, Math.round(measured * Math.min(contentFactor.value, 1)));
}

// ---- Camera angles and the ladder mode -------------------------------------

/**
 * The probe compared the video tracks' pictures. Without it a multi-track
 * source keeps the treatment it always had — every track its own angle — since
 * "no `pictureGroup`" then means "never compared", not "a separate picture".
 */
const anglesDetected = props.probeResult.anglesDetected === true;

/**
 * Which tracks make which angle is known: the probe compared them, or the
 * operator has moved a track and so said it themselves. Until then every track
 * is its own angle and the form suggests what it always did.
 */
const anglesKnown = ref(anglesDetected);

/** Track index → angle id. Seeded from the probe; the operator can move tracks. */
const angleAssignment = ref<AngleAssignment>(
    initialAssignment(props.probeResult.videoTracks)
);

/** The source has more than one video track, so renditions name their angle. */
const multiTrack = computed(() => editableVideoTracks.length > 1);

/** The angles the encode would write: those with a track still included. */
const currentAngles = computed(() =>
    anglesOf(editableVideoTracks, angleAssignment.value, excludedVideo)
);

/** Every angle, including ones whose tracks are all left out — for the picker. */
const allAngles = computed(() =>
    anglesOf(editableVideoTracks, angleAssignment.value, excludedVideo, false)
);

const angleNameById = computed(() => angleNames(allAngles.value));

/** The angle a row belongs to: the one it says, else its source track's. */
function rowAngle(r: VideoRendition): number {
    return (
        r.angle ??
        angleAssignment.value.get(r.sourceTrackIndex ?? 0) ??
        r.sourceTrackIndex ??
        0
    );
}

type LadderMode = 'copy' | 'reencode';
type SuggestMode = LadderMode | 'legacy';

/**
 * The mode the last suggestion was made in: every included track copied as a
 * rung of its angle, or a full ladder per angle re-encoded from its best
 * track. It is what a suggestion is repeated in when the rows no longer say —
 * see {@link shownLadderMode} for what the control shows.
 */
const ladderMode = ref<LadderMode | null>(null);

/**
 * The mode the rows are in now, which is what the control lights: Copy when
 * every row copies, Re-encode when none does, neither for a mix — made by hand
 * or restored — since a mix is not one of the two things the control builds.
 * Read off the rows rather than remembered, so ticking a row's Copy box cannot
 * leave the control claiming a mode the ladder is no longer in.
 */
const shownLadderMode = computed<LadderMode | null>(() => {
    if (videoRenditions.length === 0) return null;
    if (videoRenditions.every((r) => r.copyStream)) return 'copy';
    if (videoRenditions.every((r) => !r.copyStream)) return 'reencode';
    return null;
});

/** The operator has picked a mode at least once this session. */
let ladderModeChosen = false;

/** Why Copy fell back to Re-encode on its own, shown until the next choice. */
const ladderModeNotice = ref<string | null>(null);

function trackLabel(t: VideoTrackInfo): string {
    const d = displayDimensionsOf(t);
    return `#${t.index} ${d.width}×${d.height}`;
}

/**
 * Why the whole ladder cannot be copied, or null when it can.
 *
 * Every included track has to qualify on its own — the same rule each row's
 * Copy box follows, so the API's gate agrees — and where an angle has more
 * than one, they have to cut keyframes together: a player stepping between two
 * copied rungs expects segment N of each to start at the same instant, and a
 * copied stream is cut at its own keyframes. The probe measured that through
 * the whole file and gave tracks that agree the same `keyframeGrid`.
 */
const copyLadderBlockedReason = computed<string | null>(() => {
    for (const angle of currentAngles.value) {
        for (const track of angle.included) {
            const reason = props.trimActive
                ? quickTrimBlockedReason(track, effectiveSegmentDuration.value)
                : copyModeBlockedReason(
                      track,
                      alignmentStart.value,
                      effectiveSegmentDuration.value
                  );
            if (reason) return `${trackLabel(track)}: ${reason}`;
        }
        if (angle.included.length < 2) continue;
        const unknown = angle.included.find((t) => t.keyframeGrid == null);
        if (unknown)
            return (
                `${trackLabel(unknown)}: its keyframes were not compared with ` +
                `the other tracks of its angle, so they cannot be copied as one ladder.`
            );
        // The odd one out is named against the grid most of the angle is on,
        // so unticking the track named is what makes Copy available.
        const counts = new Map<number, number>();
        for (const t of angle.included)
            counts.set(t.keyframeGrid!, (counts.get(t.keyframeGrid!) ?? 0) + 1);
        const common = [...counts].sort((a, b) => b[1] - a[1])[0][0];
        const stray = angle.included.find((t) => t.keyframeGrid !== common);
        if (stray)
            return (
                `${trackLabel(stray)}: it does not line up with the other ` +
                `tracks of its angle (keyframes or length), so they cannot be ` +
                `copied as one ladder.`
            );
    }
    return null;
});

/**
 * The mode a fresh suggestion opens in.
 *
 * Copy when the source carries a ladder (some angle has several tracks) good
 * enough to copy as it is — the cheapest encode there is, and the source's own
 * ladder was already built for streaming. Otherwise every angle is re-encoded
 * from its best track, which for a one-track source is the ladder it has
 * always had.
 */
function defaultSuggestMode(): SuggestMode {
    if (!anglesKnown.value && includedVideoTracks.value.length > 1)
        return 'legacy';
    const carriesLadder = currentAngles.value.some((a) => a.included.length > 1);
    return carriesLadder && copyLadderBlockedReason.value == null
        ? 'copy'
        : 'reencode';
}

/**
 * The mode a suggestion made now would be in: the one the ladder is in — what
 * its rows show, or for a hand-made mix the one it was last suggested in —
 * else the source's default. Before the angles are known the mode is only a
 * reading of the rows, not a choice, and does not steer unless the operator
 * made it one. A repeat never asks for a copy that is no longer possible.
 */
function currentSuggestMode(): SuggestMode {
    let steering: LadderMode | null =
        anglesKnown.value || ladderModeChosen
            ? (shownLadderMode.value ?? ladderMode.value)
            : null;
    if (steering === 'copy' && copyLadderBlockedReason.value != null)
        steering = 'reencode';
    return steering ?? defaultSuggestMode();
}

/**
 * The source carries a ladder of its own: some picture is in it at more than
 * one quality. Read off the angles where they are known — and off every track
 * of them, ticked or not, since leaving a proxy out of the encode does not
 * change what the file is. Before the angles are known, several included
 * video tracks is all there is to go by, as it always was.
 */
const sourceCarriesLadder = computed(() =>
    anglesKnown.value
        ? allAngles.value.some((a) => a.members.length > 1)
        : includedVideoTracks.value.length > 1
);

/**
 * The audio suggestion that goes with a video ladder made in `mode`.
 *
 * A source with its own ladder usually carries its audio the same way, one
 * track per tier. Copied, each tier takes the matching track, as it always
 * has. Re-encoded, every tier is made from its language's best track — the
 * same rule the video rungs follow, and what makes the whole encode a
 * re-encode, so a trim cuts every stream the same way.
 *
 * In Re-encode mode the ladder is judged by the angles: two cameras with one
 * track each are not one picture twice, so two audio tracks beside them are
 * not taken for one sound twice either, and both go in every tier.
 */
function suggestAudioGroups(mode: SuggestMode): AudioGroup[] {
    if (mode !== 'reencode')
        return buildSuggestedAudioGroups(
            includedAudioTracks.value,
            includedVideoTracks.value.length
        );
    // The count is only ever read as "more than one", the mark of a source
    // with its own ladder — so that is what it is given.
    return buildSuggestedAudioGroups(
        includedAudioTracks.value,
        sourceCarriesLadder.value ? 2 : 1,
        true
    );
}

/**
 * The fields every row of a multi-track source carries to say where it comes
 * from. A one-track source keeps the config it always had: no angle, and no
 * source track when that is track 0.
 */
function sourceFields(
    trackIndex: number,
    angle: number
): Pick<VideoRendition, 'sourceTrackIndex' | 'angle'> {
    if (!multiTrack.value)
        return trackIndex !== 0 ? { sourceTrackIndex: trackIndex } : {};
    return { sourceTrackIndex: trackIndex, angle };
}

/** Copy mode: every included track, a copied rung of its angle, largest first. */
function copiedLadderRows(tierIds: string[]): VideoRendition[] {
    return currentAngles.value.flatMap((angle) =>
        angle.included.map((track) => {
            const display = displayDimensionsOf(track);
            const tier = getAudioTierForHeight(
                Math.min(display.width, display.height)
            );
            return {
                // Coded size: a copy publishes the source's own bytes, and an
                // anamorphic track never qualifies for one.
                width: track.width,
                height: track.height,
                videoBitrateKbps: angleBudgetKbps(track, true),
                copyStream: true,
                ...sourceFields(track.index, angle.id),
                // A copy has to say which track it copies, whatever the source.
                sourceTrackIndex: track.index,
                audioGroupId: mapTierToGroupId(tier.groupId, tierIds),
                vbr: false,
            };
        })
    );
}

/**
 * Re-encode mode: per angle, the full suggested ladder, every rung made from
 * the angle's best included track — so the 360p rung is scaled down from the
 * 1080p master, not re-encoded from the source's own 360p proxy.
 */
function reencodedLadderRows(tierIds: string[]): VideoRendition[] {
    return currentAngles.value.flatMap((angle) =>
        suggestLadder(angle.best, contentFactor.value).map((rung) => {
            // By the rung's short side, as it was chosen and priced: a
            // portrait 480x854 rung is a 480p rung, and by height it took the
            // HD audio group where its landscape twin takes the standard one.
            const tier = getAudioTierForHeight(
                Math.min(rung.width, rung.height)
            );
            // No `label` on a ladder rung: the API derives each stream's S3
            // directory from `label ?? `${height}p``, so naming them here
            // would move the output for nothing.
            return {
                width: rung.width,
                height: rung.height,
                videoBitrateKbps: rung.bitrateKbps,
                copyStream: false,
                ...sourceFields(angle.best.index, angle.id),
                audioGroupId: mapTierToGroupId(tier.groupId, tierIds),
                vbr: true,
            };
        })
    );
}

/** The operator chose a mode: rebuild the rows in it. */
function setLadderMode(mode: LadderMode) {
    if (mode === 'copy' && copyLadderBlockedReason.value != null) return;
    ladderModeNotice.value = null;
    ladderModeChosen = true;
    reanalyzeVideo(mode);
}

/**
 * A ladder that was copied whole can no longer be — the segment length or the
 * trim changed under it, or a track that does not line up was ticked. Rebuild
 * it re-encoded and say why, rather than leave a ladder the API would refuse
 * with every Copy box greyed out and ticked. Returns whether it did.
 *
 * Only a ladder still wholly copied: rows the operator has already switched by
 * hand are theirs, and rebuilding would discard them over a Copy box they no
 * longer have ticked. And only where the angles are known — a session from
 * before detection keeps what it always did, row by row.
 */
function fallBackFromCopy(): boolean {
    const reason = copyLadderBlockedReason.value;
    if (reason == null || shownLadderMode.value !== 'copy') return false;
    if (encodingType.value !== 'video' || !anglesKnown.value) return false;
    ladderModeNotice.value = `Switched to re-encoding: ${reason}`;
    reanalyzeVideo('reencode');
    return true;
}

watch(copyLadderBlockedReason, () => {
    fallBackFromCopy();
});

/**
 * A rung that stops copying is made from its angle's best track from then on,
 * not from the track it was a copy of: re-encoding a 360p proxy to get a 360p
 * rung throws away everything the master beside it has.
 */
function sourceFromBestTrack(rendition: VideoRendition): void {
    if (!anglesKnown.value || !multiTrack.value) return;
    const angle = currentAngles.value.find((a) => a.id === rowAngle(rendition));
    if (angle) rendition.sourceTrackIndex = angle.best.index;
}

/**
 * Rebuild only angle `id`'s rows, in the current mode, keeping every other
 * row, the audio groups and the dials as the operator left them.
 */
function rebuildAngle(id: number) {
    const snapshot = () =>
        videoRenditions.map((r, i) => ({ row: { ...r }, base: ladderBaseKbps[i] }));
    const keep = snapshot()
        .filter(({ row }) => rowAngle(row) !== id)
        .map((m) => ({ ...m, fresh: false }));
    const groups = audioGroups.map((g) => ({ ...g }));
    const dial = {
        num: ladderScaleNum,
        den: ladderScaleDen,
        min: ladderMin.value,
        lastMin: lastGoodLadderMin,
    };
    // In the ladder's mode; a hand-mixed ladder takes the mode it was last
    // suggested in. A session from before detection that nobody has switched
    // takes the old suggestion.
    reanalyzeVideo(
        anglesKnown.value || ladderModeChosen
            ? (shownLadderMode.value ?? ladderMode.value ?? 'reencode')
            : undefined
    );
    const fresh = snapshot()
        .filter(({ row }) => rowAngle(row) === id)
        .map((m) => ({ ...m, fresh: true }));
    // Back in angle order, so each angle's rows stay together.
    const order = (row: VideoRendition) =>
        allAngles.value.findIndex((a) => a.id === rowAngle(row));
    const merged = [...keep, ...fresh].sort(
        (a, b) => order(a.row) - order(b.row)
    );
    videoRenditions.splice(0, videoRenditions.length, ...merged.map((m) => m.row));
    ladderBaseKbps.splice(
        0,
        ladderBaseKbps.length,
        ...merged.map((m) => m.base ?? m.row.videoBitrateKbps)
    );
    audioGroups.splice(0, audioGroups.length, ...groups);
    repairAudioGroupRefs();
    // The suggestion reset the dials; the rows kept were priced at the setting
    // they had, so that setting is put back and the new rows join at it.
    ladderScaleNum = dial.num;
    ladderScaleDen = dial.den;
    ladderMin.value = dial.min;
    lastGoodLadderMin = dial.lastMin;
    syncLadderDials();
    merged.forEach((m, i) => {
        if (m.fresh && !videoRenditions[i].copyStream)
            videoRenditions[i].videoBitrateKbps = priceRow(ladderBaseKbps[i]);
    });
}

/**
 * Move a source track to another angle, or to one of its own. Detection can
 * be wrong — two cameras framed alike look like one picture — and this is the
 * way to say so. The whole video suggestion is made again, in the current
 * mode: angle ids are re-keyed by their lowest member, so the angle the track
 * left can change id, and rows filed under the old one would point nowhere.
 */
function setTrackAngle(track: number, target: number | 'new') {
    const current = angleAssignment.value.get(track) ?? track;
    if (target === current) return;
    const alone =
        [...angleAssignment.value.values()].filter((id) => id === current)
            .length === 1;
    // Already an angle of its own: nothing to move, and nothing to rebuild.
    if (target === 'new' && alone) return;
    const copying = (shownLadderMode.value ?? ladderMode.value) === 'copy';
    angleAssignment.value = moveTrack(angleAssignment.value, track, target);
    anglesKnown.value = true;
    ladderModeNotice.value = null;
    // Copy may stop being possible (the moved track does not line up with its
    // new angle); the mode falls to Re-encode rather than to a refused ladder.
    const reason = copyLadderBlockedReason.value;
    if (copying && reason != null) {
        ladderModeNotice.value = `Switched to re-encoding: ${reason}`;
        reanalyzeVideo('reencode');
    } else {
        reanalyzeVideo();
    }
}

const angleSelectOptions = computed<SelectMenuOption[]>(() => [
    ...allAngles.value.map((a) => ({
        value: a.id,
        label: angleNameById.value.get(a.id) ?? `Angle ${a.id}`,
    })),
    { value: 'new', label: 'New angle' },
]);

/** The track an angle is keyed by, whose name is the angle's name. */
function angleIdTrack(angle: { id: number; members: VideoTrackInfo[] }) {
    return angle.members.find((t) => t.index === angle.id) ?? angle.members[0];
}

/** `t` is the track its angle is keyed by. */
function namesAngle(t: VideoTrackInfo): boolean {
    return (angleAssignment.value.get(t.index) ?? t.index) === t.index;
}

/**
 * Detected Media's rows: tracks angle by angle, each angle's best first. The
 * first row of an angle carries its name; the rest say whose picture they are.
 */
const videoTrackRows = computed(() =>
    allAngles.value.flatMap((angle) =>
        angle.members.map((track, n) => ({
            track,
            angle,
            first: n === 0,
            idTrack: angleIdTrack(angle),
        }))
    )
);

/**
 * Make the video suggestion again, in `mode` — by default the mode the ladder
 * is already in, or the source's default when it is in none.
 *
 * `legacy` is the suggestion every multi-track source got before angles were
 * detected — every track its own angle, copied where it qualifies — and is
 * only ever the default for a probe that did not detect angles, so a session
 * from before detection, or one where it failed, opens exactly as it did.
 */
function reanalyzeVideo(mode?: SuggestMode) {
    // Unasked, a suggestion repeats the mode the ladder is in.
    const suggest = mode ?? currentSuggestMode();
    // By display area, not coded area: two angles of the same picture size
    // should sort together whatever shape their samples are.
    const displayArea = (t: VideoTrackInfo) => {
        const d = displayDimensionsOf(t);
        return d.width * d.height;
    };
    const sortedVideoTracks = [...includedVideoTracks.value].sort(
        (a, b) => displayArea(b) - displayArea(a)
    );

    const newGroups = suggestAudioGroups(suggest);
    const tierIds = [...new Set(newGroups.map((g) => g.id))];
    audioGroups.splice(0, audioGroups.length, ...newGroups);

    if (suggest === 'legacy' && sortedVideoTracks.length > 1) {
        const newRenditions: VideoRendition[] = sortedVideoTracks.map(
            (track) => {
                const display = displayDimensionsOf(track);
                // By the short side, as the ladder is: a portrait angle's
                // height is its long side.
                const tier = getAudioTierForHeight(
                    Math.min(display.width, display.height)
                );
                const audioGroupId = mapTierToGroupId(tier.groupId, tierIds);
                // Multi-angle output has always defaulted to copying each
                // angle — it is far and away the cheapest thing to do with a
                // second camera. It is only offered where the source qualifies
                // for it, though, or the form would open on a configuration the
                // API refuses and the tick box would be greyed out and ticked.
                const canCopy =
                    copyModeBlockedReason(
                        track,
                        alignmentStart.value,
                        effectiveSegmentDuration.value
                    ) == null;
                return {
                    // Display dimensions: the encoder scales to these and tags
                    // the result square. An anamorphic angle is never `canCopy`
                    // — `copyModeBlockedReason` refuses it — so a copied angle's
                    // display size and coded size are the same number anyway.
                    width: display.width,
                    height: display.height,
                    videoBitrateKbps: angleBudgetKbps(track, canCopy),
                    copyStream: canCopy,
                    sourceTrackIndex: track.index,
                    audioGroupId,
                    label: track.name ?? `Track ${track.index}`,
                    vbr: true,
                };
            }
        );
        videoRenditions.splice(0, videoRenditions.length, ...newRenditions);
    } else if (suggest === 'copy') {
        videoRenditions.splice(
            0,
            videoRenditions.length,
            ...copiedLadderRows(tierIds)
        );
    } else if (sortedVideoTracks.length > 0) {
        videoRenditions.splice(
            0,
            videoRenditions.length,
            ...reencodedLadderRows(tierIds)
        );
    }
    ladderMode.value = suggest === 'legacy' ? null : suggest;

    // Snapshot after whichever branch ran: the dial rescales from what was
    // suggested, and all three `reanalyze()` triggers — setup, the saved-labels
    // re-run, the Re-analyze button — come through here, so the dial resets
    // with the ladder for free.
    ladderBaseKbps.splice(
        0,
        ladderBaseKbps.length,
        ...videoRenditions.map((r) => r.videoBitrateKbps)
    );
    ladderScaleNum = 1;
    ladderScaleDen = 1;
    ladderMax.value = suggestedLadderMax.value;
    lastGoodLadderMax = ladderMax.value;
    // Back to auto with it: a pin from the previous ladder is a number about
    // rungs that no longer exist.
    ladderMin.value = null;
    lastGoodLadderMin = null;
}

function reanalyzeAudio() {
    audioGroups.splice(
        0,
        audioGroups.length,
        ...buildSuggestedAudioGroups(includedAudioTracks.value, 0)
    );
}

/** Angles can be chosen only for a video encode with more than one; one angle is Audio only's job. */
const choosableVideo = computed(
    () => encodingType.value === 'video' && editableVideoTracks.length > 1
);
const choosableAudio = computed(() => editableAudioTracks.length > 1);

function trackCount(included: number, total: number): string {
    return included === total ? String(total) : `${included} of ${total}`;
}

function includeTitle(kind: 'video' | 'audio', index: number): string {
    if (!canExclude(kind, index))
        return kind === 'video'
            ? 'A video encode needs at least one angle'
            : 'The encode needs at least one audio track';
    return (kind === 'video' ? excludedVideo : excludedAudio).has(index)
        ? 'Left out of the encode — tick to include it'
        : 'Untick to leave this track out of the encode';
}

/** At least one angle and one audio track stay in: the API refuses a video encode without either. */
function canExclude(kind: 'video' | 'audio', index: number): boolean {
    if (kind === 'video')
        return excludedVideo.has(index) || includedVideoTracks.value.length > 1;
    return excludedAudio.has(index) || includedAudioTracks.value.length > 1;
}

/** Renditions pointing at an audio group that no longer exists take the first one left. */
function repairAudioGroupRefs() {
    const ids = new Set(audioGroups.map((g) => g.id));
    const fallback = audioGroups[0]?.id;
    if (!fallback) return;
    for (const r of videoRenditions) {
        if (!ids.has(r.audioGroupId)) r.audioGroupId = fallback;
    }
}

/**
 * Takes a source track in or out of the output. Only its angle's rows change,
 * so edits to the others stay. The exception is a change between one included
 * track and several, which changes the audio suggestion, so the video
 * suggestion is made again.
 */
function setTrackIncluded(kind: 'video' | 'audio', index: number, included: boolean) {
    if (!included && !canExclude(kind, index)) return;
    if (kind === 'audio') {
        const suggest = () =>
            encodingType.value === 'video'
                ? suggestAudioGroups(currentSuggestMode())
                : buildSuggestedAudioGroups(includedAudioTracks.value, 0);
        const sourcesOf = (groups: AudioGroup[]) =>
            new Set(groups.map((g) => g.sourceTrackIndex));
        const before = sourcesOf(suggest());
        if (included) excludedAudio.delete(index);
        else excludedAudio.add(index);
        const suggested = suggest();
        const after = sourcesOf(suggested);
        // The groups that go are the unticked track's; the ones that come are
        // the ticked track's. No other track's groups move, so what the
        // operator set on them stays.
        const leaving = new Set<number>(included ? [] : [index]);
        const joining = new Set<number>(included ? [index] : []);
        // Where every tier is made from its language's best track, the tick
        // can change which track that is: unticking the best hands its tiers
        // to the next best, and ticking a better one takes them over.
        if (
            encodingType.value === 'video' &&
            currentSuggestMode() === 'reencode'
        ) {
            const has = sourcesOf(audioGroups);
            for (const t of before) if (!after.has(t)) leaving.add(t);
            for (const t of after)
                if (!before.has(t) && !has.has(t)) joining.add(t);
        }
        const incoming = suggested.filter((g) => joining.has(g.sourceTrackIndex));
        const kept: AudioGroup[] = [];
        for (const g of audioGroups) {
            if (!leaving.has(g.sourceTrackIndex)) {
                kept.push(g);
                continue;
            }
            // A track taking a tier over takes its place in it, so the order
            // of a tier's languages does not turn on which track is ticked.
            const at = incoming.findIndex((x) => x.id === g.id);
            if (at >= 0) kept.push(...incoming.splice(at, 1));
        }
        for (const g of incoming) {
            // After the last group of its tier, so each tier stays together.
            const at = kept.map((x) => x.id).lastIndexOf(g.id);
            if (at < 0) kept.push(g);
            else kept.splice(at + 1, 0, g);
        }
        audioGroups.splice(0, audioGroups.length, ...kept);
        repairAudioGroupRefs();
        return;
    }
    // Counted in included tracks, as the audio suggestion counts them: one
    // track against several is what decides an already-ABR source's audio.
    const countBefore = includedVideoTracks.value.length;
    const angle = angleAssignment.value.get(index) ?? index;
    const bestOf = () =>
        currentAngles.value.find((a) => a.id === angle)?.best.index;
    const bestBefore = bestOf();
    if (included) excludedVideo.delete(index);
    else excludedVideo.add(index);
    const countAfter = includedVideoTracks.value.length;
    if (countBefore <= 1 || countAfter <= 1) {
        // Before the angles were known, one track against several also chose
        // between a ladder and copied angles, and still does there.
        reanalyzeVideo(anglesKnown.value ? undefined : defaultSuggestMode());
        return;
    }
    // A re-encoded angle is made from its best track alone. Ticking or
    // unticking another of its tracks changes nothing the encode does, so the
    // rows — and whatever the operator has set on them — are left as they are,
    // bar any row pointed by hand at the track just left out.
    const angleRows = videoRenditions.filter((r) => rowAngle(r) === angle);
    if (
        angleRows.length > 0 &&
        angleRows.every((r) => !r.copyStream) &&
        bestBefore != null &&
        bestBefore === bestOf()
    ) {
        if (!included) {
            for (let i = videoRenditions.length - 1; i >= 0; i--) {
                if ((videoRenditions[i].sourceTrackIndex ?? 0) !== index) continue;
                videoRenditions.splice(i, 1);
                ladderBaseKbps.splice(i, 1);
            }
            syncLadderDials();
        }
        return;
    }
    // Otherwise only the angle the track belongs to is made again: in Copy
    // mode its rungs gain or lose this track's; in Re-encode its ladder
    // follows its best track, which has just changed. Every other row stays.
    rebuildAngle(angle);
}

function reanalyze() {
    if (encodingType.value === 'audio') {
        reanalyzeAudio();
    } else {
        reanalyzeVideo();
    }
}

/**
 * The layout key the preset is filed under.
 *
 * Always the video key, whatever mode the form opens in: the preset only shapes
 * a video ladder, and keying it by the current mode would file one preset under
 * two names and lose it the moment someone toggled to Audio only and back.
 */
const presetLayoutKey = computed(() =>
    computeLayoutKey(props.probeResult, 'video')
);

/**
 * Restore the remembered preset *before* the first `reanalyze()`.
 *
 * The preset is an input to the suggestion, not a decoration on it — applied
 * afterwards it would leave the operator looking at a generic ladder under a
 * label claiming otherwise until something happened to re-derive it.
 */
{
    const stored = getStoredContentPreset(presetLayoutKey.value);
    const known =
        stored?.preset === 'custom' ||
        CONTENT_PRESETS.some((p) => p.id === stored?.preset);
    // An id this build does not know (an older or newer store, a hand-edited
    // one) is ignored rather than trusted: Standard is the honest default, and
    // a factor out of range would price the whole ladder off it.
    if (stored && known) {
        contentPreset.value = stored.preset as typeof contentPreset.value;
        if (
            typeof stored.customFactor === 'number' &&
            Number.isFinite(stored.customFactor) &&
            stored.customFactor >= 0.1 &&
            stored.customFactor <= 2
        ) {
            customFactor.value = stored.customFactor;
        }
    }
}

reanalyze();

{
    const savedConfig = getStoredConfig(
        computeLayoutKey(props.probeResult, encodingType.value)
    );
    if (savedConfig) {
        // Fill blanks only — never overwrite what the source itself provided.
        applySavedTrackLabels(
            savedConfig,
            editableVideoTracks,
            editableAudioTracks,
            false
        );
        reanalyze();
    }
}

if (props.restoreConfig) restore(props.restoreConfig);

/**
 * Put the form back as `config` had it: its mode, rows and track names. The
 * suggestion for that mode runs first, so whatever `config` leaves out keeps
 * its default; the ladder dials then measure from the restored rows.
 */
/**
 * Untick the tracks restored rows have no use for — and only those.
 *
 * Unticking every track no row names would be wrong for a re-encoded angle:
 * its rungs all name the best track, its other tracks are simply not the
 * source, and leaving them unticked would lose those rungs the moment the
 * operator switched to Copy. So a track is left out when its angle has no
 * rows at all; when its angle's rows are all copies and none is its own; or
 * when the angle re-encodes from a track it outranks, since ticked it would
 * become the source and the restored ladder would describe something else.
 */
function excludeTracksRowsDoNotNeed(rows: VideoRendition[]): void {
    const rowsByAngle = new Map<number, VideoRendition[]>();
    for (const r of rows) {
        const id = rowAngle(r);
        if (!rowsByAngle.has(id)) rowsByAngle.set(id, []);
        rowsByAngle.get(id)!.push(r);
    }
    for (const t of editableVideoTracks) {
        const own = rowsByAngle.get(angleAssignment.value.get(t.index) ?? t.index);
        const used = own?.some((r) => (r.sourceTrackIndex ?? 0) === t.index);
        if (used) continue;
        const reencoded = own?.find((r) => !r.copyStream);
        const source = reencoded
            ? editableVideoTracks[reencoded.sourceTrackIndex ?? 0]
            : undefined;
        if (!own || !reencoded || (source && rankTracks(t, source) < 0))
            excludedVideo.add(t.index);
    }
}

/**
 * Untick the audio tracks restored groups have no use for — and only those.
 *
 * The same care {@link excludeTracksRowsDoNotNeed} takes with video: where a
 * source's ladder was re-encoded, each language's tiers all name its best
 * track, the others are simply not the source, and unticking them would leave
 * Copy mode nothing to copy. So in such a source a track nothing names stays
 * ticked when a re-encoded group is made from a track of its language that it
 * does not outrank — outranking it, it would become the source once ticked.
 * Anywhere else — an audio-only encode included, where every track is its own
 * content — an unused track is one the operator left out.
 */
function excludeAudioTracksGroupsDoNotNeed(groups: AudioGroup[]): void {
    const used = new Set(groups.map((g) => g.sourceTrackIndex));
    const sources =
        encodingType.value === 'video' && sourceCarriesLadder.value
            ? groups
                  .filter((g) => !g.copyStream)
                  .map((g) =>
                      editableAudioTracks.find(
                          (t) => t.index === g.sourceTrackIndex
                      )
                  )
                  .filter((t): t is AudioTrackInfo => t != null)
            : [];
    for (const t of editableAudioTracks) {
        if (used.has(t.index)) continue;
        const source = sources.find(
            (s) => audioLanguageOf(s) === audioLanguageOf(t)
        );
        if (!source || rankAudioTracks(t, source) < 0)
            excludedAudio.add(t.index);
    }
}

function restore(config: EncodeConfig): void {
    encodingType.value = config.type;
    reanalyze();
    if (config.segmentDuration) segmentDuration.value = config.segmentDuration;
    if (config.type === 'video' && config.videoRenditions?.length) {
        const rows = config.videoRenditions.map((r) => ({ ...r }));
        if (multiTrack.value) {
            // The angles the earlier encode wrote win over detection: a row
            // names its angle, or — written before rows did — its source track
            // was its angle. Re-keyed afterwards, so ids stay lowest members.
            const assignment = new Map(angleAssignment.value);
            for (const r of rows) {
                const track = r.sourceTrackIndex ?? 0;
                assignment.set(track, r.angle ?? track);
            }
            angleAssignment.value = normalize(assignment);
            for (const r of rows)
                r.angle = angleAssignment.value.get(r.sourceTrackIndex ?? 0);
        }
        videoRenditions.splice(0, videoRenditions.length, ...rows);
        excludeTracksRowsDoNotNeed(rows);
        ladderBaseKbps.splice(
            0,
            ladderBaseKbps.length,
            ...videoRenditions.map((r) => r.videoBitrateKbps)
        );
        ladderScaleNum = 1;
        ladderScaleDen = 1;
        ladderMax.value = suggestedLadderMax.value;
        lastGoodLadderMax = ladderMax.value;
        ladderMode.value = shownLadderMode.value;
    }
    if (config.audioGroups?.length) {
        audioGroups.splice(
            0,
            audioGroups.length,
            ...config.audioGroups.map((g) => ({ ...g }))
        );
        excludeAudioTracksGroupsDoNotNeed(config.audioGroups);
    }
    applySavedTrackLabels(config, editableVideoTracks, editableAudioTracks, true);
}

const uniqueAudioGroupOptions = computed(() => {
    const seen = new Set<string>();
    const result: { id: string; label: string }[] = [];
    for (const g of audioGroups) {
        if (!seen.has(g.id)) {
            seen.add(g.id);
            const groupEntries = audioGroups.filter((e) => e.id === g.id);
            const langs = groupEntries
                .map((e) => e.language ?? e.label ?? e.id)
                .join(', ');
            result.push({ id: g.id, label: `${g.id} (${langs})` });
        }
    }
    return result;
});

const layoutKey = computed(() =>
    computeLayoutKey(props.probeResult, encodingType.value)
);

const hasPreviousConfig = computed(
    () => getStoredConfig(layoutKey.value) != null
);

function loadPreviousTrackLabels() {
    const config = getStoredConfig(layoutKey.value);
    if (!config) return;

    // Asked for explicitly, so the saved set replaces what is on screen.
    applySavedTrackLabels(
        config,
        editableVideoTracks,
        editableAudioTracks,
        true
    );
}

function addVideoRendition() {
    const defaultGroupId = audioGroups[0]?.id ?? 'hd';
    // Priced from the source instead of a fixed 854x480 @ 1000: that width is
    // 16:9's and that bitrate is the old table's, so on a 4:3 or a low-bitrate
    // source the added row opened at a shape and a budget the source never had.
    // The 480p rung where the ladder reaches it, the smallest rung otherwise —
    // a source below 480p has no 480p to offer. Found by short side, so a
    // portrait source's 480x854 counts.
    // From the first angle's best track: track 0 may be a proxy, and a row
    // priced and sourced from it would be the one rung not made from the master.
    const firstAngle = currentAngles.value[0];
    const track = firstAngle?.best ?? editableVideoTracks[0];
    const rungs = track ? suggestLadder(track, contentFactor.value) : [];
    const rung =
        rungs.find((r) => Math.min(r.width, r.height) === 480) ??
        rungs[rungs.length - 1];
    const base = rung?.bitrateKbps ?? 1000;
    videoRenditions.push({
        width: rung?.width ?? 854,
        height: rung?.height ?? 480,
        videoBitrateKbps: base,
        copyStream: false,
        ...(track && firstAngle ? sourceFields(track.index, firstAngle.id) : {}),
        audioGroupId: defaultGroupId,
        // Named for the size it actually is. The API falls back to
        // `${height}p` when there is no label, so this is the same directory
        // for a row that really is 480p — and the right one for a row that is
        // not, which a literal '480p' would have misnamed in S3.
        label: rung ? `${rung.height}p` : '480p',
        vbr: true,
    });
    ladderBaseKbps.push(base);
    // At the dial's current level, not the raw suggestion: with the max moved
    // to 3000, a 480p rung added at its suggested 535 would sit a third below
    // the 480p rung already in the ladder.
    joinLadder(videoRenditions.length - 1);
}

function removeVideoRendition(index: number) {
    if (videoRenditions.length > 1) {
        videoRenditions.splice(index, 1);
        // Kept index-aligned, or the dial would reprice every row below the
        // removed one from its neighbour's baseline.
        ladderBaseKbps.splice(index, 1);
        // The top rung may have gone with it; the max field follows the scale
        // rather than keep showing a number no rung has any more.
        syncLadderDials();
    }
}

/**
 * One re-encoded rung's bitrate at the dials' current setting.
 *
 * With the min on auto — or with no span to remap: one rung, or a baseline the
 * source cap flattened — the max dial alone, `base * max / suggestion`. Pinned, the
 * linear remap of the re-encoded suggestion onto `[min, max]` described at
 * `applyLadder`.
 */
function priceRow(base: number): number {
    const min = ladderMin.value;
    const suggestedMax = suggestedLadderMax.value;
    const suggestedMin = suggestedLadderMin.value;
    const span = suggestedMax - suggestedMin;
    if (min == null || span === 0)
        return Math.max(
            1,
            Math.round((base * ladderScaleNum) / ladderScaleDen)
        );
    return Math.max(
        1,
        Math.round(
            min + ((ladderMax.value - min) * (base - suggestedMin)) / span
        )
    );
}

/**
 * Re-derive the max field from the dial's scale once the set of re-encoded
 * rows has changed — a row added, removed, copied, or no longer copied.
 *
 * The scale, not the field, is what the rungs were priced from, so the field
 * follows it: after the top rung is removed it shows the new top rung's value.
 * A pinned min the new max no longer clears is let go, on the same terms as a
 * max typed below it.
 */
function syncLadderDials(): void {
    ladderMax.value = Math.max(
        1,
        Math.round((suggestedLadderMax.value * ladderScaleNum) / ladderScaleDen)
    );
    lastGoodLadderMax = ladderMax.value;
    if (ladderMin.value != null && ladderMin.value > ladderMax.value) {
        ladderMin.value = null;
        lastGoodLadderMin = null;
    }
}

/**
 * The suggestion for a row that has just stopped copying.
 *
 * While it copied, its bitrate was the source's own; re-encoded, it is a budget
 * like any other rung, and is priced by the rule it would have met had it
 * opened re-encoded — the angle's budget on a multi-angle source, the suggested
 * rung at its height on a single-track one. Left at the copy's number, a 5000
 * kbps angle un-ticked under Low motion was re-encoded at 5000 rather than
 * 3000, and Re-analyze could not help, because it ticks Copy again.
 */
function reencodeBaseKbps(row: VideoRendition): number {
    const track = editableVideoTracks[row.sourceTrackIndex ?? 0];
    if (!track) return row.videoBitrateKbps;
    // Before the angles were known every track of a multi-track source was an
    // angle at its own size; now a copied rung that stops copying is a rung of
    // its angle's ladder, and is priced as the suggestion would have priced it.
    if (editableVideoTracks.length > 1 && !anglesKnown.value)
        return angleBudgetKbps(track, false);
    const rungs = suggestLadder(track, contentFactor.value);
    const exact = rungs.find((r) => r.height === row.height);
    if (exact) return exact.bitrateKbps;
    if (editableVideoTracks.length <= 1 || rungs.length === 0)
        return angleBudgetKbps(track, false);
    // A rung at a size the ladder has no rung for — a proxy at 640x352, say —
    // takes the price of the nearest one, not the whole source's budget.
    return rungs.reduce((near, r) =>
        Math.abs(r.height - row.height) < Math.abs(near.height - row.height)
            ? r
            : near
    ).bitrateKbps;
}

/**
 * Price row `index` from its baseline entry at the dial's current level.
 *
 * The dials are synced first, so a pinned remap prices it against the max the
 * field is about to show, with this row already counted among the re-encoded.
 * Only this row is priced: the rungs the operator has already set stay where
 * they are.
 */
function joinLadder(index: number): void {
    syncLadderDials();
    videoRenditions[index].videoBitrateKbps = priceRow(ladderBaseKbps[index]);
}

/** Row `index` has just stopped copying: re-derive its suggestion and join. */
function rejoinLadder(index: number): void {
    ladderBaseKbps[index] = reencodeBaseKbps(videoRenditions[index]);
    joinLadder(index);
}

/**
 * Push both dials through the whole ladder.
 *
 * Bound to `@change`, never `@input`: every intermediate keystroke is a number
 * too, and `3` on the way to `3000` would collapse the ladder to a thousandth
 * of itself before the second digit arrived.
 *
 * The rule is a linear remap of the *suggested* shape onto `[min, max]` — each
 * rung keeps its position between the suggested ends and is placed at the same
 * position between the new ones. Linear in bitrate, not in rung index or pixel
 * count, because the suggested numbers already encode how much each size is
 * worth relative to its neighbours; stretching that line keeps the rungs in
 * order and strictly increasing, which is what an ABR ladder has to be. With
 * the min on auto it collapses algebraically to `base * max / suggestedMax`,
 * the proportional scale this had before there were two dials — and that case
 * is computed as a proportional scale outright rather than through the remap,
 * because the auto min is rounded before it is displayed and feeding the
 * rounded number back in could move a rung by 1 kbps. The scale is kept as
 * `ladderScaleNum`/`ladderScaleDen`, so rows that join later are priced by it
 * too, by the same arithmetic.
 *
 * Both ends are the re-encoded rows' (`suggestedLadderMax`/`Min`), so a typed
 * max sets the top re-encoded rung to exactly that number. A pure function of
 * the snapshot and the two dials, so applying it twice lands where applying it
 * once does. Copy rows are skipped: their bitrate is the source's own, not a
 * budget.
 */
function applyLadder() {
    const max = ladderMax.value;
    if (!Number.isFinite(max) || max <= 0) {
        // A cleared or nonsense field is not an instruction to encode at
        // nothing. Put the last accepted number back and move no row. The field
        // follows, because the model did change (to '' or the bad number) and
        // changing it back re-renders the input.
        ladderMax.value = lastGoodLadderMax;
        return;
    }
    lastGoodLadderMax = max;
    // A max dragged below a pinned min unpins it rather than being refused: the
    // max is the primary control, and the alternative is a field that silently
    // rejects what was typed into it because of a number in another box.
    if (ladderMin.value != null && ladderMin.value > max) {
        ladderMin.value = null;
        lastGoodLadderMin = null;
    }
    ladderScaleNum = max;
    ladderScaleDen = suggestedLadderMax.value;
    videoRenditions.forEach((r, i) => {
        if (r.copyStream) return;
        const base = ladderBaseKbps[i];
        if (base == null) return;
        r.videoBitrateKbps = priceRow(base);
    });
}

/**
 * Pin or un-pin the bottom rung.
 *
 * An empty field is the way back to auto, not an error: clearing it is how the
 * operator says "stop holding the bottom up", and auto is the state the ladder
 * started in. A pin above the max would invert the ladder, so it is refused
 * like any other nonsense and the last good pin goes back in the box.
 */
function applyLadderMin(event: Event) {
    const raw = ladderMin.value;
    if (raw === null || (raw as unknown as string) === '') {
        ladderMin.value = null;
        lastGoodLadderMin = null;
        applyLadder();
        return;
    }
    if (!Number.isFinite(raw) || raw <= 0 || raw > ladderMax.value) {
        ladderMin.value = lastGoodLadderMin;
        // Unlike the max field, this one can be restored to `null` — the same
        // value an empty box already models — so Vue may have nothing to
        // re-render. Write the element back so it does not sit showing the
        // rejected number.
        const el = event.target as HTMLInputElement | null;
        if (el)
            el.value =
                lastGoodLadderMin == null ? '' : String(lastGoodLadderMin);
        return;
    }
    lastGoodLadderMin = raw;
    applyLadder();
}

/**
 * Remember the preset, then re-derive the whole ladder from it.
 *
 * `reanalyze()` and not a rescale of what is on screen: the factor feeds
 * `suggestLadder` itself, so only a fresh suggestion reflects it — and the
 * snapshot at the end of `reanalyzeVideo()` then resets the baseline and the
 * dial for free, which is exactly the behaviour the Re-analyze button has.
 * Hand-edited rungs are replaced, on the same terms as a dial move.
 *
 * A custom factor is first rewritten to the one actually applied — clamped,
 * or 1 for an unusable entry. The field then shows what the ladder was priced
 * at, and what is remembered is a number the load check accepts: 5 used to be
 * stored as typed, priced as 2, and refused on the way back in, so the same
 * session reopened at the default 0.6.
 */
function onContentPresetChange() {
    if (contentPreset.value === 'custom')
        customFactor.value = contentFactor.value;
    saveContentPreset(presetLayoutKey.value, {
        preset: contentPreset.value,
        customFactor: customFactor.value,
    });
    reanalyze();
}

function resetLadder() {
    ladderScaleNum = 1;
    ladderScaleDen = 1;
    ladderMax.value = suggestedLadderMax.value;
    ladderMin.value = null;
    lastGoodLadderMin = null;
    applyLadder();
}

/**
 * The min field is only meaningful with a shape to hold the bottom of: with one
 * re-encoded rung the min and the max are the same rung, and pinning one to
 * argue with the other is a control that can only contradict itself.
 */
const showLadderMin = computed(
    () => videoRenditions.filter((r) => !r.copyStream).length > 1
);

/**
 * A dial with nothing to scale is worse than no dial: hidden in audio mode, and
 * hidden when every row copies, since a copy keeps the source's own bitrate and
 * the dial would move nothing on screen.
 */
const showLadderMax = computed(
    () =>
        encodingType.value === 'video' &&
        videoRenditions.some((r) => !r.copyStream)
);

/** `1920×1080 · 24 fps · 1805 kbps` — what the dial is being judged against. */
const ladderSourceSummary = computed(() => {
    // One angle: the track its ladder is made from. Several have several
    // sources, and one line could only describe one of them.
    if (currentAngles.value.length !== 1) return '';
    const track = currentAngles.value[0].best;
    const d = displayDimensionsOf(track);
    const bitrate =
        track.bitrateKbps != null && track.bitrateKbps > 0
            ? `${track.bitrateKbps} kbps`
            : 'bitrate n/a';
    return `${d.width}×${d.height} · ${track.frameRate} fps · ${bitrate}`;
});

/**
 * How much the source carries at this row's size, when the row asks for more.
 *
 * Advisory only: the operator may deliberately spend past the source (a fixed
 * ladder a CDN expects, say) and the API puts no ceiling on `videoBitrateKbps`,
 * so nothing here reaches `canSubmit`. Null when the row is inside the cap,
 * copies its source, or the source never said what bitrate it carries — the cap
 * is `Infinity` then and there is nothing to be above.
 */
function overCapKbps(rendition: VideoRendition): number | null {
    const track = editableVideoTracks[rendition.sourceTrackIndex ?? 0];
    if (rendition.copyStream || !track) return null;
    const display = displayDimensionsOf(track);
    const cap = sourceCapKbps(
        rendition.width,
        rendition.height,
        track.bitrateKbps ?? 0,
        display.width,
        display.height,
        track.codec
    );
    return Number.isFinite(cap) && rendition.videoBitrateKbps > cap
        ? cap
        : null;
}

function addAudioGroup() {
    const id = `group_${Date.now()}`;
    audioGroups.push({
        id,
        label: 'New Audio',
        audioBitrateKbps: 128,
        channels: 2,
        audioCodec: 'aac',
        sourceTrackIndex: 0,
        vbr: true,
    });
}

function removeAudioGroup(index: number) {
    if (audioGroups.length > 1) audioGroups.splice(index, 1);
}

/** The best included audio track in `track`'s language — itself, if it is alone. */
function bestAudioTrackLike(track: AudioTrackInfo): AudioTrackInfo {
    const language = audioLanguageOf(track);
    return (
        includedAudioTracks.value
            .filter((t) => audioLanguageOf(t) === language)
            .sort(rankAudioTracks)[0] ?? track
    );
}

/**
 * A tier that stops copying is made from its language's best track from then
 * on, not from the track it was a copy of — as a video rung is
 * ({@link sourceFromBestTrack}), and under the same conditions: the angles are
 * known, and the source carries a ladder, which is what makes several tracks
 * in one language the same sound at several bitrates.
 */
function onAudioCopyToggle(g: AudioGroup) {
    if (g.copyStream) {
        g.vbr = false;
        return;
    }
    if (!anglesKnown.value || !sourceCarriesLadder.value) return;
    const track = editableAudioTracks.find((t) => t.index === g.sourceTrackIndex);
    if (track) g.sourceTrackIndex = bestAudioTrackLike(track).index;
}

function onVbrToggle(g: AudioGroup) {
    if (g.vbr) {
        g.copyStream = false;
    } else if (g.audioBitrateKbps < 100) {
        g.channels = 1;
    }
}

/**
 * Ticked, a rendition mirrors its source track, and leaves the rungs the dials
 * move; un-ticked, it joins them, re-priced as a re-encode at the dial's
 * current level. Either way the max field is re-synced, because the top
 * re-encoded rung may just have changed.
 */
function onCopyToggle(rendition: VideoRendition, index: number) {
    if (rendition.copyStream) {
        rendition.vbr = false;
        if (editableVideoTracks.length > 0) {
            const track = editableVideoTracks[rendition.sourceTrackIndex ?? 0];
            if (track) {
                rendition.width = track.width;
                rendition.height = track.height;
                rendition.videoBitrateKbps =
                    track.bitrateKbps || rendition.videoBitrateKbps;
                // A copy is a copy of a particular track, and both `canSubmit`
                // and the API refuse one that does not say which. A multi-angle
                // row always says; a single-track ladder's rungs never did, so
                // ticking Copy on one disabled Start with no reason given.
                rendition.sourceTrackIndex = track.index;
            }
        }
        syncLadderDials();
    } else {
        sourceFromBestTrack(rendition);
        rejoinLadder(index);
    }
}

function onCopySourceChange(rendition: VideoRendition, index: number) {
    // A row follows its source track into that track's angle: pointed at the
    // other camera, it is a rendition of the other camera.
    if (multiTrack.value)
        rendition.angle = angleAssignment.value.get(
            rendition.sourceTrackIndex ?? 0
        );
    // Pointing a copy rendition at a track that does not qualify would leave
    // the tick box greyed out and still ticked, with no way back. Drop to
    // re-encode instead; the reason is on the tooltip. From here on it is a
    // re-encode of the track it now points at — at that track's own display
    // size, as every angle opens, and priced as one. Left at the old track's
    // size it was priced for one angle and scaled to another's frame.
    if (rendition.copyStream && copyBlockedReason(rendition) != null) {
        rendition.copyStream = false;
        const track = editableVideoTracks[rendition.sourceTrackIndex ?? 0];
        if (track) {
            const display = displayDimensionsOf(track);
            rendition.width = display.width;
            rendition.height = display.height;
        }
        rejoinLadder(index);
    }
    if (rendition.copyStream && rendition.sourceTrackIndex != null) {
        const track = editableVideoTracks[rendition.sourceTrackIndex];
        if (track) {
            rendition.width = track.width;
            rendition.height = track.height;
            rendition.videoBitrateKbps =
                track.bitrateKbps || rendition.videoBitrateKbps;
            rendition.label = track.name ?? `${track.height}p`;
        }
    }
}

function formatDuration(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) return `${h}h ${m}m ${s}s`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
}

function onTrackInputKeydown(e: KeyboardEvent) {
    if (e.defaultPrevented) return;
    const target = e.target as HTMLElement;
    if (!target?.hasAttribute?.('data-track-field')) return;
    const row = parseInt(target.getAttribute('data-row') ?? '-1', 10);
    const col = parseInt(target.getAttribute('data-col') ?? '-1', 10);
    if (row < 0 || col < 0) return;

    const fieldset = target.closest('fieldset');
    if (!fieldset) return;
    const inputs = Array.from(
        fieldset.querySelectorAll<HTMLElement>(
            '[data-track-field][data-row][data-col]'
        )
    );
    const rows =
        Math.max(
            ...inputs.map((el) =>
                parseInt(el.getAttribute('data-row') ?? '0', 10)
            ),
            0
        ) + 1;
    const cols =
        Math.max(
            ...inputs.map((el) =>
                parseInt(el.getAttribute('data-col') ?? '0', 10)
            ),
            0
        ) + 1;

    let nextRow = row;
    let nextCol = col;
    if (e.key === 'ArrowDown') {
        nextRow = Math.min(row + 1, rows - 1);
    } else if (e.key === 'ArrowUp') {
        nextRow = Math.max(row - 1, 0);
    } else if (e.key === 'ArrowRight') {
        nextCol = Math.min(col + 1, cols - 1);
    } else if (e.key === 'ArrowLeft') {
        nextCol = Math.max(col - 1, 0);
    } else {
        return;
    }
    if (nextRow === row && nextCol === col) return;

    e.preventDefault();
    const rowOf = (el: HTMLElement) =>
        parseInt(el.getAttribute('data-row') ?? '-1', 10);
    const colOf = (el: HTMLElement) =>
        parseInt(el.getAttribute('data-col') ?? '-1', 10);
    // Up and down go to the nearest row that has a field in this column: a
    // track that is one more quality of an angle has no name field of its own.
    const vertical = e.key === 'ArrowDown' || e.key === 'ArrowUp';
    const next = vertical
        ? inputs
              .filter(
                  (el) =>
                      colOf(el) === nextCol &&
                      (e.key === 'ArrowDown'
                          ? rowOf(el) > row
                          : rowOf(el) < row)
              )
              .sort((a, b) =>
                  e.key === 'ArrowDown'
                      ? rowOf(a) - rowOf(b)
                      : rowOf(b) - rowOf(a)
              )[0]
        : inputs.find(
              (el) => rowOf(el) === nextRow && colOf(el) === nextCol
          );
    if (next) {
        next.focus();
        if (next instanceof HTMLInputElement) next.select();
    }
}

function channelLabel(ch: number): string {
    if (ch === 1) return 'Mono';
    if (ch === 2) return 'Stereo';
    if (ch === 6) return '5.1';
    if (ch === 8) return '7.1';
    return `${ch}ch`;
}

const CHANNEL_OPTIONS: readonly SelectMenuOption[] = [1, 2, 6, 8].map((ch) => ({
    value: ch,
    label: channelLabel(ch),
}));

const videoSourceOptions = computed<SelectMenuOption[]>(() =>
    editableVideoTracks.map((t) => ({
        value: t.index,
        label:
            `#${t.index}${t.name ? ` — ${t.name}` : ''} ` +
            `(${t.width}×${t.height}, ${
                t.bitrateKbps != null && t.bitrateKbps > 0
                    ? `${t.bitrateKbps} kbps`
                    : 'bitrate n/a'
            })`,
    }))
);

const audioSourceOptions = computed<SelectMenuOption[]>(() =>
    editableAudioTracks.map((t) => ({
        value: t.index,
        label: [
            `#${t.index}:`,
            t.codec,
            t.bitrateKbps ? `${t.bitrateKbps}k` : '',
            `${channelLabel(t.channels)}${t.language ? ` [${t.language}]` : ''}`,
        ]
            .filter(Boolean)
            .join(' '),
    }))
);

const contentPresetOptions: SelectMenuOption[] = [
    ...CONTENT_PRESETS.map((p) => ({ value: p.id, label: p.label })),
    { value: 'custom', label: 'Custom…' },
];

const audioGroupSelectOptions = computed<SelectMenuOption[]>(() =>
    uniqueAudioGroupOptions.value.map((o) => ({ value: o.id, label: o.label }))
);

const canSubmit = computed(() => {
    if (encodingType.value === 'video') {
        if (videoRenditions.length === 0 || audioGroups.length === 0)
            return false;
        const groupIds = new Set(audioGroups.map((g) => g.id));
        return (
            videoRenditions.every(
                (r) =>
                    r.width > 0 &&
                    r.height > 0 &&
                    r.videoBitrateKbps > 0 &&
                    groupIds.has(r.audioGroupId) &&
                    (!r.copyStream || r.sourceTrackIndex != null)
            ) && audioGroups.every((g) => g.audioBitrateKbps > 0)
        );
    }
    return (
        audioGroups.length > 0 &&
        audioGroups.every((g) => g.audioBitrateKbps > 0)
    );
});

watch(
    canSubmit,
    (valid) => {
        emit('can-submit-change', valid);
    },
    { immediate: true }
);

/**
 * Which streams this ladder copies, in the same terms the API infers a trim
 * mode from — video renditions count only for a video encode, exactly as
 * `quickTrimStreamTargets` counts them, or the label would promise a quick cut
 * the encoder refuses.
 */
const trimCopyMode = computed<TrimCopyMode>(() => {
    const flags: boolean[] = [];
    if (encodingType.value === 'video') {
        for (const rendition of videoRenditions)
            flags.push(rendition.copyStream === true);
    }
    for (const group of audioGroups) flags.push(group.copyStream === true);

    if (flags.length === 0) return 'precise';
    if (flags.every((copied) => copied)) return 'quick';
    if (flags.every((copied) => !copied)) return 'precise';
    return 'mixed';
});

watch(
    trimCopyMode,
    (mode) => {
        emit('trim-mode-change', mode);
    },
    { immediate: true }
);

function buildEncodeConfig(): EncodeConfig | null {
    if (!canSubmit.value) return null;

    const config: EncodeConfig = {
        type: encodingType.value,
        segmentDuration: props.byteRange ? 6 : segmentDuration.value,
    };

    // A row added by hand can still name a track that was left out.
    const keptGroups = audioGroups.filter((g) => !excludedAudio.has(g.sourceTrackIndex));

    if (encodingType.value === 'video') {
        config.videoRenditions = videoRenditions
            .filter((r) => !excludedVideo.has(r.sourceTrackIndex ?? 0))
            .map((r) =>
                // Every row of a multi-track source says its angle, however it
                // was made: the API would otherwise take its source track as
                // its angle, and a copied ladder would split into one per rung.
                multiTrack.value ? { ...r, angle: rowAngle(r) } : { ...r }
            );
        config.audioGroups = keptGroups.map((g) => ({ ...g }));
        // The track an angle is keyed by carries the angle's name, made unique
        // across angles — the name the encoder publishes. Where every track is
        // its own angle that is one entry per track, as it always was. A track
        // that is one more quality of an angle is listed only if it has a name
        // of its own to remember: a made-up `Angle <n>` for it would come back
        // as a real name the next time these labels are loaded.
        config.videoTrackNames = editableVideoTracks.flatMap((t) => {
            if (namesAngle(t))
                return [
                    {
                        index: t.index,
                        name:
                            angleNameById.value.get(t.index) ??
                            `Angle ${t.index}`,
                    },
                ];
            const own = t.name?.trim();
            return own ? [{ index: t.index, name: own }] : [];
        });
        config.audioTrackMetadata = editableAudioTracks.map((t) => ({
            index: t.index,
            name: t.name,
            language: t.language,
        }));
    } else {
        config.audioGroups = keptGroups.map((g) => ({ ...g }));
        config.audioTrackMetadata = editableAudioTracks.map((t) => ({
            index: t.index,
            name: t.name,
            language: t.language,
        }));
    }

    return config;
}

function onSubmit() {
    const config = buildEncodeConfig();
    if (config) emit('submit', config);
}

function onNextToTrim() {
    if (buildEncodeConfig() != null) emit('next-to-trim');
}

function getCanSubmit(): boolean {
    return canSubmit.value;
}

defineExpose({ editableAudioTracks, buildEncodeConfig, getCanSubmit });
</script>

<template>
    <div
        class="ecf-root"
        :class="{ 'ecf-root--session': props.appearance === 'session' }"
    >
        <!-- ① Mode card pair + optional segment duration -->
        <div class="ecf-modebar">
            <div class="ecf-mode-wrap">
                <span class="ecf-mode-label">Output mode</span>
                <div
                    class="ecf-mode-cards"
                    role="radiogroup"
                    aria-label="Output encoding mode"
                >
                    <button
                        type="button"
                        role="radio"
                        :aria-checked="encodingType.value === 'video'"
                        :class="[
                            'ecf-mode-card',
                            encodingType.value === 'video' &&
                                'ecf-mode-card--on',
                        ]"
                        :disabled="editableVideoTracks.length === 0"
                        :title="
                            editableVideoTracks.length === 0
                                ? 'No video tracks detected'
                                : undefined
                        "
                        @click="encodingType.value = 'video'"
                    >
                        <span class="ecf-mode-card__title">Video</span>
                        <span class="ecf-mode-card__check" aria-hidden="true">
                            <svg
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                stroke-width="3"
                                stroke-linecap="round"
                                stroke-linejoin="round"
                            >
                                <path d="M5 12l5 5 9-11" />
                            </svg>
                        </span>
                    </button>
                    <button
                        type="button"
                        role="radio"
                        :aria-checked="encodingType.value === 'audio'"
                        :class="[
                            'ecf-mode-card',
                            encodingType.value === 'audio' &&
                                'ecf-mode-card--on',
                        ]"
                        @click="encodingType.value = 'audio'"
                    >
                        <span class="ecf-mode-card__title">Audio only</span>
                        <span class="ecf-mode-card__check" aria-hidden="true">
                            <svg
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                stroke-width="3"
                                stroke-linecap="round"
                                stroke-linejoin="round"
                            >
                                <path d="M5 12l5 5 9-11" />
                            </svg>
                        </span>
                    </button>
                </div>
            </div>
            <div v-if="!byteRange" class="ecf-seg-ctrl">
                <label class="ecf-seg-lbl" for="ecf-seg-dur">Segment</label>
                <input
                    id="ecf-seg-dur"
                    v-model.number="segmentDuration.value"
                    type="number"
                    min="1"
                    class="ecf-input ecf-input-num"
                    title="HLS segment duration in seconds"
                />
                <span class="ecf-seg-lbl" aria-hidden="true">s</span>
            </div>
        </div>

        <!-- ② Detected Media — collapsible reference panel -->
        <details class="ecf-detect" open>
            <summary class="ecf-detect-summary">
                <svg
                    class="ecf-detect-chevron"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    stroke-width="2"
                    aria-hidden="true"
                >
                    <path
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        d="M19 9l-7 7-7-7"
                    />
                </svg>
                <span class="ecf-detect-title">Detected Media</span>
                <span class="ecf-detect-meta"
                    >{{ probeResult.format.formatName }} ·
                    {{ formatDuration(probeResult.format.duration) }} ·
                    {{ probeResult.format.bitrateKbps }} kbps</span
                >
                <span
                    v-if="editableVideoTracks.length > 0"
                    class="ecf-detect-badge ecf-detect-badge--video"
                    >{{ trackCount(includedVideoTracks.length, editableVideoTracks.length) }}
                    video</span
                >
                <span
                    v-if="editableAudioTracks.length > 0"
                    class="ecf-detect-badge ecf-detect-badge--audio"
                    >{{ trackCount(includedAudioTracks.length, editableAudioTracks.length) }}
                    audio</span
                >
                <button
                    v-if="hasPreviousConfig"
                    type="button"
                    class="ecf-btn-accent ecf-detect-action"
                    @click.stop.prevent="loadPreviousTrackLabels"
                >
                    Load saved track labels
                </button>
            </summary>
            <fieldset class="ecf-detect-body ecf-fieldset">
                <div v-if="editableVideoTracks.length > 0">
                    <p class="ecf-detect-sub">Angle</p>
                    <p v-if="choosableVideo" class="ecf-hint" data-test="include-hint-video">
                        Untick a track to leave it out of the encode. The others keep their settings.
                    </p>
                    <p
                        v-if="choosableVideo && anglesDetected"
                        class="ecf-hint"
                        data-test="angle-hint"
                    >
                        Tracks showing the same picture were grouped into one
                        angle. Move a track to another angle if it was grouped
                        wrongly. Re-encoding makes every rendition of an angle
                        from its best ticked track.
                    </p>
                    <div class="ecf-table-wrap">
                        <table class="ecf-table">
                            <thead class="ecf-thead">
                                <tr>
                                    <th v-if="choosableVideo" class="ecf-th ecf-th-include">
                                        Include
                                    </th>
                                    <th class="ecf-th">#</th>
                                    <th class="ecf-th">Codec</th>
                                    <th class="ecf-th">Resolution</th>
                                    <th class="ecf-th">Bitrate</th>
                                    <th class="ecf-th">FPS</th>
                                    <th v-if="choosableVideo" class="ecf-th">Angle</th>
                                    <th class="ecf-th">Angle name</th>
                                </tr>
                            </thead>
                            <tbody class="ecf-tbody">
                                <tr
                                    v-for="(row, rowIdx) in videoTrackRows"
                                    :key="row.track.index"
                                    class="ecf-tr"
                                    :class="{
                                        'ecf-tr--excluded': choosableVideo && excludedVideo.has(row.track.index),
                                        'ecf-tr--member': choosableVideo && !row.first,
                                    }"
                                >
                                    <td v-if="choosableVideo" class="ecf-td ecf-td-include">
                                        <input
                                            type="checkbox"
                                            class="ecf-checkbox"
                                            data-test="track-include"
                                            data-kind="video"
                                            :data-track-index="row.track.index"
                                            :checked="!excludedVideo.has(row.track.index)"
                                            :disabled="!canExclude('video', row.track.index)"
                                            :title="includeTitle('video', row.track.index)"
                                            :aria-label="`Include angle ${row.track.index}`"
                                            @change="setTrackIncluded('video', row.track.index, ($event.target as HTMLInputElement).checked)"
                                        />
                                    </td>
                                    <td class="ecf-td">{{ row.track.index }}</td>
                                    <td class="ecf-td">
                                        {{ row.track.codec
                                        }}{{
                                            row.track.profile ? ` (${row.track.profile})` : ''
                                        }}
                                    </td>
                                    <td class="ecf-td">
                                        {{ row.track.width }}&times;{{ row.track.height }}
                                    </td>
                                    <td class="ecf-td">
                                        {{
                                            row.track.bitrateKbps
                                                ? `${row.track.bitrateKbps} kbps`
                                                : '—'
                                        }}
                                    </td>
                                    <td class="ecf-td">{{ row.track.frameRate }}</td>
                                    <td v-if="choosableVideo" class="ecf-td">
                                        <SelectMenu
                                            :model-value="row.angle.id"
                                            :options="angleSelectOptions"
                                            class="ecf-select-inline"
                                            data-test="track-angle"
                                            :data-track-index="row.track.index"
                                            :aria-label="`Angle of track ${row.track.index}`"
                                            @update:model-value="setTrackAngle(row.track.index, $event as number | 'new')"
                                        />
                                    </td>
                                    <td class="ecf-td">
                                        <!-- An angle is named once, on its first row; the
                                             name is kept on the track the angle is keyed by. -->
                                        <input
                                            v-if="!choosableVideo || row.first"
                                            :value="(choosableVideo ? row.idTrack : row.track).name ?? ''"
                                            type="text"
                                            class="ecf-input ecf-input-sm"
                                            :placeholder="
                                                choosableVideo
                                                    ? angleNameById.get(row.angle.id)
                                                    : 'e.g. Main angle'
                                            "
                                            data-track-field="video-name"
                                            :data-track-index="(choosableVideo ? row.idTrack : row.track).index"
                                            :data-row="rowIdx"
                                            data-col="0"
                                            @input="(choosableVideo ? row.idTrack : row.track).name = ($event.target as HTMLInputElement).value"
                                            @keydown="onTrackInputKeydown"
                                        />
                                        <span v-else class="ecf-cell-dim">
                                            same picture as #{{ row.angle.members[0].index }}
                                        </span>
                                    </td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                </div>
                <div v-if="editableAudioTracks.length > 0">
                    <p class="ecf-detect-sub">Audio tracks</p>
                    <p v-if="choosableAudio" class="ecf-hint" data-test="include-hint-audio">
                        Untick a track to leave it out of the encode. The others keep their settings.
                    </p>
                    <div class="ecf-table-wrap">
                        <table class="ecf-table">
                            <thead class="ecf-thead">
                                <tr>
                                    <th v-if="choosableAudio" class="ecf-th ecf-th-include">
                                        Include
                                    </th>
                                    <th class="ecf-th">#</th>
                                    <th class="ecf-th">Codec</th>
                                    <th class="ecf-th">Bitrate</th>
                                    <th class="ecf-th">Channels</th>
                                    <th class="ecf-th">Sample Rate</th>
                                    <th class="ecf-th">Language</th>
                                    <th class="ecf-th">Name</th>
                                </tr>
                            </thead>
                            <tbody class="ecf-tbody">
                                <tr
                                    v-for="(t, audioIdx) in editableAudioTracks"
                                    :key="t.index"
                                    class="ecf-tr"
                                    :class="{ 'ecf-tr--excluded': excludedAudio.has(t.index) }"
                                >
                                    <td v-if="choosableAudio" class="ecf-td ecf-td-include">
                                        <input
                                            type="checkbox"
                                            class="ecf-checkbox"
                                            data-test="track-include"
                                            data-kind="audio"
                                            :data-track-index="t.index"
                                            :checked="!excludedAudio.has(t.index)"
                                            :disabled="!canExclude('audio', t.index)"
                                            :title="includeTitle('audio', t.index)"
                                            :aria-label="`Include audio track ${t.index}`"
                                            @change="setTrackIncluded('audio', t.index, ($event.target as HTMLInputElement).checked)"
                                        />
                                    </td>
                                    <td class="ecf-td">{{ t.index }}</td>
                                    <td class="ecf-td">{{ t.codec }}</td>
                                    <td class="ecf-td">
                                        {{
                                            t.bitrateKbps
                                                ? `${t.bitrateKbps} kbps`
                                                : '—'
                                        }}
                                    </td>
                                    <td class="ecf-td">
                                        {{ channelLabel(t.channels) }}
                                    </td>
                                    <td class="ecf-td">
                                        {{ t.sampleRate }} Hz
                                    </td>
                                    <td class="ecf-td">
                                        <LanguageSelect
                                            v-model="t.language"
                                            placeholder="und"
                                            aria-label="Track language"
                                            data-track-field="audio-language"
                                            :data-track-index="t.index"
                                            :data-row="
                                                editableVideoTracks.length +
                                                audioIdx
                                            "
                                            data-col="0"
                                            @keydown="onTrackInputKeydown"
                                        />
                                    </td>
                                    <td class="ecf-td">
                                        <input
                                            v-model="t.name"
                                            type="text"
                                            class="ecf-input ecf-input-sm"
                                            placeholder="e.g. Commentary"
                                            data-track-field="audio-name"
                                            :data-track-index="t.index"
                                            :data-row="
                                                editableVideoTracks.length +
                                                audioIdx
                                            "
                                            data-col="1"
                                            @keydown="onTrackInputKeydown"
                                        />
                                    </td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                </div>
                <div
                    v-if="
                        encodingType.value === 'video' &&
                        (editableVideoTracks.length > 0 ||
                            editableAudioTracks.length > 0)
                    "
                >
                    <button
                        type="button"
                        class="ecf-btn-accent"
                        @click="reanalyze"
                    >
                        Re-analyze Mapping
                    </button>
                </div>
            </fieldset>
        </details>

        <!-- ③ Encoding ladder -->
        <div class="ecf-ladder-stack">
            <!-- Video Renditions (video mode only) -->
            <details
                v-if="encodingType.value === 'video'"
                class="ecf-panel"
                open
            >
                <summary class="ecf-panel-summary">
                    <svg
                        class="ecf-panel-chevron"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        stroke-width="2"
                        aria-hidden="true"
                    >
                        <path
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            d="M19 9l-7 7-7-7"
                        />
                    </svg>
                    <span class="ecf-detect-title">Video Renditions</span>
                    <span class="ecf-detect-meta"
                        >{{ videoRenditions.length }} variant{{
                            videoRenditions.length === 1 ? '' : 's'
                        }}</span
                    >
                </summary>
                <div class="ecf-panel-body">
                    <p class="ecf-box-hint">One row per HLS variant stream</p>
                    <div class="ecf-form-row" data-test="ladder-mode">
                        <div class="ecf-form-field">
                            <span class="ecf-field-label">Ladder</span>
                            <div
                                class="ecf-seg"
                                role="radiogroup"
                                aria-label="How the video ladder is made"
                            >
                                <button
                                    type="button"
                                    role="radio"
                                    data-test="ladder-mode-copy"
                                    :aria-checked="shownLadderMode === 'copy'"
                                    :class="[
                                        'ecf-seg-btn',
                                        shownLadderMode === 'copy' && 'ecf-seg-btn--on',
                                    ]"
                                    :disabled="copyLadderBlockedReason != null"
                                    :title="
                                        copyLadderBlockedReason ??
                                        'Copy every track as it is — the source\'s own ladder, no re-encoding'
                                    "
                                    @click="setLadderMode('copy')"
                                >
                                    {{ multiTrack ? 'Copy source ladder' : 'Copy source' }}
                                </button>
                                <button
                                    type="button"
                                    role="radio"
                                    data-test="ladder-mode-reencode"
                                    :aria-checked="shownLadderMode === 'reencode'"
                                    :class="[
                                        'ecf-seg-btn',
                                        shownLadderMode === 'reencode' &&
                                            'ecf-seg-btn--on',
                                    ]"
                                    title="Encode a full ladder per angle, every rendition made from the angle's best track, and the audio from each language's best track"
                                    @click="setLadderMode('reencode')"
                                >
                                    {{ multiTrack ? 'Re-encode from best track' : 'Re-encode a ladder' }}
                                </button>
                            </div>
                        </div>
                    </div>
                    <p
                        v-if="ladderModeNotice"
                        class="ecf-box-hint ecf-box-hint--warn"
                        data-test="ladder-mode-notice"
                    >
                        {{ ladderModeNotice }}
                    </p>
                    <p
                        v-else-if="copyLadderBlockedReason && editableVideoTracks.length > 1"
                        class="ecf-box-hint"
                        data-test="ladder-copy-blocked"
                    >
                        Copy is unavailable — {{ copyLadderBlockedReason }}
                    </p>
                    <div v-if="showLadderMax" class="ecf-form-row">
                        <div class="ecf-form-field">
                            <span class="ecf-field-label">Content</span>
                            <SelectMenu
                                v-model="contentPreset.value"
                                :options="contentPresetOptions"
                                class="ecf-select-inline"
                                aria-label="Content"
                                @change="onContentPresetChange"
                            />
                        </div>
                        <div
                            v-if="contentPreset.value === 'custom'"
                            class="ecf-form-field"
                        >
                            <label
                                class="ecf-field-label"
                                for="ecf-content-factor"
                                >Factor</label
                            >
                            <input
                                id="ecf-content-factor"
                                v-model.number="customFactor.value"
                                type="number"
                                min="0.1"
                                max="2"
                                step="0.05"
                                class="ecf-input ecf-input-kbps"
                                @change="onContentPresetChange"
                            />
                        </div>
                        <div class="ecf-form-field">
                            <label class="ecf-field-label" for="ecf-ladder-max"
                                >Ladder max (kbps)</label
                            >
                            <input
                                id="ecf-ladder-max"
                                v-model.number="ladderMax.value"
                                type="number"
                                min="1"
                                step="100"
                                class="ecf-input ecf-input-kbps"
                                @change="applyLadder"
                            />
                        </div>
                        <div v-if="showLadderMin" class="ecf-form-field">
                            <label class="ecf-field-label" for="ecf-ladder-min"
                                >Ladder min (kbps)</label
                            >
                            <input
                                id="ecf-ladder-min"
                                v-model.number="ladderMin.value"
                                type="number"
                                min="1"
                                step="10"
                                class="ecf-input ecf-input-kbps"
                                :placeholder="String(autoLadderMin)"
                                @change="applyLadderMin"
                            />
                        </div>
                        <button
                            type="button"
                            class="ecf-btn-sm"
                            @click="resetLadder"
                        >
                            Reset to suggested
                        </button>
                        <span v-if="ladderSourceSummary" class="ecf-box-hint">{{
                            ladderSourceSummary
                        }}</span>
                    </div>
                    <p v-if="showLadderMax" class="ecf-box-hint">
                        Content and the ladder max/min re-derive the ladder from
                        the suggestion — leave min empty to keep the suggested
                        shape; copied streams keep the source's own bitrate.
                    </p>
                    <div class="ecf-table-wrap">
                        <table class="ecf-lt">
                            <thead class="ecf-lt-thead">
                                <tr>
                                    <th
                                        v-if="showVideoRenditionSourceColumn"
                                        class="ecf-lt-th"
                                    >
                                        Source track
                                    </th>
                                    <th class="ecf-lt-th">Resolution</th>
                                    <th class="ecf-lt-th ecf-lt-th--r">kbps</th>
                                    <th class="ecf-lt-th">Audio group</th>
                                    <th class="ecf-lt-th">Label</th>
                                    <th class="ecf-lt-th">Options</th>
                                    <th class="ecf-lt-th ecf-lt-th--del"></th>
                                </tr>
                            </thead>
                            <tbody>
                                <template
                                    v-for="(r, i) in videoRenditions"
                                    :key="i"
                                >
                                    <tr class="ecf-lt-tr">
                                        <td
                                            v-if="
                                                showVideoRenditionSourceColumn
                                            "
                                            class="ecf-lt-td"
                                        >
                                            <SelectMenu
                                                v-model="r.sourceTrackIndex"
                                                :options="videoSourceOptions"
                                                class="ecf-select-src"
                                                aria-label="Source track"
                                                @change="
                                                    onCopySourceChange(r, i)
                                                "
                                            />
                                        </td>
                                        <td class="ecf-lt-td">
                                            <span
                                                v-if="r.copyStream"
                                                class="ecf-cell-dim"
                                                >auto</span
                                            >
                                            <span v-else class="ecf-res-pair">
                                                <input
                                                    v-model.number="r.width"
                                                    type="number"
                                                    min="1"
                                                    class="ecf-input ecf-input-res"
                                                    title="Width px"
                                                />
                                                <span class="ecf-res-x">×</span>
                                                <input
                                                    v-model.number="r.height"
                                                    type="number"
                                                    min="1"
                                                    class="ecf-input ecf-input-res"
                                                    title="Height px"
                                                />
                                            </span>
                                        </td>
                                        <td class="ecf-lt-td ecf-lt-td--r">
                                            <input
                                                v-model.number="
                                                    r.videoBitrateKbps
                                                "
                                                type="number"
                                                min="1"
                                                class="ecf-input ecf-input-kbps"
                                                :disabled="r.copyStream"
                                            />
                                        </td>
                                        <td class="ecf-lt-td">
                                            <SelectMenu
                                                v-model="r.audioGroupId"
                                                :options="
                                                    audioGroupSelectOptions
                                                "
                                                class="ecf-select-inline"
                                                aria-label="Audio group"
                                            />
                                        </td>
                                        <td class="ecf-lt-td">
                                            <input
                                                v-model="r.label"
                                                type="text"
                                                class="ecf-input ecf-input-lbl"
                                                placeholder="Main"
                                            />
                                        </td>
                                        <td class="ecf-lt-td ecf-lt-td--opts">
                                            <label class="ecf-toggle">
                                                <input
                                                    type="checkbox"
                                                    v-model="r.vbr"
                                                    class="ecf-checkbox"
                                                    :disabled="r.copyStream"
                                                    @change="
                                                        r.vbr &&
                                                        (r.copyStream = false)
                                                    "
                                                />
                                                VBR
                                            </label>
                                            <label
                                                class="ecf-toggle"
                                                :title="
                                                    copyBlockedReason(r) ??
                                                    undefined
                                                "
                                            >
                                                <input
                                                    type="checkbox"
                                                    v-model="r.copyStream"
                                                    class="ecf-checkbox"
                                                    :disabled="
                                                        editableVideoTracks.length ===
                                                            0 ||
                                                        copyBlockedReason(r) !=
                                                            null
                                                    "
                                                    @change="onCopyToggle(r, i)"
                                                />
                                                Copy
                                            </label>
                                        </td>
                                        <td class="ecf-lt-td ecf-lt-td--del">
                                            <button
                                                v-if="
                                                    videoRenditions.length > 1
                                                "
                                                type="button"
                                                class="ecf-btn-remove"
                                                @click="removeVideoRendition(i)"
                                                title="Remove rendition"
                                            >
                                                <svg
                                                    class="ecf-icon"
                                                    fill="none"
                                                    viewBox="0 0 24 24"
                                                    stroke="currentColor"
                                                    stroke-width="2"
                                                >
                                                    <path
                                                        stroke-linecap="round"
                                                        stroke-linejoin="round"
                                                        d="M6 18L18 6M6 6l12 12"
                                                    />
                                                </svg>
                                            </button>
                                        </td>
                                    </tr>
                                    <tr
                                        v-if="overCapKbps(r) != null"
                                        class="ecf-lt-warning"
                                    >
                                        <td
                                            :colspan="
                                                showVideoRenditionSourceColumn
                                                    ? 7
                                                    : 6
                                            "
                                            class="ecf-lt-warning-td"
                                        >
                                            <svg
                                                class="ecf-icon"
                                                fill="none"
                                                viewBox="0 0 24 24"
                                                stroke="currentColor"
                                                stroke-width="2"
                                                aria-hidden="true"
                                            >
                                                <path
                                                    stroke-linecap="round"
                                                    stroke-linejoin="round"
                                                    d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z"
                                                />
                                            </svg>
                                            Above what the source carries at
                                            this size ({{ overCapKbps(r) }}
                                            kbps)
                                        </td>
                                    </tr>
                                </template>
                            </tbody>
                            <tfoot class="ecf-lt-foot">
                                <tr>
                                    <td
                                        :colspan="
                                            showVideoRenditionSourceColumn
                                                ? 7
                                                : 6
                                        "
                                        class="ecf-lt-add-td"
                                    >
                                        <button
                                            type="button"
                                            class="ecf-btn-add"
                                            @click="addVideoRendition"
                                        >
                                            + Add rendition
                                        </button>
                                    </td>
                                </tr>
                            </tfoot>
                        </table>
                    </div>
                </div>
            </details>

            <!-- Audio Groups (video AND audio-only mode) -->
            <details class="ecf-panel" open>
                <summary class="ecf-panel-summary">
                    <svg
                        class="ecf-panel-chevron"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        stroke-width="2"
                        aria-hidden="true"
                    >
                        <path
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            d="M19 9l-7 7-7-7"
                        />
                    </svg>
                    <span class="ecf-detect-title">Audio Groups</span>
                    <span class="ecf-detect-meta"
                        >{{ audioGroups.length }} group{{
                            audioGroups.length === 1 ? '' : 's'
                        }}</span
                    >
                </summary>
                <div class="ecf-panel-body">
                    <p class="ecf-box-hint">
                        {{
                            encodingType.value === 'video'
                                ? 'Tiers referenced by video renditions'
                                : 'Audio-only HLS variants'
                        }}
                    </p>
                    <div class="ecf-table-wrap">
                        <table class="ecf-lt">
                            <thead class="ecf-lt-thead">
                                <tr>
                                    <th class="ecf-lt-th">ID</th>
                                    <th class="ecf-lt-th">Label</th>
                                    <th class="ecf-lt-th ecf-lt-th--r">kbps</th>
                                    <th class="ecf-lt-th">Channels</th>
                                    <th class="ecf-lt-th">Source track</th>
                                    <th class="ecf-lt-th">Lang</th>
                                    <th class="ecf-lt-th">Options</th>
                                    <th class="ecf-lt-th ecf-lt-th--del"></th>
                                </tr>
                            </thead>
                            <tbody>
                                <template
                                    v-for="(g, i) in audioGroups"
                                    :key="i"
                                >
                                    <tr class="ecf-lt-tr">
                                        <td class="ecf-lt-td">
                                            <input
                                                v-model="g.id"
                                                type="text"
                                                class="ecf-input ecf-input-id"
                                            />
                                        </td>
                                        <td class="ecf-lt-td">
                                            <input
                                                v-model="g.label"
                                                type="text"
                                                class="ecf-input ecf-input-lbl"
                                                placeholder="HD Audio"
                                            />
                                        </td>
                                        <td class="ecf-lt-td ecf-lt-td--r">
                                            <input
                                                v-model.number="
                                                    g.audioBitrateKbps
                                                "
                                                data-test="audio-group-bitrate"
                                                type="number"
                                                min="1"
                                                class="ecf-input ecf-input-kbps"
                                                :disabled="g.copyStream"
                                            />
                                        </td>
                                        <td class="ecf-lt-td">
                                            <SelectMenu
                                                v-model="g.channels"
                                                :options="CHANNEL_OPTIONS"
                                                class="ecf-select-ch"
                                                aria-label="Channels"
                                                :disabled="g.copyStream"
                                            />
                                        </td>
                                        <td class="ecf-lt-td">
                                            <SelectMenu
                                                v-model="g.sourceTrackIndex"
                                                :options="audioSourceOptions"
                                                class="ecf-select-src"
                                                aria-label="Source track"
                                            />
                                        </td>
                                        <td class="ecf-lt-td">
                                            <LanguageSelect
                                                v-model="g.language"
                                                placeholder="eng"
                                                aria-label="Audio group language"
                                            />
                                        </td>
                                        <td class="ecf-lt-td ecf-lt-td--opts">
                                            <label class="ecf-toggle">
                                                <input
                                                    type="checkbox"
                                                    v-model="g.vbr"
                                                    class="ecf-checkbox"
                                                    :disabled="g.copyStream"
                                                    @change="onVbrToggle(g)"
                                                />
                                                VBR
                                            </label>
                                            <label class="ecf-toggle">
                                                <input
                                                    type="checkbox"
                                                    v-model="g.copyStream"
                                                    class="ecf-checkbox"
                                                    data-test="audio-group-copy"
                                                    @change="onAudioCopyToggle(g)"
                                                />
                                                Copy
                                            </label>
                                        </td>
                                        <td class="ecf-lt-td ecf-lt-td--del">
                                            <button
                                                v-if="audioGroups.length > 1"
                                                type="button"
                                                class="ecf-btn-remove"
                                                @click="removeAudioGroup(i)"
                                                title="Remove audio group"
                                            >
                                                <svg
                                                    class="ecf-icon"
                                                    fill="none"
                                                    viewBox="0 0 24 24"
                                                    stroke="currentColor"
                                                    stroke-width="2"
                                                >
                                                    <path
                                                        stroke-linecap="round"
                                                        stroke-linejoin="round"
                                                        d="M6 18L18 6M6 6l12 12"
                                                    />
                                                </svg>
                                            </button>
                                        </td>
                                    </tr>
                                    <tr
                                        v-if="
                                            !g.vbr &&
                                            !g.copyStream &&
                                            g.audioBitrateKbps < 100
                                        "
                                        class="ecf-lt-warning"
                                    >
                                        <td
                                            colspan="8"
                                            class="ecf-lt-warning-td"
                                        >
                                            <svg
                                                class="ecf-icon"
                                                fill="none"
                                                viewBox="0 0 24 24"
                                                stroke="currentColor"
                                                stroke-width="2"
                                                aria-hidden="true"
                                            >
                                                <path
                                                    stroke-linecap="round"
                                                    stroke-linejoin="round"
                                                    d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z"
                                                />
                                            </svg>
                                            CBR below 100 kbps — will be encoded
                                            as mono
                                        </td>
                                    </tr>
                                </template>
                            </tbody>
                            <tfoot class="ecf-lt-foot">
                                <tr>
                                    <td colspan="8" class="ecf-lt-add-td">
                                        <button
                                            type="button"
                                            class="ecf-btn-add"
                                            @click="addAudioGroup"
                                        >
                                            + Add group
                                        </button>
                                    </td>
                                </tr>
                            </tfoot>
                        </table>
                    </div>
                </div>
            </details>
        </div>

        <!-- ④ Action bar (hidden in session layout — header carries the CTA) -->
        <div v-if="appearance !== 'session'" class="ecf-actions">
            <button
                type="button"
                class="ecf-btn-secondary"
                @click="emit('back')"
            >
                <svg
                    class="ecf-icon"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    stroke-width="2"
                    aria-hidden="true"
                >
                    <path
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        d="M15.75 19.5L8.25 12l7.5-7.5"
                    />
                </svg>
                Back to workflow
            </button>
            <button
                type="button"
                @click="
                    encodePrimaryAction === 'next-to-trim'
                        ? onNextToTrim()
                        : onSubmit()
                "
                :disabled="!canSubmit"
                :class="[
                    'ecf-btn-primary',
                    !canSubmit && 'ecf-btn-primary-disabled',
                ]"
            >
                {{
                    encodePrimaryAction === 'next-to-trim'
                        ? 'Next: trim segments'
                        : 'Start Encoding'
                }}
            </button>
        </div>
    </div>
</template>
