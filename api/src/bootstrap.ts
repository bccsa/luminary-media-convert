import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { NextFunction, Request, Response } from 'express';
import helmet from 'helmet';
import { join } from 'path';
import { AppModule } from './app.module.js';
import type { CmsSessionHook } from './cms/cms-session-hook.js';
import { OriginRegistry, type OriginDecisions } from './cms/origin-registry.js';
import {
    createCorsOptions,
    privateNetworkAccessMiddleware,
} from './cors.config.js';
import type { CredentialCipher } from './encode/services/credential-cipher.js';
import { API_VERSION } from './version.js';

/**
 * Re-exported for the embedding host, whose file picker has to offer exactly
 * the extensions this API will accept — two lists that drifted apart would
 * show a user a file and then refuse it.
 */
export { ALLOWED_EXTENSIONS } from './encode/services/media-extensions.js';

/**
 * Re-exported for the same reason, one step further: the host has to be able to
 * tell the user that ffmpeg is missing, and it must reach that verdict the way
 * the API does. Two separate checks would eventually disagree — and the one the
 * user sees is the host's, while the one that refuses their encode is the API's.
 *
 * Call it *after* `createServer`, or at least after setting `FFMPEG_PATH` /
 * `FFPROBE_PATH`: the paths are read per call, so probing earlier asks about
 * whatever is on PATH instead of the binaries the host is about to supply.
 */
/** The version to tell a user to install; see the constant for how it was established. */
export { MIN_FFMPEG_VERSION } from './encode/services/ffmpeg-capabilities.js';

export {
    checkFfmpeg,
    probeFfmpegBinaries,
    missingBinariesMessage,
    FFMPEG_DOWNLOAD_URL,
    type FfmpegAvailability,
    type FfmpegCheck,
} from './encode/services/ffmpeg-availability.js';

/** Where the app listens when nobody says otherwise. */
export const DEFAULT_PORT = 31711;

/**
 * Loopback only, always. Nothing here is meant to be reachable from the
 * network the machine is on, and a bind address is the one control that says
 * so unconditionally — CORS and tokens are answers to questions a remote
 * caller only gets to ask if it can open the socket.
 */
export const DEFAULT_HOST = '127.0.0.1';

export interface CreateServerOptions {
    /** TCP port to listen on. Default {@link DEFAULT_PORT}. */
    port?: number;
    /** Interface to bind. Default {@link DEFAULT_HOST}. */
    host?: string;
    /** Scratch directory for uploads, encodes and caches. */
    workDir?: string;
    /** The single token accepted on `X-API-Key`. */
    localApiToken?: string;
    /** Origins trusted without asking. */
    cmsAllowedOrigins?: string[];
    /** Origins the user has already refused; they are not asked about again. */
    cmsDeniedOrigins?: string[];
    /** Asked about origins that are not on the list; resolving true grants trust. */
    originApprover?: (origin: string) => Promise<boolean>;
    /**
     * Notified whenever a trust decision changes — granted, refused or revoked
     * — so the host can write it somewhere that outlives the process.
     */
    onOriginDecisionsChanged?: (decisions: OriginDecisions) => void;
    /** Somewhere safe to keep S3 credentials across a restart. */
    credentialCipher?: CredentialCipher;
    /** Notified when a CMS opens a session, so a host can surface its window. */
    onCmsSessionCreated?: CmsSessionHook;
    /** Absolute path to the ffmpeg executable. Default: found on PATH. */
    ffmpegPath?: string;
    /** Absolute path to the ffprobe executable. Default: found on PATH. */
    ffprobePath?: string;
    /** Directory of the built web client, served at `/` when given. */
    staticAppDir?: string;
    /** Publish OpenAPI docs at `/api/docs`. Default false. */
    enableSwagger?: boolean;
}

export interface RunningServer {
    app: INestApplication;
    port: number;
    /** Where the API — and the web client, if served — can be reached. */
    url: string;
    close(): Promise<void>;
}

/**
 * Content-Security-Policy for the API's own responses.
 *
 * Standalone the API serves nothing but JSON and an OpenAPI page, so the
 * strictest policy costs nothing. Serving the web client changes what the
 * policy governs: the app fetches playlists and segments straight from
 * whichever S3 endpoint the user configured, decrypts them in the page, and
 * hands the player `blob:` URLs. `default-src 'self'` would forbid all of it,
 * and the failure would look like broken playback rather than a policy.
 */
const buildHelmet = (servingApp: boolean) =>
    helmet({
        contentSecurityPolicy: {
            directives: {
                defaultSrc: ["'self'"],
                scriptSrc: ["'self'"],
                styleSrc: ["'self'", "'unsafe-inline'"],
                imgSrc: servingApp
                    ? ["'self'", 'data:', 'blob:', 'https:', 'http:']
                    : ["'self'", 'data:'],
                ...(servingApp
                    ? {
                          // Any S3-compatible endpoint the user configured,
                          // including a MinIO on plain http next door.
                          connectSrc: [
                              "'self'",
                              'https:',
                              'http:',
                              'blob:',
                              'data:',
                          ],
                          mediaSrc: [
                              "'self'",
                              'https:',
                              'http:',
                              'blob:',
                              'data:',
                          ],
                          workerSrc: ["'self'", 'blob:'],
                      }
                    : {}),
            },
        },
    });

