import { useId, useState } from "react";
import { pickDirectory } from "./api";
import { splitValues } from "./connector-config";
import { connectorFieldInvalid, type ConnectorFormValues } from "./connector-form";
import { useLocale } from "./LocaleContext";
import { InfoTip } from "./InfoTip";
import type { ConnectorField, ConnectorFieldOption } from "./types";
import { useConnectorFieldOptions } from "./useConnectorFieldOptions";

export function ConnectorFormFields({
  connectorType, fields, values, credentials, busy, loading, optionsEnabled,
  onChange, onOptions,
}: {
  connectorType: string;
  fields: ConnectorField[];
  values: ConnectorFormValues;
  credentials: Record<string, boolean>;
  busy: boolean;
  loading: boolean;
  optionsEnabled: boolean;
  onChange: (key: string, value: unknown) => void;
  onOptions: (key: string, options: ConnectorFieldOption[]) => void;
}) {
  const { t } = useLocale();
  const groups: Array<{ label?: string; advanced: boolean; fields: ConnectorField[] }> = [];
  for (const field of fields) {
    let group = groups.find((group) => group.label === field.group && group.advanced === Boolean(field.advanced));
    if (!group) {
      group = { label: field.group, advanced: Boolean(field.advanced), fields: [] };
      groups.push(group);
    }
    group.fields.push(field);
  }
  groups.sort((a, b) => Number(a.advanced) - Number(b.advanced));
  return <fieldset disabled={busy} className="connector-form-fields">
    {groups.map((group) => {
      const body = group.fields.map((field) => <ConnectorFormField
        key={field.key} field={field} value={values[field.key]}
        connectorType={connectorType} values={values} saved={credentials[field.key] === true}
        loading={loading} enabled={!busy && optionsEnabled} onChange={onChange} onOptions={onOptions}
      />);
      return group.advanced ? <details key={`advanced:${group.label ?? ""}`} className="connector-field-group">
        <summary>{group.label ?? t("connector.advanced")}</summary>{body}
      </details> : <div key={`basic:${group.label ?? ""}`} className="connector-field-group">
        {group.label ? <h3>{group.label}</h3> : null}{body}
      </div>;
    })}
  </fieldset>;
}

