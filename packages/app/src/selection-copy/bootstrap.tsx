import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "@/contexts/toast-context";
import { installSelectionCopy } from "./install";

export function SelectionCopyBootstrap() {
  const toast = useToast();
  const { t } = useTranslation();
  const feedback = useRef({ toast, t });
  useEffect(() => {
    feedback.current = { toast, t };
  }, [toast, t]);
  // Install once: reinstalling mid-gesture would drop the controller's click guard.
  useEffect(
    () =>
      installSelectionCopy({
        onCopied: () => feedback.current.toast.copied(),
        onError: () =>
          feedback.current.toast.error(feedback.current.t("workspace.tabs.toasts.copyFailed")),
      }),
    [],
  );
  return null;
}