/**
 * Serve the built web client from `/`, with the fallback a history-mode router
 * needs: a deep link like `/sessions/abc` is a client route, not a file.
 *
 * Registered as plain middleware rather than through a static-file module so
 * there is one less package to resolve from inside a packaged app archive.
 * Anything under `/api` is left alone and falls through to the controllers.
 */
const serveWebClient = (app: NestExpressApplication, dir: string): void => {
    app.useStaticAssets(dir, { index: false });
    app.use((req: Request, res: Response, next: NextFunction) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') return next();
        if (req.path.startsWith('/api')) return next();
        res.sendFile(join(dir, 'index.html'), (err) => {
            if (err) next();
        });
    });
};

/**
 * Start the Encoding API in this process.
 *
 * Two callers: `main.ts`, which reads everything from the environment, and the
 * desktop host, which knows the answers directly and passes them in. The
 * difference between "a service configured by its deployment" and "a library
 * embedded in an app" is entirely this argument.
 *
 * Note on `workDir` and the ffmpeg paths: those reach the services through the
 * environment rather than through injection, because that is how the services
 * already read them, and each one is a value the whole process shares anyway.
 * They are set before Nest instantiates anything, so every service sees them.
 * The token, the cipher, the origin policy and the window hook are different —
 * they are per-host objects, not strings, and they go through their injection
 * tokens.
 */
export async function createServer(
    options: CreateServerOptions = {}
): Promise<RunningServer> {
    if (options.workDir) process.env.WORK_DIR = options.workDir;
    if (options.ffmpegPath) process.env.FFMPEG_PATH = options.ffmpegPath;
    if (options.ffprobePath) process.env.FFPROBE_PATH = options.ffprobePath;

    // Left undefined when the caller said nothing about origins, which is what
    // makes the provider fall back to `CMS_ALLOWED_ORIGINS`. An object with two
    // undefined fields is still an answer, and it would be the wrong one.
    const originPolicy =
        options.cmsAllowedOrigins ||
        options.cmsDeniedOrigins ||
        options.originApprover ||
        options.onOriginDecisionsChanged
            ? {
                  allowedOrigins: options.cmsAllowedOrigins,
                  deniedOrigins: options.cmsDeniedOrigins,
                  originApprover: options.originApprover,
                  onDecisionsChanged: options.onOriginDecisionsChanged,
              }
            : undefined;

    const app = await NestFactory.create<NestExpressApplication>(
        AppModule.forRoot({
            localApiToken: options.localApiToken,
            originPolicy,
            credentialCipher: options.credentialCipher,
            onCmsSessionCreated: options.onCmsSessionCreated,
        })
    );

    app.use(buildHelmet(!!options.staticAppDir));

    app.useGlobalPipes(
        new ValidationPipe({
            transform: true,
            whitelist: true,
            forbidNonWhitelisted: true,
            transformOptions: { enableImplicitConversion: true },
        })
    );

    // Graceful shutdown: onModuleDestroy is what drains the encode queue and
    // kills any ffmpeg still running.
    app.enableShutdownHooks();

    if (options.enableSwagger) {
        const config = new DocumentBuilder()
            .setTitle('Luminary Media Convert')
            .setDescription(
                'Local HLS/ABR media encoding service. Open a session, point it at a ' +
                    'file already on this machine, and follow progress and the S3 output ' +
                    'location over SSE or by polling. Nothing is uploaded through this API.'
            )
            // The real one, so the docs and the version the CMS reads off
            // /api/cms/health cannot disagree. The hardcoded 2.0.0 outlived the
            // product it belonged to.
            .setVersion(API_VERSION)
            .addApiKey(
                {
                    type: 'apiKey',
                    in: 'header',
                    name: 'X-API-Key',
                    description:
                        'The instance API token. Minted per launch by the desktop host, or ' +
                        'read from LOCAL_API_TOKEN when the API runs standalone. Accepted on ' +
                        'every endpoint regardless of what it declares.',
                },
                'apikey'
            )
            .addBearerAuth({
                type: 'http',
                scheme: 'bearer',
                description:
                    'Session token (sess_*), returned when the session is created. Drives ' +
                    'one session and nothing else.',
            })
            .build();

        SwaggerModule.setup(
            'api/docs',
            app,
            SwaggerModule.createDocument(app, config)
        );
    }

    if (options.staticAppDir) serveWebClient(app, options.staticAppDir);

    // Order matters: the CORS middleware is what writes and ends the preflight
    // response, so the private-network grant has to be on the response before it.
    app.use(privateNetworkAccessMiddleware);
    const registry = app.get(OriginRegistry);
    app.enableCors(createCorsOptions(registry));

    const port = options.port ?? DEFAULT_PORT;
    const host = options.host ?? DEFAULT_HOST;
    await app.listen(port, host);

    // Asking the server rather than trusting the request: port 0 means "any
    // free port", and only the socket knows which one that turned out to be.
    const address = app.getHttpServer().address();
    const boundPort =
        typeof address === 'object' && address ? address.port : port;

    // This server's own address, trusted without asking.
    //
    // A page served from here is this app's own UI, and every non-GET request a
    // browser makes carries an Origin header even when it is talking to the
    // origin it came from. Without this the first thing the app does on a fresh
    // install is ask the user whether to trust itself.
    for (const name of new Set([host, '127.0.0.1', 'localhost'])) {
        registry.approve(`http://${name}:${boundPort}`);
    }

    return {
        app,
        port: boundPort,
        url: `http://${host}:${boundPort}`,
        close: () => app.close(),
    };
}
