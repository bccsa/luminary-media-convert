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

    @ApiPropertyOptional({
        example: 1024,
        description:
            'The width this picture is meant to be shown at, in square pixels. ' +
            'Equal to `width` for a square-pixel source; different when the ' +
            'track stores non-square samples, as broadcast SD does (720x576 ' +
            'at SAR 64:45 is shown 1024x576). HLS output is always encoded ' +
            'square, so this is the width the ladder is built from. Absent on ' +
            'a session restored from before the API reported it.',
    })
    @Expose()
    displayWidth?: number;

    @ApiPropertyOptional({
        example: 576,
        description:
            'The height this picture is meant to be shown at, in square ' +
            'pixels. See `displayWidth`; a source with tall samples (NTSC DV ' +
            'at SAR 8:9) corrects on this axis instead.',
    })
    @Expose()
    displayHeight?: number;

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

    @ApiPropertyOptional({
        example: 0,
        description:
            'The camera angle this track is one quality of, when the source ' +
            'carries the same picture more than once: the lowest track index in ' +
            'that angle. Absent on a track that is its own angle, and on every ' +
            'track when `anglesDetected` is not set.',
    })
    @Expose()
    pictureGroup?: number;

    @ApiPropertyOptional({
        example: 48,
        description:
            'The fewest sampled instants at which this track was seen to show ' +
            'the same picture as another member of its `pictureGroup`. Absent ' +
            'without a group.',
    })
    @Expose()
    pictureMatches?: number;

    @ApiPropertyOptional({
        example: true,
        description:
            'The comparison behind `pictureGroup` ran to the end. False when ' +
            'the time allowed cut it short, so the tracks agreed at fewer ' +
            'instants than a grouping is normally trusted on. Absent without ' +
            'a group.',
    })
    @Expose()
    pictureVerified?: boolean;

    @ApiPropertyOptional({
        example: [1],
        type: [Number],
        description:
            'Tracks this one may show the same picture as, but was kept apart ' +
            'from: they agreed at enough instants, and a disagreement was ' +
            'still waiting to be re-checked when the time allowed ran out. ' +
            'Absent when there are none.',
    })
    @Expose()
    pictureUndecided?: number[];

    @ApiPropertyOptional({
        example: 0,
        description:
            'The keyframe grid this track is cut on: the lowest index among the ' +
            'video tracks that cut keyframes at the same instants and run as ' +
            'long as it does. Tracks with the same id can be copied as rungs of ' +
            'one ladder. Absent when the keyframes were not compared.',
    })
    @Expose()
    keyframeGrid?: number;
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

    @ApiPropertyOptional({
        example: true,
        description:
            'The video tracks were compared for which show the same picture. ' +
            'Without it, a track with no `pictureGroup` was never compared, ' +
            'rather than found to be an angle of its own.',
    })
    @Expose()
    anglesDetected?: boolean;
}
