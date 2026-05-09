import { defineConfig } from 'vite';

export default defineConfig({
    clearScreen: false,
    server: {
        port: 1420,
        strictPort: true,
    },
    envPrefix: ['VITE_', 'TAURI_'],
    build: {
        target: ['es2021', 'chrome100', 'safari13'],
        minify: !process.env.TAURI_DEBUG ? 'esbuild' : false,
        sourcemap: !!process.env.TAURI_DEBUG,
        chunkSizeWarningLimit: 1200,
        rollupOptions: {
            output: {
                manualChunks(id) {
                    if (id.includes('node_modules/@tauri-apps')) return 'tauri';
                    if (id.includes('node_modules')) return 'vendor';
                    if (
                        id.includes('src/json-viewer.js') ||
                        id.includes('src/csv-viewer.js') ||
                        id.includes('src/data-analyzer.js')
                    ) {
                        return 'investigation';
                    }
                },
            },
        },
    },
});
