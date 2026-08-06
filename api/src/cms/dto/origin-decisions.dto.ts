import { ApiProperty } from '@nestjs/swagger';

/** Every trust decision this instance is holding, for the settings screen. */
export class OriginDecisionsDto {
    @ApiProperty({
        description: 'Origins allowed to open sessions on this encoder.',
        example: ['https://cms.example.com'],
        type: [String],
    })
    allowed: string[];

    @ApiProperty({
        description:
            'Origins the user refused. Remembered so a site that keeps trying ' +
            'cannot raise a dialog every few seconds.',
        example: ['https://unknown.example'],
        type: [String],
    })
    denied: string[];
}
