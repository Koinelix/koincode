import { $getRoot, $getSelection, $isRangeSelection } from "lexical";
import { isRemoteHostCommandContext } from "@fcode/shared";
import { $getPromptSelectionMarkdown } from "../mentions/promptSerialization.js";

/** Read a cloned selection so literal context includes preceding paragraphs and mention nodes. */
export function $isRemoteHostCommandContext(): boolean {
  const selection = $getSelection();
  if (!$isRangeSelection(selection) || !selection.isCollapsed()) return false;
  const prefix = selection.clone();
  prefix.anchor.set($getRoot().getKey(), 0, "element");
  return isRemoteHostCommandContext($getPromptSelectionMarkdown(prefix));
}
