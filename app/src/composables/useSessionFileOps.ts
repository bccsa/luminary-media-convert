import { ref, computed, type Ref } from 'vue';
import {
    listS3Configs,
    checkPrefix,
    moveSessionFiles,
    renameSessionPrefix,
} from '../api';
import type { S3ConfigSummary } from '../types';
import { errorMessage } from '../utils/errors';

interface SessionFileOpsDeps {
    /** Resolves an Auth0 access token for the current user. */
    getAccessToken: () => Promise<string>;
    /** Active session id (route param). */
    sessionId: Readonly<Ref<string>>;
    /** The loaded session detail document; reads `s3Config.pathPrefix` and `s3ConfigId`. */
    session: Ref<{ s3Config?: { pathPrefix?: string }; s3ConfigId?: string } | null>;
    /** Refetches the session detail after a successful move/rename. */
    refresh: () => Promise<void>;
}

/**
 * State + handlers for the two completed-session relocation flows:
 * - **Move**: copy output files to a different S3 config + prefix.
 * - **Rename**: change the prefix within the same S3 config.
 *
 * Both flows share a "warn before overwriting an existing prefix" step that
 * runs against `checkPrefix`.
 */
export function useSessionFileOps(deps: SessionFileOpsDeps) {
    const { getAccessToken, sessionId, session, refresh } = deps;

    // --- Move -------------------------------------------------------------

    const showMoveForm = ref(false);
    const moving = ref(false);
    const moveError = ref<string | null>(null);
    const s3Configs = ref<S3ConfigSummary[]>([]);
    const selectedTargetConfigId = ref('');
    const moveNewPrefix = ref('');
    const movePrefixWarning = ref<string | null>(null);
    const moveConfirmedOverwrite = ref(false);
    const checkingMovePrefix = ref(false);

    const moveTargetS3SelectOptions = computed(() =>
        s3Configs.value.map((c) => ({
            value: c.id,
            label: `${c.name} (${c.bucket})`,
        })),
    );

    async function openMoveForm() {
        moveError.value = null;
        movePrefixWarning.value = null;
        moveConfirmedOverwrite.value = false;
        try {
            const token = await getAccessToken();
            const result = await listS3Configs(token);
            s3Configs.value = result.configs ?? [];
        } catch (e) {
            moveError.value = errorMessage(e);
            return;
        }
        selectedTargetConfigId.value = '';
        moveNewPrefix.value = session.value?.s3Config?.pathPrefix ?? '';
        showMoveForm.value = true;
    }

    async function checkMovePrefix() {
        movePrefixWarning.value = null;
        moveConfirmedOverwrite.value = false;
        if (!selectedTargetConfigId.value || !moveNewPrefix.value.trim()) return;
        checkingMovePrefix.value = true;
        try {
            const token = await getAccessToken();
            const result = await checkPrefix(
                token,
                selectedTargetConfigId.value,
                moveNewPrefix.value.trim(),
            );
            if (result.exists) {
                movePrefixWarning.value = `This prefix already contains ${result.count} file(s). Moving here will add files alongside existing ones.`;
            }
        } catch {
            // Non-critical — proceed without warning
        } finally {
            checkingMovePrefix.value = false;
        }
    }

    const canMove = computed(
        () =>
            !!selectedTargetConfigId.value &&
            !!moveNewPrefix.value.trim() &&
            !moving.value &&
            !checkingMovePrefix.value &&
            (!movePrefixWarning.value || moveConfirmedOverwrite.value),
    );

    async function confirmMove() {
        if (!canMove.value) return;
        moving.value = true;
        moveError.value = null;
        try {
            const token = await getAccessToken();
            await moveSessionFiles(
                token,
                sessionId.value,
                selectedTargetConfigId.value,
                moveNewPrefix.value.trim(),
            );
            showMoveForm.value = false;
            await refresh();
        } catch (e) {
            moveError.value = errorMessage(e);
        } finally {
            moving.value = false;
        }
    }

    // --- Rename -----------------------------------------------------------

    const showRenameForm = ref(false);
    const renaming = ref(false);
    const renameError = ref<string | null>(null);
    const renameNewPrefix = ref('');
    const renamePrefixWarning = ref<string | null>(null);
    const renameConfirmedOverwrite = ref(false);
    const checkingRenamePrefix = ref(false);

    function openRenameForm() {
        renameError.value = null;
        renamePrefixWarning.value = null;
        renameConfirmedOverwrite.value = false;
        renameNewPrefix.value = session.value?.s3Config?.pathPrefix ?? '';
        showRenameForm.value = true;
    }

    async function checkRenamePrefix() {
        renamePrefixWarning.value = null;
        renameConfirmedOverwrite.value = false;
        if (!renameNewPrefix.value.trim() || !session.value?.s3ConfigId) return;
        checkingRenamePrefix.value = true;
        try {
            const token = await getAccessToken();
            const result = await checkPrefix(
                token,
                session.value.s3ConfigId,
                renameNewPrefix.value.trim(),
            );
            if (result.exists) {
                renamePrefixWarning.value = `This prefix already contains ${result.count} file(s). Renaming here will add files alongside existing ones.`;
            }
        } catch {
            // Non-critical
        } finally {
            checkingRenamePrefix.value = false;
        }
    }

    const canRename = computed(
        () =>
            !!renameNewPrefix.value.trim() &&
            !renaming.value &&
            !checkingRenamePrefix.value &&
            (!renamePrefixWarning.value || renameConfirmedOverwrite.value),
    );

    async function confirmRename() {
        if (!canRename.value) return;
        renaming.value = true;
        renameError.value = null;
        try {
            const token = await getAccessToken();
            await renameSessionPrefix(
                token,
                sessionId.value,
                renameNewPrefix.value.trim(),
            );
            showRenameForm.value = false;
            await refresh();
        } catch (e) {
            renameError.value = errorMessage(e);
        } finally {
            renaming.value = false;
        }
    }

    return {
        // Move
        showMoveForm,
        moving,
        moveError,
        selectedTargetConfigId,
        moveNewPrefix,
        movePrefixWarning,
        moveConfirmedOverwrite,
        checkingMovePrefix,
        moveTargetS3SelectOptions,
        openMoveForm,
        checkMovePrefix,
        canMove,
        confirmMove,
        // Rename
        showRenameForm,
        renaming,
        renameError,
        renameNewPrefix,
        renamePrefixWarning,
        renameConfirmedOverwrite,
        checkingRenamePrefix,
        openRenameForm,
        checkRenamePrefix,
        canRename,
        confirmRename,
    };
}
