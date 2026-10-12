import { defineConfig, devices } from '@playwright/test';

const PORT = process.env.E2E_PORT || '8098';
const baseURL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
    testDir: './specs',
    timeout: 30_000,
    expect: { timeout: 5_000 },
    fullyParallel: true,
    workers: process.env.CI ? 2 : undefined,
    retries: process.env.CI ? 1 : 0,
    reporter: process.env.CI ? [['list'], ['github']] : 'list',
    use: {
        baseURL,
        colorScheme: 'dark',
        // The 1710px MacBook display the layout issues were reported on.
        viewport: { width: 1710, height: 1112 },
        trace: 'retain-on-failure',
        ...(process.env.PW_CHROMIUM ? { launchOptions: { executablePath: process.env.PW_CHROMIUM } } : {})
    },
    webServer: {
        command: `node serve.mjs ${PORT}`,
        url: `${baseURL}/index.html`,
        reuseExistingServer: !process.env.CI,
        timeout: 20_000
    },
    projects: [
        { name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1710, height: 1112 } } }
    ]
});
