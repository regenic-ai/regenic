import type { ConnectorFieldOption } from "./types.ts";

export interface ConnectorOptionsPage {
  options: ConnectorFieldOption[];
  next_cursor?: string;
}

export interface ConnectorOptionPages {
  requestKey: string;
  cursor?: string;
  page: ConnectorOptionsPage;
}

export function connectorOptionPagesForRequest(
  state: ConnectorOptionPages,
  requestKey: string,
): ConnectorOptionPages {
  return state.requestKey === requestKey ? state : { requestKey, page: { options: [] } };
}

export function appendConnectorOptionsPage(
  state: ConnectorOptionPages,
  requestKey: string,
  cursor: string | undefined,
  page: ConnectorOptionsPage,
): ConnectorOptionPages {
  if (state.requestKey !== requestKey || state.cursor !== cursor) return state;
  const options = cursor ? [...state.page.options, ...page.options] : page.options;
  return {
    ...state,
    page: { ...page, options: [...new Map(options.map((option) => [option.value, option])).values()] },
  };
}
