import videojs from 'video.js';
import type Player from 'video.js/dist/types/player';

const MenuButton = videojs.getComponent('MenuButton') as any;
const MenuItem = videojs.getComponent('MenuItem') as any;

type SetFn<T> = (value: T) => void;

// ─── Quality selector ───────────────────────────────────────────────

class QualityMenuItem extends MenuItem {
    qualityValue: number | 'auto';
    private setQuality: SetFn<number | 'auto'>;

    constructor(
        player: Player,
        options: { label: string; value: number | 'auto'; selected?: boolean },
        setQuality: SetFn<number | 'auto'>,
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
    private audioOnly = false;

    constructor(player: Player, options: { displayCurrentQuality?: boolean }) {
        super(player, options);
        this.showCurrentQuality = options.displayCurrentQuality ?? false;
        this.addClass('vjs-quality-selector');
        this.controlText('Quality');

        this.qualityLevels = (player as any).qualityLevels();
        this.qualityLevels.on('addqualitylevel', () => this.update());
        player.on('loadedmetadata', () => this.update());

        // Reset to auto on source change so stale labels don't persist
        player.on('loadstart', () => {
            this.currentQuality = 'auto';
            this.audioOnly = false;
            this.updateLabel('Auto');
        });

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

    private isAudioOnly(levels: any[]): boolean {
        return levels.length > 0 && levels.every((l: any) => !l.width && !l.height);
    }

    private bitrateLabel(bw: number): string {
        return bw >= 1000 ? `${Math.round(bw / 1000)} kbps` : `${bw} bps`;
    }

    private audioLabelForBandwidth(bw: number): string {
        const match = this.getVhsStreamInfs().find(s => s.bandwidth === bw);
        return match?.label ?? this.bitrateLabel(bw);
    }

    /** Read STREAM-INF entries from VHS's parsed master playlist. */
    private getVhsStreamInfs(): { bandwidth: number; label: string }[] {
        try {
            const tech = this.player().tech({ IWillNotUseThisInPlugins: true } as any) as any;
            const main = tech?.vhs?.playlists?.main ?? tech?.vhs?.playlists?.master;
            const playlists: any[] = main?.playlists ?? [];
            const seen = new Set<number>();
            const result: { bandwidth: number; label: string }[] = [];
            for (const pl of playlists) {
                const bw = pl.attributes?.BANDWIDTH ?? 0;
                if (!bw || seen.has(bw)) continue;
                seen.add(bw);
                const groupId: string = pl.attributes?.AUDIO ?? '';
                result.push({ bandwidth: bw, label: groupId || this.bitrateLabel(bw) });
            }
            return result.sort((a, b) => a.bandwidth - b.bandwidth);
        } catch {
            return [];
        }
    }

    createItems() {
        // Guard: qualityLevels not yet set during super() constructor call
        if (!this.qualityLevels) return [];
        const levels: any[] = this.qualityLevels?.levels_ ?? [];
        this.audioOnly = this.isAudioOnly(levels);

        const seen = new Set<number>();
        const items: QualityMenuItem[] = [];
        const setQuality = (v: number | 'auto') => this.setQuality(v);

        if (this.audioOnly) {
            // Audio-only: read STREAM-INF entries from VHS master playlist.
            // Use the AUDIO group-id as the label (e.g. "hd", "mid", "low").
            const streams = this.getVhsStreamInfs();
            for (const s of streams) {
                items.push(new QualityMenuItem(
                    this.player(),
                    { label: s.label, value: s.bandwidth },
                    setQuality,
                ));
            }
        } else {
            // Video: use resolution-based keys
            for (const level of levels) {
                const w = level.width || 0;
                const h = level.height || 0;
                const key = w > h ? h : w;
                if (!key || seen.has(key)) continue;
                seen.add(key);
                items.push(new QualityMenuItem(
                    this.player(),
                    { label: `${key}p`, value: key },
                    setQuality,
                ));
            }
        }

        items.sort((a, b) => (b.qualityValue as number) - (a.qualityValue as number));

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

        if (this.audioOnly) {
            // Audio-only: lock VHS to a specific STREAM-INF by bandwidth
            try {
                const tech = this.player().tech({ IWillNotUseThisInPlugins: true } as any) as any;
                const mpc = tech?.vhs?.playlistController_ ?? tech?.vhs?.masterPlaylistController_;
                if (mpc) {
                    if (quality === 'auto') {
                        // Restore ABR by removing our override
                        delete mpc.selectPlaylist;
                    } else {
                        const main = tech.vhs.playlists.main ?? tech.vhs.playlists.master;
                        const playlists: any[] = main?.playlists ?? [];
                        const target = playlists.find((p: any) => p.attributes?.BANDWIDTH === quality);
                        if (target) {
                            mpc.selectPlaylist = () => target;
                            // Trigger segment loader to pick up the new playlist
                            try { mpc.segmentLoaders_.audio?.playlist(target); } catch { /* ok */ }
                        }
                    }
                }
            } catch { /* VHS internals not available */ }
        } else {
            // Video: toggle qualityLevel.enabled
            for (let i = 0; i < this.qualityLevels.length; i++) {
                const level = this.qualityLevels[i];
                const w = level.width || 0;
                const h = level.height || 0;
                const key = w > h ? h : w;
                level.enabled = quality === 'auto' || key === quality;
            }
        }

        this.updateLabel(quality === 'auto' ? this.player().localize('Auto') : (this.audioOnly ? this.audioLabelForBandwidth(quality as number) : `${quality}p`));

        for (const item of this.items ?? []) {
            (item as QualityMenuItem).selected(item.qualityValue === quality);
        }

        this.unpressButton();
    }
}

// ─── Audio track / language selector (audio-only mode) ──────────────
// Only shown when VHS does NOT populate native audioTracks.
// When native audioTracks are available, Video.js's built-in
// AudioTrackButton handles language switching automatically.

class TrackMenuItem extends MenuItem {
    trackValue: string;
    private setTrack: SetFn<string>;

    constructor(
        player: Player,
        options: { label: string; value: string; selected?: boolean },
        setTrack: SetFn<string>,
    ) {
        super(player, {
            label: options.label,
            selectable: true,
            multiSelectable: false,
            selected: options.selected ?? false,
        });
        this.trackValue = options.value;
        this.setTrack = setTrack;
    }

    handleClick() {
        super.handleClick();
        this.setTrack(this.trackValue);
    }
}

class AudioTrackSelectorButton extends MenuButton {
    private currentLanguage: string = '';
    private boundUpdate: () => void;

    constructor(player: Player) {
        super(player, {});
        this.addClass('vjs-audio-track-selector');
        this.controlText('Language');
        this.updateLabel('Audio');

        this.boundUpdate = () => this.update();

        const ql = (player as any).qualityLevels();
        ql.on('addqualitylevel', this.boundUpdate);
        player.on('loadedmetadata', this.boundUpdate);

        // Reset on source change
        player.on('loadstart', () => {
            this.currentLanguage = '';
            this.updateLabel('Audio');
        });

        // Listen on native audio tracks for when VHS populates them
        const tracks = player.audioTracks();
        tracks.addEventListener('addtrack', this.boundUpdate);
        tracks.addEventListener('removetrack', this.boundUpdate);
    }

    dispose() {
        const tracks = this.player().audioTracks();
        tracks.removeEventListener('addtrack', this.boundUpdate);
        tracks.removeEventListener('removetrack', this.boundUpdate);
        this.player().off('loadedmetadata', this.boundUpdate);
        super.dispose();
    }

    private updateLabel(text: string) {
        const placeholder = this.el()?.querySelector('.vjs-icon-placeholder');
        if (placeholder) {
            placeholder.textContent = text;
        }
    }

    private isAudioOnlyMode(): boolean {
        try {
            const ql = (this.player() as any).qualityLevels();
            const levels: any[] = ql?.levels_ ?? [];
            return levels.length > 0 && levels.every((l: any) => !l.width && !l.height);
        } catch {
            return false;
        }
    }

    private hasNativeAudioTracks(): boolean {
        return this.player().audioTracks().length > 1;
    }

    /** Read audio rendition names from VHS's parsed master playlist. */
    private getVhsAudioLanguages(): string[] {
        try {
            const tech = this.player().tech({ IWillNotUseThisInPlugins: true } as any) as any;
            const main = tech?.vhs?.playlists?.main ?? tech?.vhs?.playlists?.master;
            const audioGroups = main?.mediaGroups?.AUDIO;
            if (!audioGroups) return [];

            const firstGroupId = Object.keys(audioGroups)[0];
            if (!firstGroupId) return [];

            return Object.keys(audioGroups[firstGroupId]);
        } catch {
            return [];
        }
    }

    createItems() {
        const el = this.el();

        // Hide in video mode (native AudioTrackButton handles it) and
        // hide in audio-only mode when native audioTracks are available
        // (VHS populated them from EXT-X-MEDIA — native button works).
        if (!this.isAudioOnlyMode() || this.hasNativeAudioTracks()) {
            if (el) el.style.display = 'none';
            return [];
        }

        // Fallback: read languages from VHS's parsed master playlist
        const languages = this.getVhsAudioLanguages();
        if (languages.length <= 1) {
            if (el) el.style.display = 'none';
            return [];
        }

        if (!this.currentLanguage) {
            this.currentLanguage = languages[0];
        }

        const items: TrackMenuItem[] = [];
        const setTrack = (v: string) => this.switchVhsAudioRendition(v);

        for (const lang of languages) {
            items.push(new TrackMenuItem(
                this.player(),
                { label: lang, value: lang, selected: lang === this.currentLanguage },
                setTrack,
            ));
        }

        if (el) el.style.display = '';
        this.updateLabel(this.currentLanguage);
        return items;
    }

    /** Switch audio rendition via VHS internal audio group management. */
    private switchVhsAudioRendition(name: string) {
        this.currentLanguage = name;

        try {
            const tech = this.player().tech({ IWillNotUseThisInPlugins: true } as any) as any;
            const mpc = tech?.vhs?.playlistController_ ?? tech?.vhs?.masterPlaylistController_;
            const audioType = mpc?.mediaTypes_?.AUDIO;

            if (audioType?.activeTrack) {
                const tracks = audioType.tracks ?? {};
                for (const [trackName, track] of Object.entries(tracks) as [string, any][]) {
                    if (typeof track?.enabled !== 'undefined') {
                        track.enabled = trackName === name;
                    }
                }
            }
        } catch { /* VHS internals not available */ }

        this.updateLabel(name);

        for (const item of this.items ?? []) {
            (item as TrackMenuItem).selected((item as TrackMenuItem).trackValue === name);
        }
        this.unpressButton();
    }
}

// ─── Plugin registration ────────────────────────────────────────────

export function registerQualitySelector() {
    if (videojs.getPlugin('hlsQualitySelector')) return;

    videojs.registerPlugin('hlsQualitySelector', function (this: any, options: any = {}) {
        const player = this as Player;
        player.ready(() => {
            const p = player as any;
            if (typeof p.qualityLevels !== 'function') return;

            const placementIndex = p.controlBar.children().length - 2;
            p.controlBar.addChild(
                new AudioTrackSelectorButton(player),
                { componentClass: 'audioTrackSelector' },
                placementIndex,
            );
            p.controlBar.addChild(
                new QualitySelectorButton(player, options),
                { componentClass: 'qualitySelector' },
                placementIndex + 1,
            );
        });
    });
}
