import { t, type MessageKey } from "../../shared/i18n.ts";
import { KernelRequestError } from "./kernel-request.ts";

const ERROR_COPY: Record<string, MessageKey> = {
  already_installed: "error.connector.alreadyInstalled",
  disabled: "error.connector.disabled",
  channel_required: "error.connector.slackChannel",
  conversation_required: "error.connector.feishuConversation",
  kinds_required: "error.connector.feishuKinds",
};

export function connectorActionError(error: unknown): string {
  const code = kernelErrorCode(error);
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (code && ERROR_COPY[code]) {
    return t(ERROR_COPY[code]);
  }
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

function kernelErrorCode(error: unknown): string | undefined {
  if (error instanceof KernelRequestError) {
    return error.code;
  }
  if (typeof error === "string") {
    return undefined;
  }
  return undefined;
}
