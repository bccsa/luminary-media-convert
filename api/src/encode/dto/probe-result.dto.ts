import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Expose, Type } from 'class-transformer';

export class VideoTrackInfoDto {
    @ApiProperty({ example: 0 })
    @Expose()
    index: number;

    @ApiProperty({ example: 'h264' })
    @Expose()
    codec: string;

    @ApiProperty({ example: 1920 })
    @Expose()
    width: number;

    @ApiProperty({ example: 1080 })
    @Expose()
    height: number;

    @ApiProperty({ example: 5000 })
    @Expose()
    bitrateKbps: number;

    @ApiProperty({ example: 29.97 })
    @Expose()
    frameRate: number;

    @ApiPropertyOptional({ example: 'High' })
    @Expose()
    profile?: string;

    @ApiPropertyOptional({ example: 'eng' })
    @Expose()
    language?: string;

    @ApiPropertyOptional({ example: 'Main Video', description: 'Human-readable name (HLS NAME attribute).' })
    @Expose()
    name?: string;
}

export class AudioTrackInfoDto {
    @ApiProperty({ example: 0 })
    @Expose()
    index: number;

    @ApiProperty({ example: 'aac' })
    @Expose()
    codec: string;

    @ApiProperty({ example: 128 })
    @Expose()
    bitrateKbps: number;

    @ApiProperty({ example: 2 })
    @Expose()
    channels: number;

    @ApiProperty({ example: 44100 })
    @Expose()
    sampleRate: number;

    @ApiPropertyOptional({ example: 'eng' })
    @Expose()
    language?: string;

    @ApiPropertyOptional({ example: 'English', description: 'Human-readable name (HLS NAME attribute).' })
    @Expose()
    name?: string;
}

export class FormatInfoDto {
    @ApiProperty({ example: 120.5 })
    @Expose()
    duration: number;

    @ApiProperty({ example: 5500 })
    @Expose()
    bitrateKbps: number;

    @ApiProperty({ example: 'mov,mp4,m4a,3gp,3g2,mj2' })
    @Expose()
    formatName: string;
}

export class ProbeResultDto {
    @ApiProperty({ type: FormatInfoDto })
    @Type(() => FormatInfoDto)
    @Expose()
    format: FormatInfoDto;

    @ApiProperty({ type: [VideoTrackInfoDto] })
    @Type(() => VideoTrackInfoDto)
    @Expose()
    videoTracks: VideoTrackInfoDto[];

    @ApiProperty({ type: [AudioTrackInfoDto] })
    @Type(() => AudioTrackInfoDto)
    @Expose()
    audioTracks: AudioTrackInfoDto[];
}
