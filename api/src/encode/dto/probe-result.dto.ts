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

    @ApiPropertyOptional({
        example: 'Main Video',
        description: 'Human-readable name (HLS NAME attribute).',
    })
    @Expose()
    name?: string;

    @ApiPropertyOptional({
        example: 0.083,
        description:
            "Where this stream's first frame sits on the container timeline, " +
            'in seconds. Streams in one file routinely do not start together; ' +
            'the encode seeks past the head to align them, which is what ' +
            'decides whether a copy-mode rendition on this track is safe.',
    })
    @Expose()
    startTime?: number;

    @ApiPropertyOptional({
        example: 60,
        description:
            'Frames between consecutive keyframes, sampled from the head of ' +
            'the stream. Absent when the cadence could not be established.',
    })
    @Expose()
    gopFrames?: number;

    @ApiPropertyOptional({
        example: 2,
        description: 'The keyframe interval in seconds, for display.',
    })
    @Expose()
    gopSeconds?: number;

    @ApiPropertyOptional({
        example: true,
        description:
            'Every sampled keyframe interval was the same length. False means ' +
            'the source cuts keyframes where it likes, which no segment ' +
            'duration divides into — copy mode is refused for such a track.',
    })
    @Expose()
    gopRegular?: boolean;

    @ApiPropertyOptional({
        example: 2,
        description:
            "Frames the decoder must hold to reorder this stream (ffprobe's " +
            '`has_b_frames`) — a reorder depth, not a flag.',
    })
    @Expose()
    hasBFrames?: number;

    @ApiPropertyOptional({
        example: 'yuv420p',
        description: 'Chroma format and bit depth.',
    })
    @Expose()
    pixFmt?: string;

    @ApiPropertyOptional({
        example: 40,
        description:
            "Codec level in the codec's own numbering (H.264 4.0 is 40). " +
            'Negative or absent when the container does not say.',
    })
    @Expose()
    level?: number;
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

    @ApiPropertyOptional({
        example: 'English',
        description: 'Human-readable name (HLS NAME attribute).',
    })
    @Expose()
    name?: string;

    @ApiPropertyOptional({
        example: 0.021,
        description:
            "Where this stream's first sample sits on the container timeline, " +
            'in seconds. See the same field on a video track.',
    })
    @Expose()
    startTime?: number;
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
