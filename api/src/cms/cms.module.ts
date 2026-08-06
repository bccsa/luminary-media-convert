import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { OriginRegistry } from './origin-registry.js';
import { OriginsController } from './origins.controller.js';

/**
 * Origin policy, kept out of the encode module so both the CMS controller and
 * the CORS layer in the bootstrap can reach the same registry instance.
 *
 * The policy itself (`ORIGIN_POLICY`) is supplied by `RuntimeOptionsModule`,
 * which is global: only the process hosting the API knows which sites this
 * machine has been told to trust, or how to ask its user about a new one.
 */
@Module({
    imports: [AuthModule],
    controllers: [OriginsController],
    providers: [OriginRegistry],
    exports: [OriginRegistry],
})
export class CmsModule {}
