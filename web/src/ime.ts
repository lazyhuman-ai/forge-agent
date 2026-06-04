import { useCallback, useRef } from "react";
import type { CompositionEvent as ReactCompositionEvent, KeyboardEvent as ReactKeyboardEvent } from "react";

const IME_ENTER_SUPPRESSION_MS = 100;

type EnterKeyEvent = {
  key: string;
  shiftKey: boolean;
  nativeEvent: {
    isComposing?: boolean;
    keyCode?: number;
  };
};

export function shouldSubmitOnEnter(
  event: EnterKeyEvent,
  lastCompositionEndAt = 0,
  now = Date.now(),
): boolean {
  if (event.key !== "Enter" || event.shiftKey) return false;
  if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return false;
  return lastCompositionEndAt === 0 || now - lastCompositionEndAt > IME_ENTER_SUPPRESSION_MS;
}

export function useEnterSubmit(handler: () => void) {
  const composingRef = useRef(false);
  const lastCompositionEndAtRef = useRef(0);

  const onCompositionStart = useCallback(() => {
    composingRef.current = true;
  }, []);

  const onCompositionEnd = useCallback((_event: ReactCompositionEvent<HTMLTextAreaElement>) => {
    composingRef.current = false;
    lastCompositionEndAtRef.current = Date.now();
  }, []);

  const onKeyDown = useCallback((event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (composingRef.current) return;
    if (!shouldSubmitOnEnter(event, lastCompositionEndAtRef.current)) return;
    event.preventDefault();
    handler();
  }, [handler]);

  return {
    onCompositionStart,
    onCompositionEnd,
    onKeyDown,
  };
}
