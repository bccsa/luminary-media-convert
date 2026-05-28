import { ref, onMounted } from 'vue';

export type ThemePreference = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'luminary-theme';

function readStored(): ThemePreference {
    try {
        const v = localStorage.getItem(STORAGE_KEY);
        if (v === 'light' || v === 'dark' || v === 'system') return v;
    } catch {
        /* ignore */
    }
    return 'system';
}

export function resolveDark(pref: ThemePreference): boolean {
    if (pref === 'dark') return true;
    if (pref === 'light') return false;
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function applyTheme(pref: ThemePreference): void {
    document.documentElement.classList.toggle('dark', resolveDark(pref));
}

const preference = ref<ThemePreference>(readStored());

let mediaListenerAttached = false;

function onSystemSchemeChange() {
    if (preference.value === 'system') applyTheme('system');
}

/** Theme preference shared across the app (same storage key as index.html boot script). */
export function useTheme() {
    function setPreference(p: ThemePreference) {
        preference.value = p;
        try {
            localStorage.setItem(STORAGE_KEY, p);
        } catch {
            /* ignore */
        }
        applyTheme(p);
    }

    onMounted(() => {
        preference.value = readStored();
        applyTheme(preference.value);
        if (!mediaListenerAttached) {
            window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', onSystemSchemeChange);
            mediaListenerAttached = true;
        }
    });

    return { preference, setPreference };
}
