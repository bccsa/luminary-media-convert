import { Module } from '@nestjs/common';
import { OriginRegistry } from './origin-registry.js';

/**
 * Origin policy, kept out of the encode module so both the CMS controller and
 * the CORS layer in the bootstrap can reach the same registry instance.
 *
 * The policy itself (`ORIGIN_POLICY`) is supplied by `RuntimeOptionsModule`,
 * which is global: only the process hosting the API knows which sites this
 * machine has been told to trust, or how to ask its user about a new one.
 *
 * `OriginsController` reads this registry but is declared by `EncodeModule`:
 * Nest builds a controller's `@UseGuards` enhancers in the declaring module's
 * context, and `AuthResolverGuard` needs `SessionService`. Hosting the route
 * there keeps this module free of a cycle back into the encode graph.
 */
@Module({
    providers: [OriginRegistry],
    exports: [OriginRegistry],
})
export class CmsModule {}
