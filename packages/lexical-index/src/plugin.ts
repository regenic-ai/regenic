import { definePlugin } from "@regenic/plugin-host";
import { SqliteContextLexicalIndex } from "./sqlite-context-lexical-index";

export interface SqliteContextLexicalIndexPluginConfig {
  path: string;
}

export const sqliteContextLexicalIndexPlugin = definePlugin<SqliteContextLexicalIndexPluginConfig>({
  name: "context-lexical-index-sqlite",
  apply(ctx, config) {
    const index = new SqliteContextLexicalIndex(config.path);
    ctx.provide("context-lexical-index", index);
    ctx.effect(() => () => index.close());
  },
});
