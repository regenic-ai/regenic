import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  configWithOptionNames,
  conversationNameFromOptionLabel,
  filterCatalogChatOptions,
} from "../src/renderer/src/connector-config.ts";

describe("configWithOptionNames", () => {
  const fields = [
    {
      key: "chat_ids",
      options: [
        { value: "oc_1", label: "Group · 合伙" },
        { value: "oc_2", label: "Direct · 李诗婷" },
        { value: "oc_3", label: "Group · oc_3" },
      ],
    },
  ];

  it("writes chat_names from picked option labels", () => {
    assert.deepEqual(
      configWithOptionNames({ selection: "pick", chat_ids: "oc_1,oc_2" }, fields),
      {
        selection: "pick",
        chat_ids: "oc_1,oc_2",
        chat_names: "合伙,李诗婷",
      },
    );
  });

  it("drops stale chat_names when a label is still the raw id", () => {
    assert.deepEqual(
      configWithOptionNames(
        { chat_ids: "oc_1,oc_3", chat_names: "old,names" },
        fields,
      ),
      { chat_ids: "oc_1,oc_3" },
    );
  });
});

describe("conversationNameFromOptionLabel", () => {
  it("strips the catalog kind prefix", () => {
    assert.equal(conversationNameFromOptionLabel("Group · 合伙", "oc_1"), "合伙");
    assert.equal(
      conversationNameFromOptionLabel("Direct · 李诗婷", "oc_2"),
      "李诗婷",
    );
    assert.equal(conversationNameFromOptionLabel("单聊 · Ada", "oc_3"), "Ada");
    assert.equal(conversationNameFromOptionLabel("Group · oc_1", "oc_1"), "");
  });
});

describe("filterCatalogChatOptions", () => {
  const options = [
    { value: "oc_g", label: "Group · Eng" },
    { value: "oc_p", label: "Direct · Ada" },
  ];

  it("filters picked chats by kinds", () => {
    assert.deepEqual(
      filterCatalogChatOptions("chat_ids", options, {
        selection: "pick",
        kinds: "group",
      }),
      [options[0]],
    );
    assert.deepEqual(
      filterCatalogChatOptions("chat_ids", options, {
        selection: "pick",
        kinds: "p2p",
      }),
      [options[1]],
    );
  });

  it("keeps all chats when both kinds are selected", () => {
    assert.deepEqual(
      filterCatalogChatOptions("chat_ids", options, {
        selection: "pick",
        kinds: "group,p2p",
      }),
      options,
    );
  });
});
