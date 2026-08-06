import {
    Controller,
    Delete,
    Get,
    HttpCode,
    HttpStatus,
    Query,
    UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { AuthResolverGuard } from '../auth/auth-resolver.guard.js';
import { AuthTypes } from '../auth/auth-types.decorator.js';
import { OriginDecisionsDto } from './dto/origin-decisions.dto.js';
import { OriginRegistry } from './origin-registry.js';

/**
 * Review and undo the trust decisions this instance is holding.
 *
 * Instance-token only, so it is the app's own UI and nothing else: a site being
 * able to read the allowlist would tell it which other sites to impersonate,
 * and being able to write it would make the dialog pointless.
 *
 * Deliberately not on the preload bridge. The renderer reaches this the same
 * way it reaches everything else — over HTTP against the local API — which
 * keeps one set of rules about what it is allowed to do.
 */
@ApiTags('Origins')
@Controller('api/origins')
export class OriginsController {
    constructor(private readonly registry: OriginRegistry) {}

    @Get()
    @UseGuards(AuthResolverGuard)
    @AuthTypes('master')
    @ApiSecurity('apikey')
    @ApiOperation({
        summary: 'List the origins this instance has allowed and blocked',
    })
    @ApiResponse({ status: 200, type: OriginDecisionsDto })
    list(): OriginDecisionsDto {
        return this.registry.decisions();
    }

    @Delete()
    @HttpCode(HttpStatus.NO_CONTENT)
    @UseGuards(AuthResolverGuard)
    @AuthTypes('master')
    @ApiSecurity('apikey')
    @ApiOperation({
        summary: 'Forget a decision about an origin',
        description:
            'Revoking an allow shuts the site out; revoking a block lets it ask ' +
            'again the next time it calls. Takes effect immediately — this ' +
            'registry is what the CORS layer consults on every request. ' +
            'Succeeds whether or not the origin was held, so a settings screen ' +
            'acting on a stale list does not have to treat that as an error.',
    })
    @ApiResponse({ status: 204, description: 'The origin is no longer held.' })
    revoke(@Query('origin') origin: string): void {
        // The origin travels as a query parameter rather than a path segment:
        // it contains slashes and a colon, and encoding it into a path is a
        // reliable source of double-decoding bugs across proxies.
        this.registry.revoke(origin ?? '');
    }
}
