export interface SelectionCopyFeedback {
  onCopied: () => void;
  onError: () => void;
}

export function installSelectionCopy(_feedback: SelectionCopyFeedback): () => void {
  return () => {};
}
