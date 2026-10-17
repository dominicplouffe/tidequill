/**
 * Web Speech API wrapper. Returns null where speech recognition isn't
 * available, so callers can fall back to typing.
 */

export interface Listener {
  stop(): void;
  abort(): void;
}

export function speechSupported(): boolean {
  return typeof window !== "undefined" && !!((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition);
}

export function listen(opts: { onText: (text: string, final: boolean) => void; onEnd?: (finalText: string) => void; onError?: (message: string) => void; continuous?: boolean; lang?: string }): Listener | null {
  const Ctor = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
  if (!Ctor) return null;
  const rec = new Ctor();
  rec.lang = opts.lang ?? navigator.language ?? "en-US";
  rec.interimResults = true;
  rec.continuous = opts.continuous ?? true;
  let finalText = "";
  rec.onresult = (e: any) => {
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) finalText += r[0].transcript;
      else interim += r[0].transcript;
    }
    opts.onText((finalText + interim).trim(), !interim);
  };
  rec.onerror = (e: any) => {
    const map: Record<string, string> = {
      "not-allowed": "Microphone access is blocked. Allow it in your browser, or type instead.",
      "no-speech": "I didn't hear anything. Try again, a little closer.",
      network: "Speech recognition needs a connection. Type instead.",
    };
    opts.onError?.(map[e.error] ?? "Voice input stopped. You can type instead.");
  };
  rec.onend = () => opts.onEnd?.(finalText.trim());
  try {
    rec.start();
  } catch {
    return null;
  }
  return { stop: () => rec.stop(), abort: () => rec.abort() };
}
