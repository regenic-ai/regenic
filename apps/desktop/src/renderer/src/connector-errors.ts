import { t } from "../../shared/i18n.ts";

export function connectorActionError(message: string): string {
  const text = message.toLowerCase();
  if (text.includes("already installed")) {
    return t("error.connector.alreadyInstalled");
  }
  if (text.includes("already syncing") || text.includes("already leased")) {
    return t("error.connector.alreadySyncing");
  }
  if (text.includes("is disabled")) {
    return t("error.connector.disabled");
  }
  if (text.includes("missing from")) {
    return t("error.connector.missingEnv");
  }
  if (text.includes("not found")) {
    return t("error.connector.notFound");
  }
  if (text.includes("requires channel_id") || text.includes("missing channel_id")) {
    return t("error.connector.slackChannel");
  }
  if (text.includes("requires session_id")) {
    return t("error.connector.dshSession");
  }
  if (
    text.includes("requires chat_id") ||
    text.includes("at least one group") ||
    text.includes("at least one conversation")
  ) {
    return t("error.connector.feishuConversation");
  }
  if (text.includes("groups, direct messages, or both")) {
    return t("error.connector.feishuKinds");
  }
  return message;
}

export function networkWatchHint(hint: string | null | undefined): string | null {
  if (!hint) {
    return null;
  }
  if (hint.includes("Bypass loopback") || hint.includes("intercepting local traffic")) {
    return t("network.proxyHint");
  }
  if (hint.includes("Local network looks blocked")) {
    return t("network.blockedHint");
  }
  return hint;
}
