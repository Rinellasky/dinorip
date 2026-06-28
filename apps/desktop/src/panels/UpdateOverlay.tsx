import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type { PointerEvent as ReactPointerEvent, ReactElement } from "react";
import { ExternalLink, X } from "lucide-react";
import type { UpdateState } from "@dinorip/ipc-contracts";

interface UpdateIndicatorProps {
  state: UpdateState;
  onOpen(): void;
}

interface UpdateModalProps {
  state: UpdateState;
  onClose(): void;
  onPrimaryAction(): void;
}

export function getUpdateVersion(state: UpdateState | null): string | null {
  return state?.availableVersion ?? null;
}

export function isUpdateActionable(state: UpdateState | null): state is UpdateState {
  if (!state || !state.enabled) return false;
  return state.status === "available";
}

export function shouldShowUpdateModal(state: UpdateState | null, dismissedVersion: string | null): state is UpdateState {
  if (!isUpdateActionable(state)) return false;
  const version = getUpdateVersion(state);
  return version !== null && version !== dismissedVersion;
}

export function UpdateIndicator({ state, onOpen }: UpdateIndicatorProps): ReactElement {
  return (
    <button
      type="button"
      className="update-pill"
      onClick={onOpen}
      title={getIndicatorTitle(state)}
      aria-label={getIndicatorTitle(state)}
    >
      <span className="update-pill__dot" aria-hidden="true" />
      <span className="update-pill__label">{getIndicatorLabel(state)}</span>
    </button>
  );
}

export function UpdateModal({ state, onClose, onPrimaryAction }: UpdateModalProps): ReactElement {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const onCancel = (event: Event) => {
      event.preventDefault();
      onCloseRef.current();
    };
    dialog.addEventListener("cancel", onCancel);
    if (!dialog.open) dialog.showModal();
    return () => {
      dialog.removeEventListener("cancel", onCancel);
      if (dialog.open) dialog.close();
    };
  }, []);

  const closeFromBackdrop = (event: ReactPointerEvent<HTMLDialogElement>) => {
    if (event.target === event.currentTarget) onClose();
  };

  return createPortal(
    <dialog ref={dialogRef} className="shortcuts-overlay update-overlay" aria-label="DinoRip update" onPointerDown={closeFromBackdrop}>
      <div className="update-modal">
        <header className="shortcuts-modal__header">
          <h2>{getModalTitle(state)}</h2>
          <span className="shortcuts-modal__hint">{getVersionHint(state)}</span>
          <button
            type="button"
            className="shortcuts-modal__close"
            onClick={onClose}
            aria-label="Close update dialog"
          >
            <X size={14} />
          </button>
        </header>
        <div className="update-modal__body">
          <p className="update-modal__lead">{getLeadCopy(state)}</p>
          <p className="update-modal__notes">{getSecondaryCopy(state)}</p>
          {state.message && state.status === "error" ? (
            <p className="update-modal__error">{state.message}</p>
          ) : null}
        </div>
        {state.status !== "error" ? (
          <footer className="update-modal__footer">
            <button
              type="button"
              className="update-cta"
              data-status={state.status}
              onClick={onPrimaryAction}
            >
              <span className="update-cta__label">
                <ExternalLink size={14} />
                Open Download Page
              </span>
            </button>
          </footer>
        ) : null}
      </div>
    </dialog>,
    document.body
  );
}

function getModalTitle(state: UpdateState): string {
  if (state.status === "error") return "Update needs attention";
  return "Update available";
}

function getVersionHint(state: UpdateState): string {
  const version = getUpdateVersion(state);
  return version ? `v${version}` : `v${state.currentVersion}`;
}

function getLeadCopy(state: UpdateState): string {
  const version = getUpdateVersion(state) ?? "the latest version";
  if (state.status === "error") {
    return "DinoRip could not finish checking for updates.";
  }
  return `DinoRip ${version} is available.`;
}

function getSecondaryCopy(state: UpdateState): string {
  if (state.status === "error") {
    return "Check your connection, then use the app menu to check again.";
  }
  return "Open GitHub Releases, download the build for your platform, quit DinoRip, then run the installer.";
}

function getIndicatorLabel(state: UpdateState): string {
  if (state.status === "error") return "Update issue";
  return "Update available";
}

function getIndicatorTitle(state: UpdateState): string {
  const version = getUpdateVersion(state);
  if (state.status === "error") {
    return "DinoRip could not check for updates.";
  }
  return `DinoRip ${version ?? "update"} is available. Open update details.`;
}
