import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';

export class CmsHealthResponseDto {
    @ApiProperty({
        description: 'Always "ok" when the local encoder is reachable.',
        example: 'ok',
    })
    @Expose()
    status: string;

    @ApiProperty({
        description: 'Version of the local encoder.',
        example: '0.0.1',
    })
    @Expose()
    apiVersion: string;
}

/**
 * What the CMS gets back after opening a session.
 *
 * Identifiers and a read-only credential — never the storage config it sent.
 * Reflecting credentials back would put a bucket's secret key into the response
 * body of a cross-origin request, readable by anything sharing that page.
 */
export class CmsSessionResponseDto {
    @ApiProperty({ description: 'Session identifier.' })
    @Expose()
    sessionId: string;

    @ApiProperty({
        description:
            'Read-only credential for the event stream and status endpoint. Cannot ' +
            'start, cancel, or read the source of the session.',
        example: 'read_f8e7d6c5b4a3291087654321',
    })
    @Expose()
    readToken: string;

    @ApiProperty({
        description:
            'Absolute URL of the session event stream, with the read token already ' +
            'attached — an EventSource cannot set headers, so the token travels in ' +
            'the query string.',
        example:
            'http://127.0.0.1:31711/api/sessions/a1b2c3d4/events?token=read_f8e7',
    })
    @Expose()
    eventsUrl: string;

    @ApiProperty({
        description: 'Version of the local encoder.',
        example: '0.0.1',
    })
    @Expose()
    apiVersion: string;

    @ApiProperty({
        description:
            'True when this is the session already open for the same documentId, ' +
            'rather than a new one. A repeat click returns the work in flight.',
        example: false,
    })
    @Expose()
    reused: boolean;
}
