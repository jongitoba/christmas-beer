/**
 * Temporary hard-coded placeholder codes, chosen by Jon. A GROUP_CODE or ADMIN_CODE
 * Secret overrides each one. SESSION_SECRET is still a required Secret.
 *
 * Lives here, not in worker/index.ts: the Workers runtime treats every non-function
 * export of the entry file as an entrypoint and refuses to start on a string export.
 */
export const DEFAULT_GROUP_CODE = 'password';
export const DEFAULT_ADMIN_CODE = 'password-admin';

/**
 * People listed to choose from when a new year's tasting is created.
 * Only used once per year: deleting someone in admin does not bring them back,
 * and anyone not listed can still add their own name.
 */
export const DEFAULT_PARTICIPANTS: readonly string[] = [
  'John', 'Barstad', 'Mange', 'Voldæn', 'Ælen', 'Scott', 'Morten', 'Veronika', 'Kristina', 'Elise', 'Johan', 'Joakim',
];
