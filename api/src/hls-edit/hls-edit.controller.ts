import {
    Body,
    Controller,
    HttpCode,
    HttpStatus,
    Logger,
    NotFoundException,
    Post,
    UseGuards,
} from '@nestjs/common';
import {
    ApiOperation,
    ApiResponse,
    ApiSecurity,
    ApiTags,
} from '@nestjs/swagger';
import { SkipAllThrottles } from '../throttle.js';
import { AuthResolverGuard } from '../auth/auth-resolver.guard.js';
import { AuthTypes } from '../auth/auth-types.decorator.js';
import {
    HlsEditService,
    type HlsDiscoverResult,
    type HlsReadResult,
} from './hls-edit.service.js';
import { MasterRevisionService } from './master-revision.service.js';
import { HlsReadRequestDto } from './dto/read.dto.js';
import { HlsDiscoverRequestDto } from './dto/discover.dto.js';
import {
    HlsChaptersReadRequestDto,
    type HlsChaptersReadResult,
} from './dto/chapters-read.dto.js';
import {
    HlsWaveformReadRequestDto,
    type HlsWaveformReadResult,
} from './dto/waveform-read.dto.js';

@ApiTags('HLS Edit')
@Controller('api/hls')
@SkipAllThrottles()
export class HlsEditController {
    private readonly logger = new Logger(HlsEditController.name);

    constructor(
        private readonly service: HlsEditService,
        private readonly masterRevisions: MasterRevisionService
    ) {}

    @Post('read')
    @HttpCode(HttpStatus.OK)
    @UseGuards(AuthResolverGuard)
    @AuthTypes('instance')
    @ApiSecurity('apikey')
    @ApiOperation({
        summary: 'Fetch and parse a master playlist',
        description:
            'Stateless — takes inline S3 credentials. Returns the parsed master and its current ETag.',
    })
    @ApiResponse({ status: 200, description: 'Parsed master and ETag.' })
    @ApiResponse({ status: 400, description: 'Invalid request.' })
    @ApiResponse({ status: 401, description: 'Unauthorized.' })
    async read(@Body() dto: HlsReadRequestDto): Promise<HlsReadResult> {
        return this.service.read(dto);
    }

    @Post('discover')
    @HttpCode(HttpStatus.OK)
    @UseGuards(AuthResolverGuard)
    @AuthTypes('instance')
    @ApiSecurity('apikey')
    @ApiOperation({
        summary: 'Discover HLS master playlists under a folder prefix',
        description:
            'Scans S3 for top-level .m3u8 files containing #EXT-X-STREAM-INF. Returns the primary master (master.m3u8 promoted when present) and angle list when multiple masters are found.',
    })
    @ApiResponse({ status: 200, description: 'Discovery result.' })
    @ApiResponse({ status: 400, description: 'No HLS master playlist found.' })
    @ApiResponse({ status: 401, description: 'Unauthorized.' })
    async discover(
        @Body() dto: HlsDiscoverRequestDto
    ): Promise<HlsDiscoverResult> {
        return this.service.discover(dto);
    }

    @Post('chapters/read')
    @HttpCode(HttpStatus.OK)
    @UseGuards(AuthResolverGuard)
    @AuthTypes('instance')
    @ApiSecurity('apikey')
    @ApiOperation({
        summary: 'Read the chapter sidecar VTT for a session prefix',
        description:
            "Stateless — takes inline S3 credentials and a folder prefix. Reads the file the folder's newest master revision names for the language, else chapters/<lang>.vtt. Returns the WebVTT body or 404 when there is none.",
    })
    @ApiResponse({ status: 200, description: 'Chapter VTT body.' })
    @ApiResponse({
        status: 400,
        description: 'Invalid request (e.g. malformed lang).',
    })
    @ApiResponse({ status: 401, description: 'Unauthorized.' })
    @ApiResponse({
        status: 404,
        description: 'No chapter file for the language under the prefix.',
    })
    async chaptersRead(
        @Body() dto: HlsChaptersReadRequestDto
    ): Promise<HlsChaptersReadResult> {
        // The folder's newest master names the current chapter file. A
        // missing master is no error: readChapters then falls back to the
        // fixed name.
        const prefix =
            !dto.folderPrefix || dto.folderPrefix.endsWith('/')
                ? dto.folderPrefix
                : `${dto.folderPrefix}/`;
        const masterKey = await this.masterRevisions.latestRevision(
            dto.s3,
            `${prefix}master.m3u8`
        );
        const result = await this.service.readChapters(
            dto.s3,
            dto.folderPrefix,
            dto.lang,
            dto.keyHex,
            { masterKey }
        );
        if (!result)
            throw new NotFoundException('No chapter file for this language');
        return result;
    }

    @Post('waveform/read')
    @HttpCode(HttpStatus.OK)
    @UseGuards(AuthResolverGuard)
    @AuthTypes('instance')
    @ApiSecurity('apikey')
    @ApiOperation({
        summary: 'Read the waveform sidecar JSON for a session prefix',
        description:
            'Stateless — takes inline S3 credentials and a folder prefix. Returns the parsed waveform.json body, or 404 when the sidecar is missing (e.g. imported sessions or sessions encoded before the sidecar landed).',
    })
    @ApiResponse({ status: 200, description: 'Waveform sidecar body.' })
    @ApiResponse({ status: 400, description: 'Invalid request.' })
    @ApiResponse({ status: 401, description: 'Unauthorized.' })
    @ApiResponse({
        status: 404,
        description: 'No waveform.json under the prefix.',
    })
    async waveformRead(
        @Body() dto: HlsWaveformReadRequestDto
    ): Promise<HlsWaveformReadResult> {
        const result = await this.service.readWaveform(
            dto.s3,
            dto.folderPrefix
        );
        if (!result)
            throw new NotFoundException('No waveform sidecar for this session');
        return result;
    }
}
