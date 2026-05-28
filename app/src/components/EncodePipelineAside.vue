<template>
    <div class="flex flex-col gap-4" aria-label="Encoding pipeline overview">
        <div
            class="relative overflow-hidden rounded-2xl border border-slate-200/90 bg-gradient-to-br from-sky-100/70 via-slate-50/95 to-slate-100/80 px-5 py-6 shadow-sm ring-1 ring-slate-900/5 dark:border-transparent dark:bg-gradient-to-br dark:from-slate-900 dark:via-slate-900 dark:to-slate-950 dark:text-white dark:shadow-lg dark:shadow-slate-900/25 dark:ring-white/10"
        >
            <svg
                class="pointer-events-none absolute -right-4 -top-4 h-28 w-28 text-sky-300/45 dark:text-white/[0.06]"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                stroke-width="1"
                aria-hidden="true"
            >
                <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    d="M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z"
                />
            </svg>
            <p class="relative text-sm font-semibold text-slate-900 dark:text-slate-100">Encoding workflow</p>
            <p class="relative mt-2 text-xs leading-relaxed text-slate-600 dark:text-slate-400">
                Ingest is resumable (tus) or fetched from a URL. The service probes your media, transcodes to ABR HLS,
                then writes segments and manifests to the prefix you choose — with optional AES-128 and byte-range
                packaging.
            </p>
        </div>

        <div
            class="rounded-2xl border border-slate-200/90 bg-white/90 p-5 shadow-sm ring-1 ring-slate-900/5 backdrop-blur-md dark:border-slate-700 dark:bg-slate-800/60 dark:ring-white/10"
        >
            <h2 class="text-sm font-semibold text-slate-900 dark:text-slate-100">Pipeline preview</h2>
            <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">What happens after you create a session.</p>
            <ol class="mt-4 space-y-4">
                <li class="flex gap-3">
                    <span
                        class="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-400"
                    >
                        <svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                            <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" />
                        </svg>
                    </span>
                    <div>
                        <p class="text-sm font-medium text-slate-900 dark:text-slate-100">Ingest</p>
                        <p class="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                            Upload from disk or let the API download from HTTPS.
                        </p>
                    </div>
                </li>
                <li class="flex gap-3">
                    <span
                        class="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-700 dark:bg-slate-950/50 dark:text-slate-300"
                    >
                        <svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                            <path
                                stroke-linecap="round"
                                stroke-linejoin="round"
                                d="M4.5 12a7.5 7.5 0 0015 0m-15 0a7.5 7.5 0 1115 0m-15 0H3m16.5 0H21m-2.25 0H18"
                            />
                        </svg>
                    </span>
                    <div>
                        <p class="text-sm font-medium text-slate-900 dark:text-slate-100">Analyze &amp; configure</p>
                        <p class="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                            ffprobe-driven track metadata; you confirm renditions on the session page.
                        </p>
                    </div>
                </li>
                <li class="flex gap-3">
                    <span
                        class="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-slate-200 text-slate-600 dark:bg-slate-800 dark:text-slate-400"
                    >
                        <svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                            <path
                                stroke-linecap="round"
                                stroke-linejoin="round"
                                d="M2.25 15a4.5 4.5 0 004.5 4.5H18a3.75 3.75 0 001.332-7.257 3 3 0 00-3.196-5.454.5.5 0 01-.637-.114L9.73 7.63a.75.75 0 01-.365-.263L8.46 5.43a.75.75 0 00-1.138-.086L4.772 7.138a.75.75 0 01-.46.143H2.25z"
                            />
                        </svg>
                    </span>
                    <div>
                        <p class="text-sm font-medium text-slate-900 dark:text-slate-100">Encode &amp; deliver</p>
                        <p class="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                            Queue encodes HLS to your bucket prefix; optional thumbnails and encryption.
                        </p>
                    </div>
                </li>
            </ol>
        </div>

        <div
            class="rounded-2xl border border-slate-200/90 bg-gradient-to-br from-slate-100/90 via-slate-50/95 to-sky-100/50 p-5 shadow-sm ring-1 ring-slate-900/5 dark:border-slate-700 dark:bg-gradient-to-br dark:from-slate-900 dark:via-slate-800 dark:to-slate-950 dark:shadow-md dark:ring-white/10"
        >
            <p class="text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-700 dark:text-slate-300/95">Luminary Media Convert</p>
            <p class="mt-2 text-xs leading-relaxed text-slate-600 dark:text-slate-400">
                ABR HLS output, S3-native delivery, real-time session progress.
            </p>
        </div>
    </div>
</template>
