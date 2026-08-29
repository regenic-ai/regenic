export type EditRole = "cut" | "copy" | "paste" | "selectAll";

export function editContextRoles(input: {
  isEditable: boolean;
  selectionText?: string;
  canCut?: boolean;
  canCopy?: boolean;
  canPaste?: boolean;
  canSelectAll?: boolean;
}): EditRole[] {
  if (input.isEditable) {
    const roles: EditRole[] = [];
    if (input.canCut) {
      roles.push("cut");
    }
    if (input.canCopy) {
      roles.push("copy");
    }
    if (input.canPaste) {
      roles.push("paste");
    }
    if (input.canSelectAll) {
      roles.push("selectAll");
    }
    return roles;
  }
  if ((input.selectionText ?? "").trim()) {
    return ["copy"];
  }
  return [];
}
