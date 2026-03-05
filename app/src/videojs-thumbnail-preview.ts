import videojs from 'video.js';
import type Player from 'video.js/dist/types/player';

interface ThumbnailCue {
    startTime: number;
    endTime: number;
    spriteUrl: string;
    x: number;
    y: number;
    w: number;
    h: number;
}

function parseVttTime(str: string): number {
    const parts = str.trim().split(':');
    if (parts.length === 3) {
        const [h, m, rest] = parts;
        const [s, ms] = rest.split('.');
        return (
            parseInt(h, 10) * 3600 +
            parseInt(m, 10) * 60 +
            parseInt(s, 10) +
            (ms ? parseInt(ms.padEnd(3, '0'), 10) / 1000 : 0)
        );
    }
    return 0;
}

function parseVtt(text: string, baseUrl: string): ThumbnailCue[] {
    const cues: ThumbnailCue[] = [];
    const blocks = text.split(/\n\n+/);

    for (const block of blocks) {
        const lines = block.trim().split('\n');
        const timeLine = lines.find((l) => l.includes(' --> '));
        if (!timeLine) continue;

        const [startStr, endStr] = timeLine.split(' --> ');
        const startTime = parseVttTime(startStr);
        const endTime = parseVttTime(endStr);

        const payloadLine = lines[lines.indexOf(timeLine) + 1]?.trim();
        if (!payloadLine) continue;

        const [fileRef, fragment] = payloadLine.split('#');
        const spriteUrl = fileRef.startsWith('http')
            ? fileRef
            : `${baseUrl}/${fileRef}`;

        let x = 0,
            y = 0,
            w = 0,
            h = 0;
        if (fragment?.startsWith('xywh=')) {
            const vals = fragment.slice(5).split(',').map(Number);
            [x, y, w, h] = vals;
        }

        cues.push({ startTime, endTime, spriteUrl, x, y, w, h });
    }

    return cues;
}

class ThumbnailPreview {
    private player: Player;
    private cues: ThumbnailCue[] = [];
    private container: HTMLDivElement;
    private preloadedImages = new Set<string>();

    private boundMouseMove: (e: MouseEvent) => void;
    private boundMouseLeave: () => void;
    private progressEl: HTMLElement | null = null;

    constructor(player: Player, options: { vttUrl: string }) {
        this.player = player;

        this.container = document.createElement('div');
        this.container.className = 'vjs-thumbnail-preview';
        Object.assign(this.container.style, {
            position: 'absolute',
            display: 'none',
            pointerEvents: 'none',
            zIndex: '100',
            border: '2px solid rgba(255, 255, 255, 0.9)',
            borderRadius: '3px',
            boxShadow: '0 2px 8px rgba(0, 0, 0, 0.6)',
            backgroundRepeat: 'no-repeat',
            imageRendering: 'auto',
        });

        this.boundMouseMove = this.onMouseMove.bind(this);
        this.boundMouseLeave = this.onMouseLeave.bind(this);

        this.loadVtt(options.vttUrl);
        this.waitForControlBar();

        player.on('dispose', () => this.dispose());
    }

    private waitForControlBar() {
        const progressControl = (this.player as any).controlBar
            ?.progressControl;
        if (progressControl) {
            this.attach(progressControl);
            return;
        }
        // Control bar may not be rendered yet — poll briefly until it appears
        const check = () => {
            const pc = (this.player as any).controlBar?.progressControl;
            if (pc) {
                this.attach(pc);
            } else {
                this.player.setTimeout(() => check(), 100);
            }
        };
        this.player.setTimeout(() => check(), 100);
    }

    private attach(progressControl: any) {
        this.progressEl = progressControl.el() as HTMLElement;

        // Append the thumbnail to the player element so it isn't clipped
        // by the control bar or progress control overflow
        const playerEl = this.player.el() as HTMLElement;
        playerEl.appendChild(this.container);

        this.progressEl.addEventListener('mousemove', this.boundMouseMove);
        this.progressEl.addEventListener('mouseleave', this.boundMouseLeave);
    }

    private dispose() {
        if (this.progressEl) {
            this.progressEl.removeEventListener(
                'mousemove',
                this.boundMouseMove,
            );
            this.progressEl.removeEventListener(
                'mouseleave',
                this.boundMouseLeave,
            );
        }
        this.container.remove();
    }

    private async loadVtt(vttUrl: string) {
        try {
            const res = await fetch(vttUrl);
            if (!res.ok) {
                console.warn(
                    `Thumbnail VTT fetch failed: ${res.status} ${res.statusText}`,
                );
                return;
            }
            const text = await res.text();

            const baseUrl = vttUrl.substring(0, vttUrl.lastIndexOf('/'));
            this.cues = parseVtt(text, baseUrl);

            if (this.cues.length === 0) {
                console.warn('Thumbnail VTT parsed but no cues found');
            }

            this.preloadSprites();
        } catch (err) {
            console.warn('Failed to load thumbnail VTT:', err);
        }
    }

    private preloadSprites() {
        for (const cue of this.cues) {
            if (!this.preloadedImages.has(cue.spriteUrl)) {
                this.preloadedImages.add(cue.spriteUrl);
                const img = new Image();
                img.src = cue.spriteUrl;
            }
        }
    }

    private onMouseMove(e: MouseEvent) {
        if (!this.cues.length || !this.progressEl) return;

        const rect = this.progressEl.getBoundingClientRect();
        const fraction = Math.max(
            0,
            Math.min(1, (e.clientX - rect.left) / rect.width),
        );
        const duration = this.player.duration();
        if (!duration || !isFinite(duration)) return;

        const time = fraction * duration;
        const cue = this.cues.find(
            (c) => time >= c.startTime && time < c.endTime,
        );
        if (!cue || !cue.w || !cue.h) {
            this.container.style.display = 'none';
            return;
        }

        const playerEl = this.player.el() as HTMLElement;
        const playerRect = playerEl.getBoundingClientRect();

        // Position the thumbnail above the control bar, aligned to mouse
        const controlBar = (this.player as any).controlBar?.el() as
            | HTMLElement
            | undefined;
        const controlBarHeight = controlBar
            ? controlBar.getBoundingClientRect().height
            : 30;

        const left = Math.max(
            0,
            Math.min(
                playerRect.width - cue.w,
                e.clientX - playerRect.left - cue.w / 2,
            ),
        );
        const bottom = controlBarHeight + 4;

        Object.assign(this.container.style, {
            display: 'block',
            width: `${cue.w}px`,
            height: `${cue.h}px`,
            backgroundImage: `url("${cue.spriteUrl}")`,
            backgroundPosition: `-${cue.x}px -${cue.y}px`,
            backgroundSize: 'auto',
            left: `${left}px`,
            bottom: `${bottom}px`,
        });
    }

    private onMouseLeave() {
        this.container.style.display = 'none';
    }
}

export function registerThumbnailPreview() {
    if (videojs.getPlugin('thumbnailPreview')) return;

    videojs.registerPlugin(
        'thumbnailPreview',
        function (this: any, options: { vttUrl: string }) {
            const player = this as Player;
            player.ready(() => {
                new ThumbnailPreview(player, options);
            });
        },
    );
}
