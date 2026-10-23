/**
 * Video.js 10's elements are custom elements, so a Vue compiler that builds this package's source must
 * leave them alone. Consumers add it to `isCustomElement`.
 */
export const isVideoJsElement = (tag: string): boolean =>
    tag === 'video-player' || tag === 'video-skin' || tag === 'hlsjs-video' || tag.startsWith('media-');
