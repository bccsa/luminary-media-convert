import { Injectable } from '@nestjs/common';

export interface HlsVariant {
    bandwidth: number;
    resolution?: string;
    codecs?: string;
    uri: string;
}

export interface HlsAudioGroup {
    groupId: string;
    name: string;
    language?: string;
    uri?: string;
}

export interface HlsParsedMaster {
    variants: HlsVariant[];
    audioGroups: HlsAudioGroup[];
}

@Injectable()
export class HlsParserService {
    parseMasterPlaylist(content: string): HlsParsedMaster {
        const lines = content.split('\n').map((l) => l.trim());
        const variants: HlsVariant[] = [];
        const audioGroups: HlsAudioGroup[] = [];

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];

            if (line.startsWith('#EXT-X-STREAM-INF:')) {
                const attrs = line.substring('#EXT-X-STREAM-INF:'.length);
                const bandwidth = this.extractAttribute(attrs, 'BANDWIDTH');
                const resolution = this.extractAttribute(attrs, 'RESOLUTION');
                const codecs = this.extractQuotedAttribute(attrs, 'CODECS');

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
                const type = this.extractAttribute(attrs, 'TYPE');
                if (type !== 'AUDIO') continue;

                const groupId =
                    this.extractQuotedAttribute(attrs, 'GROUP-ID') ?? '';
                const name =
                    this.extractQuotedAttribute(attrs, 'NAME') ?? '';
                const language = this.extractQuotedAttribute(
                    attrs,
                    'LANGUAGE',
                );
                const uri = this.extractQuotedAttribute(attrs, 'URI');

                audioGroups.push({
                    groupId,
                    name,
                    ...(language ? { language } : {}),
                    ...(uri ? { uri } : {}),
                });
            }
        }

        return { variants, audioGroups };
    }

    private extractAttribute(
        attrs: string,
        name: string,
    ): string | undefined {
        // Match unquoted attribute value: NAME=VALUE (not starting with ")
        const regex = new RegExp(`(?:^|,)\\s*${name}=([^",]+)`);
        const match = attrs.match(regex);
        return match ? match[1].trim() : undefined;
    }

    private extractQuotedAttribute(
        attrs: string,
        name: string,
    ): string | undefined {
        // Match quoted attribute value: NAME="VALUE"
        const regex = new RegExp(`(?:^|,)\\s*${name}="([^"]*)"`);
        const match = attrs.match(regex);
        return match ? match[1] : undefined;
    }
}
