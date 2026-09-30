import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

/**
 * The build-target virtual modules, as `bccsa/luminary`'s `app/vite-plugins/buildTargetVirtuals.ts`
 * has them, so the lab resolves its player the way the app will.
 *
 * `VITE_NATIVE_IMPL_DIR` points a packaged-app build at a directory supplying `<name>.ts`
 * implementations of the platform-swappable services (`native-plugins/` here;
 * `luminary-deployment/capacitor/native-plugins/` for the app).
 */
export function buildTargetVirtuals(root = fileURLToPath(new URL('../src', import.meta.url))): Plugin {
    const virtualTargets: Record<string, string> = {
        'virtual:video-player': `${root}/build-time/plugins/video-player/index.ts`,
    };
    const platformSwappable = new Set(['video-player']);
    const nativeImplDir = process.env.VITE_NATIVE_IMPL_DIR
        ? path.resolve(process.env.VITE_NATIVE_IMPL_DIR)
        : undefined;

    return {
        name: 'build-target-virtuals',
        async resolveId(id, importer) {
            if (nativeImplDir && id.startsWith('virtual:')) {
                const name = id.slice('virtual:'.length);
                if (platformSwappable.has(name)) return path.join(nativeImplDir, `${name}.ts`);
            }
            // Bare package imports in external implementation files resolve against the app's own
            // dependency tree, not their on-disk location.
            if (
                nativeImplDir &&
                importer?.startsWith(nativeImplDir) &&
                !id.startsWith('.') &&
                !id.startsWith('virtual:') &&
                !path.isAbsolute(id)
            ) {
                const resolved = await this.resolve(id, path.join(root, 'main.ts'), { skipSelf: true });
                if (resolved) return resolved;
            }
            return virtualTargets[id];
        },
    };
}
