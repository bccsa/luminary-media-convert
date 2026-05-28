<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAuth0 } from '@auth0/auth0-vue';
import { createUser, getUser, updateUser } from '../api';
import FormSelect from '../components/FormSelect.vue';

const roleSelectOptions = [
    { value: 'user', label: 'User' },
    { value: 'admin', label: 'Admin' },
];

const route = useRoute();
const router = useRouter();
const { getAccessTokenSilently } = useAuth0();

const userId = route.params.id as string | undefined;
const isEditMode = computed(() => !!userId);

const email = ref('');
const name = ref('');
const role = ref('user');
const loading = ref(false);
const submitting = ref(false);
const error = ref<string | null>(null);

async function fetchUser() {
    if (!userId) return;
    loading.value = true;
    error.value = null;
    try {
        const token = await getAccessTokenSilently();
        const user = await getUser(token, userId);
        email.value = user.email;
        name.value = user.name;
        role.value = user.role;
    } catch (e) {
        error.value = e instanceof Error ? e.message : String(e);
    } finally {
        loading.value = false;
    }
}

async function onSubmit() {
    submitting.value = true;
    error.value = null;
    try {
        const token = await getAccessTokenSilently();
        if (isEditMode.value) {
            await updateUser(token, userId!, {
                name: name.value,
                role: role.value,
            });
            router.push(`/users/${userId}`);
        } else {
            const user = await createUser(token, {
                email: email.value,
                name: name.value,
                role: role.value,
            });
            router.push(`/users/${user.id}`);
        }
    } catch (e) {
        error.value = e instanceof Error ? e.message : String(e);
    } finally {
        submitting.value = false;
    }
}

onMounted(fetchUser);
</script>

<template>
    <div>
        <div class="mb-6">
            <router-link
                :to="userId ? `/users/${userId}` : '/users'"
                class="text-sm text-zinc-500 transition-colors hover:text-zinc-300"
            >
                &larr; Back
            </router-link>
        </div>

        <h2 class="mb-6 text-xl font-semibold text-zinc-100">
            {{ isEditMode ? 'Edit User' : 'Create User' }}
        </h2>

        <!-- Error -->
        <div
            v-if="error"
            class="mb-4 rounded-lg border border-red-800/50 bg-red-950/40 p-4"
        >
            <p class="text-sm text-red-400">{{ error }}</p>
        </div>

        <!-- Loading -->
        <div v-if="loading" class="flex justify-center py-16">
            <svg
                class="h-6 w-6 animate-spin text-indigo-400"
                fill="none"
                viewBox="0 0 24 24"
            >
                <circle
                    class="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    stroke-width="4"
                />
                <path
                    class="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                />
            </svg>
        </div>

        <!-- Form -->
        <form
            v-else
            @submit.prevent="onSubmit"
            class="max-w-md space-y-4"
        >
            <div>
                <label
                    for="email"
                    class="mb-1 block text-sm text-zinc-400"
                >
                    Email
                </label>
                <input
                    id="email"
                    v-model="email"
                    type="email"
                    required
                    :disabled="isEditMode"
                    class="w-full rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 outline-none transition-colors focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 disabled:cursor-not-allowed disabled:bg-zinc-900 disabled:text-zinc-500"
                    placeholder="user@example.com"
                />
            </div>

            <div>
                <label
                    for="name"
                    class="mb-1 block text-sm text-zinc-400"
                >
                    Name
                </label>
                <input
                    id="name"
                    v-model="name"
                    type="text"
                    required
                    class="w-full rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 outline-none transition-colors focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
                    placeholder="Full name"
                />
            </div>

            <div>
                <label
                    for="role"
                    class="mb-1 block text-sm text-zinc-400"
                >
                    Role
                </label>
                <FormSelect
                    id="role"
                    variant="admin"
                    v-model="role"
                    :options="roleSelectOptions"
                />
            </div>

            <div class="flex gap-3 pt-2">
                <button
                    type="submit"
                    :disabled="submitting"
                    class="rounded-lg bg-indigo-600 px-6 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50 cursor-pointer"
                >
                    {{ submitting ? 'Saving...' : isEditMode ? 'Save Changes' : 'Create User' }}
                </button>
                <router-link
                    :to="userId ? `/users/${userId}` : '/users'"
                    class="rounded-lg border border-zinc-700 px-6 py-2.5 text-sm font-semibold text-zinc-300 transition-colors hover:bg-zinc-800"
                >
                    Cancel
                </router-link>
            </div>
        </form>
    </div>
</template>