function ConnectorFormField({
  field, value, saved, connectorType, values, loading, enabled, onChange, onOptions,
}: {
  field: ConnectorField; value: unknown; saved: boolean;
  connectorType: string; values: ConnectorFormValues; loading: boolean;
  enabled: boolean;
  onChange: (key: string, value: unknown) => void;
  onOptions: (key: string, options: ConnectorFieldOption[]) => void;
}) {
  const { t } = useLocale();
  const id = useId();
  const [actionError, setActionError] = useState<string>();
  const secret = field.secret || field.widget === "password";
  const multiple = field.multiple || field.type === "string_array" || field.widget === "multi_select";
  const text = typeof value === "string" ? value : "";
  const options = field.options ?? [];
  const change = (value: unknown) => onChange(field.key, value);
  const invalid = connectorFieldInvalid(field, value);
  const helpId = field.description ? `${id}-help` : undefined;
  let body;
  if (multiple || field.dynamic_options) {
    body = <ConnectorOptionsField
      connectorType={connectorType} field={field} values={values} multiple={Boolean(multiple)}
      descriptionId={helpId}
      loading={loading} enabled={enabled} onChange={change} onOptions={onOptions}
    />;
  } else if (field.type === "boolean" || field.widget === "switch") {
    body = <input id={id} type="checkbox" aria-describedby={helpId}
      checked={value === true} onChange={(event) => change(event.target.checked)} />;
  } else if (field.type === "number" || field.widget === "number") {
    body = <input id={id} type="number" step="any" min={field.min} max={field.max} required={field.required}
      aria-describedby={helpId} aria-invalid={invalid} value={typeof value === "number" ? value : ""}
      onChange={(event) => change(event.target.value === "" ? undefined : event.target.valueAsNumber)} />;
  } else if (!secret && !field.allow_custom && (field.widget === "select" || (!field.widget && options.length))) {
    const choices = text && !options.some((item) => item.value === text)
      ? [{ value: text, label: text }, ...options] : options;
    body = <select id={id} value={text} required={field.required} aria-describedby={helpId}
      onChange={(event) => change(event.target.value)}>
      {!text ? <option value="">{field.placeholder ?? t("connector.chooseOption")}</option> : null}
      {choices.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
    </select>;
  } else {
    const input = <input id={id} type={secret ? "password" : "text"} value={text}
      placeholder={field.placeholder} required={field.required && !(secret && saved && value !== null)}
      list={!secret && field.allow_custom ? `${id}-options` : undefined}
      autoComplete={secret ? "new-password" : undefined} aria-describedby={helpId}
      onChange={(event) => change(event.target.value)} />;
    body = field.widget === "directory" ? <span className="directory-field">{input}
      <button type="button" className="ghost" onClick={() => {
        setActionError(undefined);
        void pickDirectory().then((picked) => { if (picked) change(picked); })
          .catch((error: unknown) => setActionError(error instanceof Error ? error.message : t("connector.directoryFailed")));
      }}>{t("connector.chooseDirectory")}</button>
    </span> : <>{input}
      {!secret && field.allow_custom ? <datalist id={`${id}-options`}>
        {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </datalist> : null}
    </>;
  }
  return <div className="field">
    <span className="settings-label">
      {multiple || field.dynamic_options ? <span>{field.label}{field.required ? " *" : ""}</span>
        : <label htmlFor={id}>{field.label}{field.required ? " *" : ""}</label>}
      {field.description ? <InfoTip label={field.label} id={helpId}>{field.description}</InfoTip> : null}
    </span>
    {body}
    {secret ? <div className="credential-actions">
      <span className="muted">{t(value === null ? "connector.credentialClearing"
        : saved ? "connector.credentialSaved" : "connector.credentialNotSet")}</span>
      {saved ? <button type="button" className="ghost" onClick={() => change(value === null ? undefined : null)}>
        {t(value === null ? "connector.keepCredential" : "connector.clearCredential")}
      </button> : null}
    </div> : null}
    {invalid ? <span className="action-error" role="alert">{t("connector.invalidFields")}</span> : null}
    {actionError ? <span className="action-error" role="alert">{actionError}</span> : null}
  </div>;
}

function ConnectorOptionsField({
  connectorType, field, values, multiple, loading, enabled, descriptionId, onChange, onOptions,
}: {
  connectorType: string; field: ConnectorField; values: ConnectorFormValues;
  multiple: boolean; loading: boolean; onChange: (value: unknown) => void;
  enabled: boolean;
  descriptionId?: string;
  onOptions: (key: string, options: ConnectorFieldOption[]) => void;
}) {
  const { t } = useLocale();
  const [customValue, setCustomValue] = useState("");
  const { query, setQuery, page, pending, error, retry, loadMore } =
    useConnectorFieldOptions(connectorType, field, values, enabled, onOptions);
  const value = values[field.key];
  const selected = multiple ? splitValues(value)
    : typeof value === "string" && value ? [value] : [];
  const source = field.dynamic_options ? page.options : field.options ?? [];
  const visible = field.dynamic_options ? source : source.filter((item) =>
    `${item.label} ${item.value}`.toLowerCase().includes(query.trim().toLowerCase()));
  const missing = selected.filter((value) => !visible.some((item) => item.value === value))
    .map((value) => field.options?.find((item) => item.value === value) ?? { value, label: value });
  const options = [...missing, ...visible];
  const nextCursor = page.next_cursor;
  const custom = customValue.trim();
  const customDisabled = field.dynamic_options && !enabled;
  const addCustom = () => {
    if (!custom || selected.includes(custom) || customDisabled) return;
    const option = field.options?.find((item) => item.value === custom) ??
      page.options.find((item) => item.value === custom) ?? { value: custom, label: custom, title: custom };
    onOptions(field.key, [option]);
    const next = [...selected, custom];
    onChange(multiple ? field.type === "string_array" ? next : next.join(",") : custom);
    setCustomValue("");
  };
  return <div className="check-options" role="group" aria-label={field.label} aria-describedby={descriptionId}>
    {field.allow_custom ? <div className="connector-custom-value">
      <input type="text" value={customValue} disabled={customDisabled}
        aria-label={t("connector.customValue", { label: field.label })}
        placeholder={t("connector.customValue", { label: field.label })}
        onChange={(event) => setCustomValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.nativeEvent.isComposing) {
            event.preventDefault();
            addCustom();
          }
        }} />
      <button type="button" className="ghost" disabled={!custom || selected.includes(custom) || customDisabled}
        onClick={addCustom}>{t("connector.addValue")}</button>
    </div> : null}
    {field.dynamic_options || source.length > 4 ? <input type="search" value={query}
      aria-label={t("connector.search", { label: field.label })}
      placeholder={t("connector.search", { label: field.label })}
      onChange={(event) => setQuery(event.target.value)}
      onKeyDown={(event) => { if (event.key === "Enter") event.preventDefault(); }} /> : null}
    {pending || loading ? <p className="field-empty" role="status">{t("connector.loadingOptions")}</p> : null}
    {error ? <div className="action-error" role="alert">{t("connector.optionsFailed")}{" "}
      <button type="button" className="ghost" onClick={retry}>{t("connector.retryOptions")}</button>
    </div> : null}
    {!options.length && !pending && !loading && !error ? <p className="field-empty">
      {t(query ? "connector.noMatches" : "connector.noOptions")}
    </p> : null}
    <ul className="check-list" aria-label={field.label}>
      {options.map((option) => <li key={option.value}>
        <label className={`check-item${selected.includes(option.value) ? " active" : ""}`}>
          <input type={multiple ? "checkbox" : "radio"} name={field.key} disabled={pending || (field.dynamic_options && !enabled)}
            checked={selected.includes(option.value)} onChange={() => {
              if (!multiple) { onChange(option.value); return; }
              const next = selected.includes(option.value) ? selected.filter((id) => id !== option.value) : [...selected, option.value];
              onChange(field.type === "string_array" ? next : next.join(","));
            }} />
          <span>{option.label}</span>
        </label>
      </li>)}
    </ul>
    {field.dynamic_options && nextCursor ? <button type="button" className="ghost" disabled={pending || !enabled}
      onClick={loadMore}>{t("connector.moreOptions")}</button> : null}
  </div>;
}
