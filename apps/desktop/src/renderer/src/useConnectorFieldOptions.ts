import { useEffect, useState } from "react";
import { fetchCatalogOptionsPage } from "./api";
import { appendConnectorOptionsPage, connectorOptionPagesForRequest, type ConnectorOptionPages } from "./connector-option-pages";
import type { ConnectorFormValues } from "./connector-form";
import type { ConnectorField, ConnectorFieldOption } from "./types";

interface ConnectorFieldOptionsState extends ConnectorOptionPages {
  pending: boolean;
  error: boolean;
  attempt: number;
}

export function useConnectorFieldOptions(
  connectorType: string,
  field: ConnectorField,
  values: ConnectorFormValues,
  enabled: boolean,
  onOptions: (key: string, options: ConnectorFieldOption[]) => void,
) {
  const [query, setQuery] = useState("");
  const dependencies = JSON.stringify(Object.fromEntries((field.options_depends_on ?? [])
    .map((key) => [key, values[key]])));
  const requestKey = JSON.stringify([connectorType, field.key, query, dependencies]);
  const [state, setState] = useState<ConnectorFieldOptionsState>(() => ({
    requestKey, page: { options: [] },
    pending: false, error: false, attempt: 0,
  }));
  const scoped = connectorOptionPagesForRequest(state, requestKey);
  const cursor = scoped.cursor;
  useEffect(() => {
    if (!field.dynamic_options || !enabled) return;
    const abort = new AbortController();
    setState((current) => ({
      ...connectorOptionPagesForRequest(current, requestKey),
      attempt: current.attempt, pending: true, error: false,
    }));
    const timer = setTimeout(() => {
      void fetchCatalogOptionsPage(connectorType, {
        field: field.key, query, cursor, values: JSON.parse(dependencies),
      }, AbortSignal.any([abort.signal, AbortSignal.timeout(15_000)]))
        .then((page) => {
          if (abort.signal.aborted) return;
          setState((current) => ({ ...current, ...appendConnectorOptionsPage(current, requestKey, cursor, page) }));
          onOptions(field.key, page.options);
        })
        .catch(() => { if (!abort.signal.aborted) setState((current) => ({ ...current, error: true })); })
        .finally(() => { if (!abort.signal.aborted) setState((current) => ({ ...current, pending: false })); });
    }, 250);
    return () => { clearTimeout(timer); abort.abort(); };
  }, [connectorType, field.key, field.dynamic_options, enabled, query, dependencies, requestKey, cursor, state.attempt, onOptions]);
  return {
    query,
    setQuery,
    page: scoped.page,
    pending: field.dynamic_options && enabled && (state.requestKey !== requestKey || state.pending),
    error: state.requestKey === requestKey && state.error,
    retry: () => setState((current) => ({
      ...current, requestKey, cursor: undefined, page: { options: [] },
      error: false, pending: true, attempt: current.attempt + 1,
    })),
    loadMore: () => {
      if (!scoped.page.next_cursor || state.pending || !enabled) return;
      setState((current) => ({ ...current, cursor: scoped.page.next_cursor, pending: true }));
    },
  };
}
