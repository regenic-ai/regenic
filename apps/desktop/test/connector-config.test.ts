import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  catalogFieldUsesSelect,
  configWithOptionNames,
  filterCatalogFieldOptions,
  optionTitle,
  resolveCatalogFieldOptions,
} from "../src/renderer/src/connector-config.ts";

describe("configWithOptionNames", () => {
  const fields = [
    {
      key: "chat_ids",
      option_labels_key: "chat_names",
      options: [
        { value: "oc_1", label: "Group · 合伙", kind: "group", title: "合伙" },
        { value: "oc_2", label: "Direct · 李诗婷", kind: "p2p", title: "李诗婷" },
        { value: "oc_3", label: "Group · oc_3", kind: "group", title: "oc_3" },
      ],
    },
  ];

  it("writes option labels from catalog titles", () => {
    assert.deepEqual(
      configWithOptionNames({ selection: "pick", chat_ids: "oc_1,oc_2" }, fields),
      {
        selection: "pick",
        chat_ids: "oc_1,oc_2",
        chat_names: "合伙,李诗婷",
      },
    );
  });

  it("drops stale labels when a title is still the raw id", () => {
    assert.deepEqual(
      configWithOptionNames(
        { chat_ids: "oc_1,oc_3", chat_names: "old,names" },
        fields,
      ),
      { chat_ids: "oc_1,oc_3" },
    );
  });
});

describe("optionTitle", () => {
  it("uses the connector-supplied title", () => {
    assert.equal(
      optionTitle({ value: "oc_1", label: "Group · 合伙", title: "合伙" }),
      "合伙",
    );
    assert.equal(
      optionTitle({ value: "oc_1", label: "Group · oc_1", title: "oc_1" }),
      "",
    );
  });
});

describe("filterCatalogFieldOptions", () => {
  const field = { filter_options_by: "kinds" };
  const options = [
    { value: "oc_g", label: "Group · Eng", kind: "group", title: "Eng" },
    { value: "oc_p", label: "Direct · Ada", kind: "p2p", title: "Ada" },
  ];

  it("filters options by another catalog field", () => {
    assert.deepEqual(
      filterCatalogFieldOptions(field, options, { kinds: "group" }),
      [options[0]],
    );
    assert.deepEqual(
      filterCatalogFieldOptions(field, options, { kinds: "p2p" }),
      [options[1]],
    );
  });

  it("keeps every option when all kinds are selected", () => {
    assert.deepEqual(
      filterCatalogFieldOptions(field, options, { kinds: "group,p2p" }),
      options,
    );
  });
});

describe("resolveCatalogFieldOptions", () => {
  it("leaves free-text fields without options so the form stays an input", () => {
    assert.equal(
      resolveCatalogFieldOptions({ key: "base_url" }, undefined, undefined, {}),
      undefined,
    );
    assert.equal(catalogFieldUsesSelect(undefined), false);
    assert.equal(catalogFieldUsesSelect([]), false);
  });

  it("keeps declared or remote option lists for selects", () => {
    const field = { key: "chat_ids", filter_options_by: "kinds" };
    const options = [
      { value: "oc_1", label: "Group · Eng", kind: "group", title: "Eng" },
    ];
    assert.deepEqual(
      resolveCatalogFieldOptions(field, options, undefined, {
        kinds: "group,p2p",
      }),
      options,
    );
    assert.deepEqual(
      resolveCatalogFieldOptions(field, undefined, options, {
        kinds: "group,p2p",
      }),
      options,
    );
    assert.equal(catalogFieldUsesSelect(options), true);
  });
});
