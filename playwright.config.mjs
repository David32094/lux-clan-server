import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir:'./tests/e2e',
  timeout:30_000,
  expect:{ timeout:8_000 },
  fullyParallel:false,
  retries:process.env.CI ? 1 : 0,
  reporter:[['list'], ['html', { open:'never' }]],
  use:{
    baseURL:'http://127.0.0.1:4173',
    channel: process.env.CI ? undefined : 'chrome',
    trace:'retain-on-failure',
    screenshot:'only-on-failure',
    serviceWorkers:'block'
  },
  projects:[
    { name:'chromium-desktop', use:{ ...devices['Desktop Chrome'] } },
    { name:'iphone', use:{ ...devices['iPhone 13'], browserName:'chromium' } },
    { name:'android', use:{ ...devices['Pixel 7'], browserName:'chromium' } }
  ],
  webServer:{ command:'node tests/server.mjs', url:'http://127.0.0.1:4173', reuseExistingServer:true, timeout:15_000 }
});
