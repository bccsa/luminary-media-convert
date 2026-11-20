import { describe, expect, it } from 'vitest';
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { EncodeConfigDto } from './encode-config.dto.js';

/** The pipe the API runs every body through: unknown fields are refused. */
const pipe = new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
    transformOptions: { enableImplicitConversion: true },
});

const validate = (body: unknown) =>
    pipe.transform(body, { type: 'body', metatype: EncodeConfigDto });

const config = (extra: Record<string, unknown> = {}) => ({
    type: 'video',
    videoRenditions: [
        {
            width: 640,
            height: 360,
            videoBitrateKbps: 700,
            copyStream: false,
            sourceTrackIndex: 0,
            angle: 0,
            audioGroupId: 'mid',
        },
    ],
    ...extra,
});

describe('EncodeConfigDto videoTrackAngles', () => {
    it("keeps every track's angle, so a restore can put rowless tracks back", async () => {
        const angles = [
            { index: 0, angle: 0 },
            { index: 1, angle: 2 },
        ];
        const dto = await validate(config({ videoTrackAngles: angles }));
        expect(dto.videoTrackAngles).toEqual(angles);
    });

    it('refuses an angle that is not a track index', async () => {
        await expect(
            validate(config({ videoTrackAngles: [{ index: 1, angle: -1 }] }))
        ).rejects.toThrow(BadRequestException);
    });
});
