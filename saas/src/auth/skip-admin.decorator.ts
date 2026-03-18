import { SetMetadata } from '@nestjs/common';

export const SKIP_ADMIN_KEY = 'skipAdmin';
export const SkipAdmin = () => SetMetadata(SKIP_ADMIN_KEY, true);
