import {
    CallHandler,
    ExecutionContext,
    Injectable,
    Logger,
    NestInterceptor,
} from '@nestjs/common';
import type { Request } from 'express';
import { existsSync, readdirSync, rmSync, unlinkSync } from 'fs';
import { dirname } from 'path';
import { Observable, catchError, tap, throwError } from 'rxjs';

/**
 * Wraps the upload pipeline (including FileInterceptor) and ensures
 * partially-written files are removed when an error occurs or the
 * client disconnects mid-upload.
 *
 * Must be listed BEFORE FileInterceptor in @UseInterceptors() so it
 * acts as the outer interceptor and can catch Multer errors.
 */
@Injectable()
export class UploadCleanupInterceptor implements NestInterceptor {
    private readonly logger = new Logger(UploadCleanupInterceptor.name);

    intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
        const req = context.switchToHttp().getRequest<Request>();
        let cleaned = false;

        const cleanup = () => {
            if (cleaned) return;
            cleaned = true;

            const filePath = (req as any).file?.path as string | undefined;
            if (!filePath) return;

            try {
                if (existsSync(filePath)) {
                    unlinkSync(filePath);
                    this.logger.warn(`Cleaned up uploaded file: ${filePath}`);
                }

                const dir = dirname(filePath);
                if (existsSync(dir) && readdirSync(dir).length === 0) {
                    rmSync(dir, { recursive: true, force: true });
                    this.logger.debug(`Removed empty session directory: ${dir}`);
                }
            } catch (err) {
                this.logger.warn(
                    `Cleanup failed for ${filePath}: ${(err as Error).message}`,
                );
            }
        };

        req.on('close', () => {
            if (!req.complete) {
                cleanup();
            }
        });

        return next.handle().pipe(
            catchError((err) => {
                cleanup();
                return throwError(() => err);
            }),
            tap({ error: () => cleanup() }),
        );
    }
}
