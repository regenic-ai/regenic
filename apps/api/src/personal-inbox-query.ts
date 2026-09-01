/** HTTP query shape shared by GET /v1/me/inbox handlers and connector side effects. */
export type PersonalInboxHttpQuery = {
  thread_id?: string;
  since?: string;
  before?: string;
  heads?: boolean;
  live?: boolean;
};

/** Cold open: first page with no cursor asks the connector to hydrate when SQLite is empty. */
export function shouldHydrateOpenedInbox(
  query: PersonalInboxHttpQuery,
): boolean {
  return Boolean(
    query.thread_id &&
      !query.since &&
      !query.before &&
      !query.heads &&
      !query.live,
  );
}
