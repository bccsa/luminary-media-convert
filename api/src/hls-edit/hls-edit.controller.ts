import { Body, Controller, HttpCode, HttpStatus, Logger, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { AuthResolverGuard } from '../auth/auth-resolver.guard.js';
import { AuthTypes } from '../auth/auth-types.decorator.js';
import { HlsEditService, type HlsDiscoverResult, type HlsMutateResult, type HlsReadResult } from './hls-edit.service.js';
import { HlsReadRequestDto } from './dto/read.dto.js';
import { HlsMutateRequestDto } from './dto/mutate.dto.js';
import { HlsDiscoverRequestDto } from './dto/discover.dto.js';

@ApiTags('HLS Edit')
@Controller('api/hls')
@SkipThrottle()
export class HlsEditController {
    private readonly logger = new Logger(HlsEditController.name);

    constructor(private readonly service: HlsEditService) {}

    @Post('read')
    @HttpCode(HttpStatus.OK)
    @UseGuards(AuthResolverGuard)
    @AuthTypes('master', 'apikey')
    @ApiSecurity('apikey')
    @ApiOperation({
        summary: 'Fetch and parse a master playlist',
        description: 'Stateless — takes inline S3 credentials. Returns parsed master plus the current ETag for use with /mutate.',
    })
    @ApiResponse({ status: 200, description: 'Parsed master and ETag.' })
    @ApiResponse({ status: 400, description: 'Invalid request.' })
    @ApiResponse({ status: 401, description: 'Unauthorized.' })
    async read(@Body() dto: HlsReadRequestDto): Promise<HlsReadResult> {
        return this.service.read(dto);
    }

    @Post('mutate')
    @HttpCode(HttpStatus.OK)
    @UseGuards(AuthResolverGuard)
    @AuthTypes('master', 'apikey')
    @ApiSecurity('apikey')
    @ApiOperation({
        summary: 'Apply mutations to a master playlist',
        description: 'Applies ordered operations and rewrites master.m3u8 with If-Match. Returns the new ETag.',
    })
    @ApiResponse({ status: 200, description: 'Mutation applied.' })
    @ApiResponse({ status: 400, description: 'Invalid request or unknown operation.' })
    @ApiResponse({ status: 401, description: 'Unauthorized.' })
    @ApiResponse({ status: 409, description: 'ETag mismatch — master.m3u8 was modified since read.' })
    @ApiResponse({ status: 501, description: 'Operation type recognised but not yet implemented.' })
    async mutate(@Body() dto: HlsMutateRequestDto): Promise<HlsMutateResult> {
        return this.service.mutate(dto);
    }

    @Post('discover')
    @HttpCode(HttpStatus.OK)
    @UseGuards(AuthResolverGuard)
    @AuthTypes('master', 'apikey')
    @ApiSecurity('apikey')
    @ApiOperation({
        summary: 'Discover HLS master playlists under a folder prefix',
        description: 'Scans S3 for top-level .m3u8 files containing #EXT-X-STREAM-INF. Returns the primary master (master.m3u8 promoted when present) and angle list when multiple masters are found.',
    })
    @ApiResponse({ status: 200, description: 'Discovery result.' })
    @ApiResponse({ status: 400, description: 'No HLS master playlist found.' })
    @ApiResponse({ status: 401, description: 'Unauthorized.' })
    async discover(@Body() dto: HlsDiscoverRequestDto): Promise<HlsDiscoverResult> {
        return this.service.discover(dto);
    }
}
