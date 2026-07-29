/// <reference types="vite/client" />

declare global {
  interface SpeechRecognitionAlternative { readonly transcript: string }
  interface SpeechRecognitionResult { readonly length: number; readonly [index: number]: SpeechRecognitionAlternative }
  interface SpeechRecognitionResultList { readonly length: number; readonly [index: number]: SpeechRecognitionResult }
  interface SpeechRecognitionEvent extends Event { readonly results: SpeechRecognitionResultList }
  interface SpeechRecognitionErrorEvent extends Event { readonly error: string }
  interface SpeechRecognition extends EventTarget {
    interimResults: boolean;
    continuous: boolean;
    lang: string;
    onresult: ((event: SpeechRecognitionEvent) => void) | null;
    onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
    onend: (() => void) | null;
    start(): void;
    stop(): void;
  }
  interface SpeechRecognitionConstructor { new (): SpeechRecognition }
  interface Window {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
    turnstile?: {
      render: (selector: string, config: Record<string, unknown>) => string;
      reset: (widgetId: string) => void;
      remove: (widgetId: string) => void;
    };
    /**
     * AdSense's command queue. Typed as the array it starts life as — pushing
     * before adsbygoogle.js loads is the documented way to enqueue a slot, and
     * the object the script swaps in keeps the same push signature.
     */
    adsbygoogle?: Record<string, unknown>[];
  }
}
export {};
