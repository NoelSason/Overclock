// HOLDOUT FIXTURE — engine/prompt developers must not read this file.

/** Identity of the fourth (holdout) application. Shared arena code imports these by reference. */

export const HOLDOUT_APP = "Rimewell" as const;
export type HoldoutApp = typeof HOLDOUT_APP;

export const HOLDOUT_DISPLAY_NAME = "Rimewell Sample Registry";
export const HOLDOUT_DEFAULT_PORT = 4104;
export const HOLDOUT_PORT_ENV = "OVERCLOCK_ARENA_APP4_PORT";
export const HOLDOUT_DB_FILE = "rimewell.db";

/** The button the "rename-save" judge surprise renames. */
export const HOLDOUT_SAVE_RENAME = { from: "Apply change", to: "Commit change" } as const;
