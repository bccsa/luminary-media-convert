import type { NestApplicationOptions } from '@nestjs/common';

/** How the encoding API's Nest application is created. */
export const SERVER_OPTIONS: NestApplicationOptions = {
    // A session page keeps its event stream open for as long as it is shown,
    // and closing waits on every open connection: without this, quitting with
    // one open stopped the encode and then never finished.
    forceCloseConnections: true,
};
