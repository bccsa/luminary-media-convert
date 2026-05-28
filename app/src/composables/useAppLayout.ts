import { ref, readonly } from 'vue';

type HeaderLayout = 'default' | 'session' | 'session-trim';

const _headerLayout = ref<HeaderLayout>('default');

export function useAppLayout() {
    return {
        headerLayout: readonly(_headerLayout),
        setHeaderLayout: (layout: HeaderLayout) => {
            _headerLayout.value = layout;
        },
    };
}
