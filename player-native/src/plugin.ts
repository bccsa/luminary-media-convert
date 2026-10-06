import { registerPlugin } from '@capacitor/core';
import type { LuminaryPlayerPlugin } from './bridge.js';

/** The native plugin. Hosts reach it through `createNativePlayer`, never directly. */
export const LuminaryPlayer = registerPlugin<LuminaryPlayerPlugin>('LuminaryPlayer');
