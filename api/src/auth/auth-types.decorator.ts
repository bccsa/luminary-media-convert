import { SetMetadata } from '@nestjs/common';

export type AuthType = 'jwt' | 'apikey' | 'session';
export const AUTH_TYPES_KEY = 'authTypes';
export const AuthTypes = (...types: AuthType[]) => SetMetadata(AUTH_TYPES_KEY, types);
