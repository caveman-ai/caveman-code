"use client";

import * as React from "react";
import { Button } from "./button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./dialog";

/**
 * ConfirmDialog — the deck's replacement for `window.confirm`. One question,
 * one sentence saying what happens, one destructive-or-not action. The
 * description states the consequence, never what the feature is.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  destructive = false,
  confirmDisabled = false,
  onConfirm,
  onCloseAutoFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  /** The action waits: what the description will say has not arrived yet. Cancel always works. */
  confirmDisabled?: boolean;
  onConfirm: () => void;
  /** Where focus goes as it closes (Radix's onCloseAutoFocus); by default back to what opened it. */
  onCloseAutoFocus?: ((event: Event) => void) | undefined;
}) {
  const openerRef = React.useRef<HTMLElement | null>(null);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size="sm"
        // A confirmation: the app's shortcuts wait while focus is in it (apps/web shell/confirmation-keys.ts).
        data-confirmation=""
        onOpenAutoFocus={() => {
          // There is no DialogTrigger: remember the external opener before Radix moves focus.
          const activeElement = document.activeElement;
          // A menu item disappears when its menu closes. Return to the menu's trigger instead.
          const menu = activeElement?.closest('[role="menu"]');
          const trigger = menu?.getAttribute("aria-labelledby")?.split(/\s+/)
            .map((id) => document.getElementById(id))
            .find((el) => el instanceof HTMLElement && el.getAttribute("aria-haspopup") === "menu");
          openerRef.current = trigger instanceof HTMLElement ? trigger : activeElement instanceof HTMLElement ? activeElement : null;
        }}
        onCloseAutoFocus={onCloseAutoFocus ?? ((event) => {
          event.preventDefault();
          if (openerRef.current?.isConnected) openerRef.current.focus();
        })}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            {cancelLabel}
          </Button>
          <Button
            size="sm"
            variant={destructive ? "destructive" : "default"}
            disabled={confirmDisabled}
            onClick={() => {
              onOpenChange(false);
              onConfirm();
            }}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
