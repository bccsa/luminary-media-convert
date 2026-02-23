import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';

const UPLOAD_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

@Injectable()
export class UploadTimeoutMiddleware implements NestMiddleware {
    private readonly logger = new Logger(UploadTimeoutMiddleware.name);

    use(req: Request, res: Response, next: NextFunction): void {
        req.setTimeout(UPLOAD_TIMEOUT_MS, () => {
            this.logger.warn(
                `Upload timed out after ${UPLOAD_TIMEOUT_MS / 1000}s for ${req.url}`,
            );

            if (!res.headersSent) {
                res.status(408).json({
                    statusCode: 408,
                    message: 'Upload timed out (10 minute limit exceeded)',
                });
            }

            req.destroy();
        });

        next();
    }
}
