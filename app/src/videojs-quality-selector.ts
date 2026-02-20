import videojs from 'video.js';
import type Player from 'video.js/dist/types/player';

const MenuButton = videojs.getComponent('MenuButton') as any;
const MenuItem = videojs.getComponent('MenuItem') as any;

type SetQualityFn = (value: number | 'auto') => void;

class QualityMenuItem extends MenuItem {
    qualityValue: number | 'auto';
    private setQuality: SetQualityFn;

    constructor(
        player: Player,
        options: { label: string; value: number | 'auto'; selected?: boolean },
        setQuality: SetQualityFn,
    ) {
        super(player, {
            label: options.label,
            selectable: true,
            multiSelectable: false,
            selected: options.selected ?? false,
        });
        this.qualityValue = options.value;
        this.setQuality = setQuality;
    }

    handleClick() {
        super.handleClick();
        this.setQuality(this.qualityValue);
    }
}

class QualitySelectorButton extends MenuButton {
    private currentQuality: number | 'auto' = 'auto';
    private showCurrentQuality: boolean;
    private qualityLevels: any;

    constructor(player: Player, options: { displayCurrentQuality?: boolean }) {
        super(player, options);
        this.showCurrentQuality = options.displayCurrentQuality ?? false;
        this.addClass('vjs-quality-selector');
        this.controlText('Quality');

        this.qualityLevels = (player as any).qualityLevels();
        this.qualityLevels.on('addqualitylevel', () => this.update());

        this.updateLabel('Auto');
    }

    private updateLabel(text: string) {
        const placeholder = this.el()?.querySelector('.vjs-icon-placeholder');
        if (placeholder) {
            if (this.showCurrentQuality) {
                placeholder.textContent = text;
            } else {
                placeholder.classList.add('vjs-icon-hd');
            }
        }
    }

    private pixelsForLevel(level: any): number {
        const w = level.width || 0;
        const h = level.height || 0;
        return w > h ? h : w;
    }

    createItems() {
        const levels: any[] = this.qualityLevels?.levels_ ?? [];
        const seen = new Set<number>();
        const items: QualityMenuItem[] = [];
        const setQuality = (v: number | 'auto') => this.setQuality(v);

        for (const level of levels) {
            const pixels = this.pixelsForLevel(level);
            if (!pixels || seen.has(pixels)) continue;
            seen.add(pixels);
            items.push(
                new QualityMenuItem(
                    this.player(),
                    { label: `${pixels}p`, value: pixels },
                    setQuality,
                ),
            );
        }

        items.sort((a, b) => (a.qualityValue as number) - (b.qualityValue as number));

        items.push(
            new QualityMenuItem(
                this.player(),
                { label: this.player().localize('Auto'), value: 'auto', selected: true },
                setQuality,
            ),
        );

        return items;
    }

    private setQuality(quality: number | 'auto') {
        this.currentQuality = quality;

        for (let i = 0; i < this.qualityLevels.length; i++) {
            const pixels = this.pixelsForLevel(this.qualityLevels[i]);
            this.qualityLevels[i].enabled = quality === 'auto' || pixels === quality;
        }

        this.updateLabel(quality === 'auto' ? this.player().localize('Auto') : `${quality}p`);

        for (const item of this.items ?? []) {
            (item as QualityMenuItem).selected(item.qualityValue === quality);
        }

        this.unpressButton();
    }
}

export function registerQualitySelector() {
    if (videojs.getPlugin('hlsQualitySelector')) return;

    videojs.registerPlugin('hlsQualitySelector', function (this: any, options: any = {}) {
        const player = this as Player;
        player.ready(() => {
            const p = player as any;
            if (typeof p.qualityLevels !== 'function') return;
            p.qualityLevels();

            const placementIndex = p.controlBar.children().length - 2;
            p.controlBar.addChild(
                new QualitySelectorButton(player, options),
                { componentClass: 'qualitySelector' },
                placementIndex,
            );
        });
    });
}
