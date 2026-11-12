/**
 * Temporary hard-coded group code, chosen by Jon. A GROUP_CODE Secret overrides it.
 * ADMIN_CODE and SESSION_SECRET are still required Secrets.
 *
 * Lives here, not in worker/index.ts: the Workers runtime treats every non-function
 * export of the entry file as an entrypoint and refuses to start on a string export.
 */
export const DEFAULT_GROUP_CODE = 'password';
