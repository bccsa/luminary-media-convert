import { Injectable } from '@nestjs/common';
import {
    parseMasterPlaylist,
    type HlsVariant,
    type HlsMedia,
} from '@luminary-media-converter/hls';

export type { HlsVariant };

/** Legacy audio-group alias kept for backwards compatibility with existing call sites. */
export type HlsAudioGroup = Pick<HlsMedia, 'groupId' | 'name' | 'language' | 'uri'>;

export interface HlsParsedMaster {
    variants: HlsVariant[];
    audioGroups: HlsAudioGroup[];
}

@Injectable()
export class HlsParserService {
    parseMasterPlaylist(content: string): HlsParsedMaster {
        const { variants, audioGroups } = parseMasterPlaylist(content);
        return {
            variants,
            audioGroups: audioGroups.map((a) => ({
                groupId: a.groupId,
                name: a.name,
                ...(a.language ? { language: a.language } : {}),
                ...(a.uri ? { uri: a.uri } : {}),
            })),
        };
    }
}
