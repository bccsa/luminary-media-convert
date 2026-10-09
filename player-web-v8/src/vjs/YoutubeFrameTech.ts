/**
 * A YouTube tech that plays through an HTTPS-hosted embed page instead of
 * creating the YouTube iframe itself, for pages whose own origin YouTube
 * refuses (Capacitor iOS, `capacitor://localhost`). See the protocol module.
 */
import videojs from 'video.js';
import {
    originOf,
    parseFrameEvent,
    toFrameMessage,
    type FrameCommand,
    type FrameEvent,
} from '../youtubeFrameProtocol';
import { extractYouTubeId } from '../youtube';

export const YOUTUBE_FRAME_TECH = 'youtubeframe';

/** YouTube's `YT.PlayerState` values the tech reacts to. */
const ENDED = 0;
const PLAYING = 1;
const PAUSED = 2;
const BUFFERING = 3;

const Tech = videojs.getTech('Tech') as any;

/** The embed page URL, set before a player is built; a tech has no other way in. */
let embedUrl = '';
export function setYoutubeFrameEmbedUrl(url: string): void {
    embedUrl = url;
}

class YoutubeFrame extends Tech {
    // `declare`: createEl() runs inside super(), and a plain field would reset it after.
    declare private frame_: HTMLIFrameElement;
    private origin_ = '';
    private ready_ = false;
    private queue_: FrameCommand[] = [];
    private videoId_: string | null = null;
    private time_ = 0;
    private duration_ = 0;
    private loaded_ = 0;
    private paused_ = true;
    private ended_ = false;
    private rate_ = 1;
    private volume_ = 1;
    private muted_ = false;
    private onMessage_ = (event: MessageEvent): void => this.handle(event);

    constructor(options: any, ready: () => void) {
        super(options, ready);
        this.origin_ = originOf(embedUrl) ?? '';
        window.addEventListener('message', this.onMessage_);
        this.setSrc(options.source?.src);
        this.setTimeout(() => this.el_?.parentNode && ((this.el_.parentNode as HTMLElement).className += ' vjs-youtube'));
        // Anything posted before the embed page has loaded is lost, so the video is sent now.
        this.frame_.addEventListener('load', () => {
            this.post({ name: 'hello' });
            if (this.videoId_) this.post({ name: 'load', videoId: this.videoId_ });
        });
        this.triggerReady();
    }

    createEl(): HTMLElement {
        const wrapper = document.createElement('div');
        wrapper.className = 'vjs-tech';
        wrapper.setAttribute('style', 'width:100%;height:100%;top:0;left:0;position:absolute');
        const frame = document.createElement('iframe');
        frame.src = embedUrl;
        frame.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
        frame.setAttribute('style', 'width:100%;height:100%;border:0');
        wrapper.appendChild(frame);
        this.frame_ = frame;
        return wrapper;
    }

    dispose(): void {
        window.removeEventListener('message', this.onMessage_);
        this.post({ name: 'destroy' });
        super.dispose();
    }

    private post(command: FrameCommand): void {
        if (command.name !== 'hello' && command.name !== 'load' && !this.ready_) {
            this.queue_.push(command);
            return;
        }
        this.frame_?.contentWindow?.postMessage(toFrameMessage(command), this.origin_);
    }

    private handle(event: MessageEvent): void {
        const e: FrameEvent | null = parseFrameEvent(event, this.origin_, this.frame_?.contentWindow);
        if (!e) return;
        switch (e.name) {
            case 'ready':
                this.ready_ = true;
                for (const queued of this.queue_.splice(0)) this.post(queued);
                this.trigger('loadedmetadata');
                break;
            case 'time':
                if (e.duration !== this.duration_) {
                    this.duration_ = e.duration;
                    this.trigger('durationchange');
                }
                this.time_ = e.time;
                this.loaded_ = e.loaded;
                this.trigger('timeupdate');
                this.trigger('progress');
                break;
            case 'state':
                this.onState(e.state);
                break;
            case 'rate':
                this.rate_ = e.rate;
                this.trigger('ratechange');
                break;
            case 'volume':
                this.volume_ = e.volume;
                this.muted_ = e.muted;
                this.trigger('volumechange');
                break;
            case 'error':
                this.error_ = { code: 4, message: `YouTube error ${e.code}` };
                this.trigger('error');
                break;
        }
    }

    private onState(state: number): void {
        this.ended_ = state === ENDED;
        if (state === PLAYING) {
            this.paused_ = false;
            this.trigger('playing');
            this.trigger('play');
        } else if (state === PAUSED || state === ENDED) {
            this.paused_ = true;
            this.trigger(state === ENDED ? 'ended' : 'pause');
        } else if (state === BUFFERING) {
            this.trigger('waiting');
        }
    }

    setSrc(src?: string): void {
        this.videoId_ = extractYouTubeId(src);
        if (this.videoId_) this.post({ name: 'load', videoId: this.videoId_ });
    }
    src(src?: string): string | undefined {
        if (src === undefined) return this.videoId_ ? `https://www.youtube.com/watch?v=${this.videoId_}` : undefined;
        this.setSrc(src);
        return undefined;
    }

    play(): void { this.post({ name: 'play' }); }
    pause(): void { this.post({ name: 'pause' }); }
    paused(): boolean { return this.paused_; }
    ended(): boolean { return this.ended_; }
    currentTime(): number { return this.time_; }
    setCurrentTime(seconds: number): void { this.time_ = seconds; this.post({ name: 'seek', value: seconds }); this.trigger('seeking'); this.trigger('seeked'); }
    duration(): number { return this.duration_; }
    volume(): number { return this.volume_; }
    setVolume(v: number): void { this.post({ name: 'volume', value: v }); }
    muted(): boolean { return this.muted_; }
    setMuted(m: boolean): void { this.post({ name: m ? 'mute' : 'unmute' }); }
    playbackRate(): number { return this.rate_; }
    setPlaybackRate(r: number): void { this.post({ name: 'rate', value: r }); }
    buffered(): TimeRanges { return videojs.time.createTimeRanges(0, this.loaded_ * this.duration_) as TimeRanges; }
    seekable(): TimeRanges { return videojs.time.createTimeRanges(0, this.duration_) as TimeRanges; }
    supportsFullScreen(): boolean { return true; }
    controls(): boolean { return false; }
    readyState(): number { return this.ready_ ? 4 : 0; }
    networkState(): number { return 1; }

    static isSupported(): boolean { return true; }
    static canPlayType(type: string): string { return type === 'video/youtube' ? 'maybe' : ''; }
    static canPlaySource(source: { type: string }): string { return YoutubeFrame.canPlayType(source.type); }
}

/** Registers the tech once; harmless to call again. */
export function registerYoutubeFrameTech(): void {
    if (!videojs.getTech('Youtubeframe')) videojs.registerTech('Youtubeframe', YoutubeFrame as any);
}
