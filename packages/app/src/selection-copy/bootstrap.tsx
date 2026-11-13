import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "@/contexts/toast-context";
import { installSelectionCopy } from "./install";

export function SelectionCopyBootstrap() {
  const toast = useToast();
  const { t } = useTranslation();
  useEffect(
    () =>
      installSelectionCopy({
        onCopied: () => toast.copied(),
        onError: () => toast.error(t("workspace.tabs.toasts.copyFailed")),
      }),
    [toast, t],
  );
  return null;
}
