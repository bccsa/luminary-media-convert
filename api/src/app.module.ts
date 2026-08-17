import { Module, type DynamicModule } from '@nestjs/common';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { ScheduleModule } from '@nestjs/schedule';
import { APP_GUARD } from '@nestjs/core';
import { EncodeModule } from './encode/encode.module.js';
import { AuthModule } from './auth/auth.module.js';
import { CmsModule } from './cms/cms.module.js';
import { HlsEditModule } from './hls-edit/hls-edit.module.js';
import {
    RuntimeOptionsModule,
    type RuntimeOptions,
} from './runtime-options.module.js';

@Module({
    imports: [
        ScheduleModule.forRoot(),
        AuthModule,
        // Registered here as well so the bootstrap can resolve the origin
        // registry for the CORS layer without reaching through a feature module.
        CmsModule,
        EncodeModule,
        HlsEditModule,
        ThrottlerModule.forRoot({
            throttlers: [
                { name: 'short', ttl: 1000, limit: 100 },
                { name: 'medium', ttl: 60000, limit: 1000 },
            ],
        }),
    ],
    providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {
    /**
     * The root module, told what the process around it decided.
     *
     * Always go through this rather than importing `AppModule` directly: the
     * host's answers arrive as a single global module, and a bare import
     * registers none of them, leaving the injected tokens unbound. Called with
     * no argument it is the standalone configuration, read from the
     * environment.
     */
    static forRoot(options: RuntimeOptions = {}): DynamicModule {
        return {
            module: AppModule,
            imports: [RuntimeOptionsModule.forRoot(options)],
        };
    }
}
