import { Global, Module, type DynamicModule } from '@nestjs/common';
import {
    LOCAL_API_TOKEN,
    createLocalApiTokenProvider,
    type LocalApiToken,
} from './auth/local-auth.config.js';
import {
    ORIGIN_POLICY,
    createOriginPolicyProvider,
    type OriginPolicy,
} from './cms/origin-registry.js';
import {
    CMS_SESSION_HOOK,
    createCmsSessionHookProvider,
    type CmsSessionHook,
} from './cms/cms-session-hook.js';
import {
    CREDENTIAL_CIPHER,
    createCredentialCipherProvider,
    type CredentialCipher,
} from './encode/services/credential-cipher.js';

/**
 * Everything the API cannot decide for itself.
 *
 * Each of these is something only the process around the API knows: the token
 * it minted for its own UI, which sites it has been told to trust, where it
 * can safely keep a secret, and how to bring a window to the front. Standalone
 * there is no such process, and every one of them falls back to an environment
 * variable or to nothing at all.
 */
export interface RuntimeOptions {
    /** Token accepted on `X-API-Key`. Falls back to the environment. */
    localApiToken?: LocalApiToken;
    /** Allowlist and trust-on-first-use approver. Falls back to `CMS_ALLOWED_ORIGINS`. */
    originPolicy?: OriginPolicy;
    /** Somewhere safe to write S3 credentials. Absent means memory-only. */
    credentialCipher?: CredentialCipher;
    /** Notified when a CMS opens a session, so the host can surface its window. */
    onCmsSessionCreated?: CmsSessionHook;
}

/**
 * The host's answers, bound to the tokens the feature modules inject.
 *
 * Global because the four consumers sit in three different modules and none of
 * them should have to be handed a dynamic module — importing this once at the
 * root is the whole of the wiring, and a module that only publishes
 * configuration is exactly the case `@Global` exists for.
 *
 * There is one registration per Nest application: `AppModule.forRoot()`. Two
 * would make which value wins a matter of ordering.
 */
@Global()
@Module({})
export class RuntimeOptionsModule {
    static forRoot(options: RuntimeOptions = {}): DynamicModule {
        return {
            module: RuntimeOptionsModule,
            providers: [
                createLocalApiTokenProvider(options.localApiToken),
                createOriginPolicyProvider(options.originPolicy),
                createCredentialCipherProvider(options.credentialCipher),
                createCmsSessionHookProvider(options.onCmsSessionCreated),
            ],
            exports: [
                LOCAL_API_TOKEN,
                ORIGIN_POLICY,
                CREDENTIAL_CIPHER,
                CMS_SESSION_HOOK,
            ],
        };
    }
}
