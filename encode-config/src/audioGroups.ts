import type { AudioGroup, AudioTrackInfo } from './types';

export interface AudioGroupTier {
    minHeight: number;
    groupId: string;
    label: string;
    bitrateKbps: number;
    channels: number;
}

export const AUDIO_GROUP_TIERS: AudioGroupTier[] = [
    { minHeight: 720, groupId: 'hd', label: 'HD', bitrateKbps: 256, channels: 2 },
    { minHeight: 360, groupId: 'mid', label: 'Standard', bitrateKbps: 128, channels: 2 },
    { minHeight: 0, groupId: 'low', label: 'Bandwidth Saving', bitrateKbps: 64, channels: 2 },
];

export function getAudioTierForHeight(height: number): AudioGroupTier {
    for (const tier of AUDIO_GROUP_TIERS) {
        if (height >= tier.minHeight) return tier;
    }
    return AUDIO_GROUP_TIERS[AUDIO_GROUP_TIERS.length - 1];
}

/**
 * Suggest audio groups from the source's audio tracks.
 *
 * Two source shapes have to be told apart, because they want opposite things:
 *
 * - an **already-ABR source**, where several tracks in one language are the same
 *   audio at different bitrates. Each tier should take the matching one.
 * - **distinct content** — separate languages, commentary, described audio —
 *   where every tier must carry *all* of them, differing only in bitrate.
 *
 * Confusing the two is the bug this function had: tracks were bucketed by
 * language, then each tier indexed into its bucket by tier position. Sources
 * whose tracks carry no language metadata all land in one bucket, so the index
 * walked across unrelated tracks and a listener who changed quality changed
 * language — hd→ENG, mid→FRA, low→NYA from one real session.
 */
export function buildSuggestedAudioGroups(
    audioTracks: AudioTrackInfo[],
    videoTrackCount: number
): AudioGroup[] {
    if (audioTracks.length === 0) return [];

    const langMap = new Map<string, AudioTrackInfo[]>();
    for (const track of audioTracks) {
        const lang = track.language || 'und';
        if (!langMap.has(lang)) langMap.set(lang, []);
        langMap.get(lang)!.push(track);
    }
    for (const tracks of langMap.values()) {
        tracks.sort((a, b) => (b.bitrateKbps || 0) - (a.bitrateKbps || 0));
    }

    const languages = Array.from(langMap.keys());
    const isMultiSource =
        languages.length > 1 ||
        (languages.length === 1 && (langMap.get(languages[0])?.length ?? 0) > 1);
    const hasMultiAudioPerLang = Array.from(langMap.values()).some(
        (tracks) => tracks.length > 1
    );
    // Several video renditions *and* several tracks per language is the
    // signature of a source that already carries its own ladder.
    const isAlreadyABR = videoTrackCount > 1 && hasMultiAudioPerLang;

    const maxSourceBitrate = Math.max(
        ...audioTracks.map((t) => t.bitrateKbps || 0)
    );
    const maxSourceChannels = Math.max(...audioTracks.map((t) => t.channels || 2));
    const isMono = maxSourceChannels === 1;

    const applicableTiers = (
        maxSourceBitrate > 0
            ? AUDIO_GROUP_TIERS.filter((t) => {
                  const effective = isMono
                      ? Math.round(t.bitrateKbps / 2)
                      : t.bitrateKbps;
                  return effective <= maxSourceBitrate + 32;
              })
            : [...AUDIO_GROUP_TIERS]
    ).map((t, i) => ({
        ...t,
        bitrateKbps: isMono ? Math.round(t.bitrateKbps / 2) : t.bitrateKbps,
        channels: i === 0 ? maxSourceChannels : Math.min(2, maxSourceChannels),
    }));
    if (applicableTiers.length === 0) {
        const fallback = AUDIO_GROUP_TIERS[AUDIO_GROUP_TIERS.length - 1];
        applicableTiers.push({
            ...fallback,
            bitrateKbps: isMono
                ? Math.round(fallback.bitrateKbps / 2)
                : fallback.bitrateKbps,
            channels: Math.min(2, maxSourceChannels),
        });
    }

    const groups: AudioGroup[] = [];

    if (!isMultiSource) {
        const sourceAudio = audioTracks[0];
        for (const tier of applicableTiers) {
            groups.push({
                id: tier.groupId,
                label: tier.label,
                audioBitrateKbps: tier.bitrateKbps,
                channels: tier.channels,
                audioCodec: 'aac',
                sourceTrackIndex: sourceAudio.index,
                language: sourceAudio.language,
                vbr: true,
            });
        }
        return groups;
    }

    for (let i = 0; i < applicableTiers.length; i++) {
        const tier = applicableTiers[i];

        // Only an already-ABR source has alternate encodings to choose between;
        // anywhere else every track is its own content and belongs in every tier.
        const perTier = isAlreadyABR
            ? languages.map((lang) => {
                  const tracks = langMap.get(lang)!;
                  return tracks[Math.min(i, tracks.length - 1)];
              })
            : audioTracks;

        for (const track of perTier) {
            const lang = track.language || 'und';
            groups.push({
                id: tier.groupId,
                label: labelFor(track, lang, tier.label, perTier.length > 1),
                audioBitrateKbps: isAlreadyABR
                    ? track.bitrateKbps || tier.bitrateKbps
                    : tier.bitrateKbps,
                channels: isAlreadyABR ? track.channels : tier.channels,
                audioCodec: 'aac',
                sourceTrackIndex: track.index,
                language: lang === 'und' ? undefined : lang,
                copyStream: isAlreadyABR ? true : undefined,
                vbr: !isAlreadyABR,
            });
        }
    }

    return groups;
}

/**
 * A name a listener can pick between. Untagged tracks would otherwise all read
 * the same within a tier, leaving no way to tell three languages apart, so they
 * fall back to their source track number.
 */
function labelFor(
    track: AudioTrackInfo,
    lang: string,
    tierLabel: string,
    needsDistinguishing: boolean
): string {
    if (track.name) return track.name;
    if (lang !== 'und') return `${lang.toUpperCase()} ${tierLabel}`;
    if (needsDistinguishing) return `Track ${track.index} ${tierLabel}`;
    return tierLabel;
}
