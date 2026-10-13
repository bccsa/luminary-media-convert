/**
 * The names a master gives its subtitles are its packager's own (`stream_0`, `track 2`), and say nothing to a viewer;
 * each engine would show them as they are, or by its own idea of the language, so the menus of one player would not
 * agree. A generated name is replaced, once, in the master text every engine reads, by the language's name in the
 * viewer's language; a name a person wrote (`English SDH`, `Commentary`) is left alone.
 */
const GENERATED = /^(stream|track|sub|subs|subtitle|subtitles|text|caption|captions)[\s_-]*\d*$/i;

const MEDIA_LINE = /^#EXT-X-MEDIA:/;

function attr(line: string, key: string): string | undefined {
    const quoted = new RegExp(`(?:^|[:,])${key}="([^"]*)"`).exec(line);
    return quoted ? quoted[1] : undefined;
}

function languageName(code: string, displayLanguage: string): string | undefined {
    try {
        const name = new Intl.DisplayNames([displayLanguage], { type: 'language' }).of(code);
        if (!name || name.toLowerCase() === code.toLowerCase()) return undefined;
        return name.charAt(0).toLocaleUpperCase(displayLanguage) + name.slice(1);
    } catch {
        return undefined;
    }
}

/** The master text with every generated subtitle name replaced by its language's name. */
export function relabelGeneratedSubtitleNames(text: string, displayLanguage: string): string {
    if (!text.includes('TYPE=SUBTITLES')) return text;
    const used = new Map<string, number>();
    return text
        .split('\n')
        .map((line) => {
            if (!MEDIA_LINE.test(line) || !/(?:^|[:,])TYPE=SUBTITLES(?:,|$)/.test(line.replace('\r', ''))) return line;
            const name = attr(line, 'NAME');
            const language = attr(line, 'LANGUAGE');
            if (name === undefined || !language || !GENERATED.test(name.trim())) return line;
            const base = languageName(language, displayLanguage);
            if (!base) return line;
            const key = `${attr(line, 'GROUP-ID') ?? ''}|${language.toLowerCase()}`;
            const count = (used.get(key) ?? 0) + 1;
            used.set(key, count);
            const label = count > 1 ? `${base} ${count}` : base;
            return line.replace(`NAME="${name}"`, `NAME="${label.replace(/"/g, '')}"`);
        })
        .join('\n');
}
