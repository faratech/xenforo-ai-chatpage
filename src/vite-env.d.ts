/// <reference types="vite/client" />

declare global {
  interface SpeechRecognitionAlternative { readonly transcript: string }
  interface SpeechRecognitionResult { readonly length: number; readonly [index: number]: SpeechRecognitionAlternative }
  interface SpeechRecognitionResultList { readonly length: number; readonly [index: number]: SpeechRecognitionResult }
  interface SpeechRecognitionEvent extends Event { readonly results: SpeechRecognitionResultList }
  interface SpeechRecognitionErrorEvent extends Event { readonly error: string }
  interface SpeechRecognition extends EventTarget {
    interimResults: boolean;
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
    };
  }
}
export {};
