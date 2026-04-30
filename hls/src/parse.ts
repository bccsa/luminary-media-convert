export interface HlsVariant {
    bandwidth: number;
    resolution?: string;
    codecs?: string;
    uri: string;
}

export interface HlsMedia {
    type: 'AUDIO' | 'SUBTITLES' | 'CLOSED-CAPTIONS';
    groupId: string;
    name: string;
    language?: string;
    uri?: string;
    default?: boolean;
    autoselect?: boolean;
    forced?: boolean;
}

export interface HlsParsedMaster {
    variants: HlsVariant[];
    /** All #EXT-X-MEDIA entries (audio, subtitles, closed-captions). */
    media: HlsMedia[];
    /** Audio-only subset for convenience — equivalent to media.filter(m => m.type === 'AUDIO'). */
    audioGroups: HlsMedia[];
}

export function parseMasterPlaylist(content: string): HlsParsedMaster {
    const lines = content.split('\n').map((l) => l.trim());
    const variants: HlsVariant[] = [];
    const media: HlsMedia[] = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        if (line.startsWith('#EXT-X-STREAM-INF:')) {
            const attrs = line.substring('#EXT-X-STREAM-INF:'.length);
            const bandwidth = extractAttribute(attrs, 'BANDWIDTH');
            const resolution = extractAttribute(attrs, 'RESOLUTION');
            const codecs = extractQuotedAttribute(attrs, 'CODECS');

            // The URI is the next non-empty, non-comment line
            let uri = '';
            for (let j = i + 1; j < lines.length; j++) {
                if (lines[j] && !lines[j].startsWith('#')) {
                    uri = lines[j];
                    break;
                }
            }

            if (bandwidth && uri) {
                variants.push({
                    bandwidth: parseInt(bandwidth, 10),
                    ...(resolution ? { resolution } : {}),
                    ...(codecs ? { codecs } : {}),
                    uri,
                });
            }
        }

        if (line.startsWith('#EXT-X-MEDIA:')) {
            const attrs = line.substring('#EXT-X-MEDIA:'.length);
            const type = extractAttribute(attrs, 'TYPE');
            if (type !== 'AUDIO' && type !== 'SUBTITLES' && type !== 'CLOSED-CAPTIONS') continue;

            const groupId = extractQuotedAttribute(attrs, 'GROUP-ID') ?? '';
            const name = extractQuotedAttribute(attrs, 'NAME') ?? '';
            const language = extractQuotedAttribute(attrs, 'LANGUAGE');
            const uri = extractQuotedAttribute(attrs, 'URI');
            const defaultFlag = extractAttribute(attrs, 'DEFAULT') === 'YES';
            const autoselect = extractAttribute(attrs, 'AUTOSELECT') === 'YES';
            const forced = extractAttribute(attrs, 'FORCED') === 'YES';

            media.push({
                type: type as HlsMedia['type'],
                groupId,
                name,
                ...(language ? { language } : {}),
                ...(uri ? { uri } : {}),
                ...(defaultFlag ? { default: true } : {}),
                ...(autoselect ? { autoselect: true } : {}),
                ...(forced ? { forced: true } : {}),
            });
        }
    }

    const audioGroups = media.filter((m) => m.type === 'AUDIO');
    return { variants, media, audioGroups };
}

function extractAttribute(attrs: string, name: string): string | undefined {
    // Match unquoted attribute value: NAME=VALUE (not starting with ")
    const regex = new RegExp(`(?:^|,)\\s*${name}=([^",]+)`);
    const match = attrs.match(regex);
    return match ? match[1].trim() : undefined;
}

function extractQuotedAttribute(attrs: string, name: string): string | undefined {
    const regex = new RegExp(`(?:^|,)\\s*${name}="([^"]*)"`);
    const match = attrs.match(regex);
    return match ? match[1] : undefined;
}
