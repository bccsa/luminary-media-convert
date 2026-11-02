import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The stylesheet loads with the package, so it reaches every page that imports anything from it, including
 * pages that draw their own `.lmpl-*` player. A rule outside `.lmpl-simple` would restyle that one: an
 * opaque `.lmpl-root` there covers a picture drawn behind the page.
 */
describe('styles.css', () => {
    const css = readFileSync(
        resolve(__dirname, '../src/styles.css'),
        'utf8'
    ).replace(/\/\*[\s\S]*?\*\//g, '');
    const selectors = [...css.matchAll(/([^{}]+)\{/g)].flatMap((match) =>
        match[1]!.split(',').map((s) => s.trim())
    );

    it('has rules to check', () => {
        expect(selectors.length).toBeGreaterThan(5);
    });

    it('scopes every rule to the simple player', () => {
        expect(
            selectors.filter((selector) => !selector.startsWith('.lmpl-simple'))
        ).toEqual([]);
    });
});
