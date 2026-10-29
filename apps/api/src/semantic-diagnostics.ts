export function semanticIssue(code: string | undefined) {
  switch (code) {
    case "unavailable": return "provider_unavailable";
    case "timeout": return "timeout";
    case "invalid_input": return "input_invalid";
    case "input_too_large": return "input_too_large";
    case "model_mismatch": return "model_mismatch";
    case "invalid_response": return "invalid_response";
    default: return "indexing_failed";
  }
}
