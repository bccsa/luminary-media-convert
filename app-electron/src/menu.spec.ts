import { describe, expect, it, vi } from 'vitest';
import type { MenuItemConstructorOptions } from 'electron';
import { menuTemplate, type MenuOptions } from './menu';

const options = (over: Partial<MenuOptions> = {}): MenuOptions => ({
    isMac: false,
    appName: 'Luminary Media Convert',
    ffmpegDirChosen: false,
    logPath: '/logs/main.log',
    actions: {
        licences: vi.fn(),
        chooseFfmpeg: vi.fn(),
        useBundledFfmpeg: vi.fn(),
        checkForUpdates: vi.fn(),
        clearWorkingFiles: vi.fn(),
        showLog: vi.fn(),
    },
    ...over,
});

/** Every item with a label, wherever it sits. */
function items(
    template: MenuItemConstructorOptions[]
): MenuItemConstructorOptions[] {
    return template.flatMap((item) => [
        item,
        ...items(
            (item.submenu as MenuItemConstructorOptions[] | undefined) ?? []
        ),
    ]);
}
const find = (template: MenuItemConstructorOptions[], label: string) =>
    items(template).find((i) => i.label === label);

describe('the application menu', () => {
    const maintenance = [
        'Check for Updates…',
        'Clear Working Files…',
        'Show Log File',
    ];

    it('puts the app items under Help on Windows', () => {
        const help = menuTemplate(options()).find((i) => i.role === 'help')!;
        const labels = (help.submenu as MenuItemConstructorOptions[]).map(
            (i) => i.label
        );
        expect(labels).toEqual(
            expect.arrayContaining([
                'Licences',
                'Choose FFmpeg…',
                ...maintenance,
            ])
        );
    });

    it("puts them under the app's own menu on a Mac, leaving Help to the licences", () => {
        const template = menuTemplate(options({ isMac: true }));
        const appMenu = template[0]!;
        expect(appMenu.label).toBe('Luminary Media Convert');
        const labels = (appMenu.submenu as MenuItemConstructorOptions[]).map(
            (i) => i.label
        );
        expect(labels).toEqual(
            expect.arrayContaining(['Choose FFmpeg…', ...maintenance])
        );
        const help = template.find((i) => i.role === 'help')!;
        expect(
            (help.submenu as MenuItemConstructorOptions[]).map((i) => i.label)
        ).toEqual(['Licences']);
    });

    it('offers the log file only once there is one', () => {
        expect(find(menuTemplate(options()), 'Show Log File')?.enabled).toBe(
            true
        );
        expect(
            find(menuTemplate(options({ logPath: null })), 'Show Log File')
                ?.enabled
        ).toBe(false);
    });

    it('offers the bundled FFmpeg back only when another one is in use', () => {
        expect(
            find(menuTemplate(options()), 'Use the bundled FFmpeg')?.enabled
        ).toBe(false);
        expect(
            find(
                menuTemplate(options({ ffmpegDirChosen: true })),
                'Use the bundled FFmpeg'
            )?.enabled
        ).toBe(true);
    });

    it('has a Developer menu only when given one, as a development build is', () => {
        expect(menuTemplate(options()).some((m) => m.label === 'Developer')).toBe(false);
        const toggleStorageOffline = vi.fn();
        const template = menuTemplate(
            options({ developer: { storageOffline: true, toggleStorageOffline } })
        );
        const item = find(template, 'Storage Offline')!;
        expect(item).toMatchObject({ type: 'checkbox', checked: true });
        (item.click as () => void)();
        expect(toggleStorageOffline).toHaveBeenCalled();
    });

    it('wires each item to its action', () => {
        const opts = options();
        const template = menuTemplate(opts);
        (find(template, 'Show Log File')!.click as () => void)();
        (find(template, 'Check for Updates…')!.click as () => void)();
        expect(opts.actions.showLog).toHaveBeenCalled();
        expect(opts.actions.checkForUpdates).toHaveBeenCalled();
    });
});
