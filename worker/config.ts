/**
 * Constants for the Worker. They live here, not in worker/index.ts: the Workers runtime
 * treats every non-function export of the entry file as an entrypoint and refuses to
 * start on a non-function export.
 *
 * The login codes are NOT here: GROUP_CODE and ADMIN_CODE are Cloudflare Secrets.
 */

/**
 * People listed to choose from when a new year's tasting is created.
 * Only used once per year: deleting someone in admin does not bring them back,
 * and anyone not listed can still add their own name.
 */
export const DEFAULT_PARTICIPANTS: readonly string[] = [
  'John', 'Barstad', 'Mange', 'Voldæn', 'Ælen', 'Scott', 'Morten', 'Veronika', 'Kristina', 'Elise', 'Johan', 'Joakim',
];
