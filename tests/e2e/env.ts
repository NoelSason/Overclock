/**
 * E2E endpoints. By default the tests start the test-only replay server (fixtures/) and point the
 * dashboard at it. Set OVERCLOCK_E2E_ENGINE_URL (and optionally OVERCLOCK_E2E_ARENA_URL and
 * OVERCLOCK_E2E_RUN_ID) to run the same test against a real engine instead.
 */
export const EXTERNAL_ENGINE = process.env.OVERCLOCK_E2E_ENGINE_URL;
export const REPLAY_PORT = Number(process.env.OVERCLOCK_E2E_REPLAY_PORT ?? 4010);
export const REPLAY_ARENA_PORT = Number(process.env.OVERCLOCK_E2E_REPLAY_ARENA_PORT ?? 4110);
export const DASHBOARD_PORT = Number(process.env.OVERCLOCK_E2E_DASHBOARD_PORT ?? 3100);
export const ENGINE_URL = (EXTERNAL_ENGINE ?? `http://127.0.0.1:${REPLAY_PORT}`).replace(/\/+$/, "");
export const ARENA_URL = (process.env.OVERCLOCK_E2E_ARENA_URL ?? (EXTERNAL_ENGINE ? "http://127.0.0.1:4100" : `http://127.0.0.1:${REPLAY_ARENA_PORT}`)).replace(/\/+$/, "");
export const DASHBOARD_URL = `http://localhost:${DASHBOARD_PORT}`;
export const RUN_ID = process.env.OVERCLOCK_E2E_RUN_ID;
