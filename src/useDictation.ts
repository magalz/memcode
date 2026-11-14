import { useEffect, useRef, useState } from "react";

export async function encodeWav(blob: Blob): Promise<ArrayBuffer> {
  const audio = new AudioContext();
  try {
    const decoded = await audio.decodeAudioData(await blob.arrayBuffer());
    if (
      !Number.isFinite(decoded.duration) ||
      decoded.duration < 0.15 ||
      decoded.duration > 95
    )
      throw Error(
        "Record between a moment and 90 seconds of speech, then try again.",
      );
    const offline = new OfflineAudioContext(
      1,
      Math.ceil(decoded.duration * 16000),
      16000,
    );
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start();
    const pcm = (await offline.startRendering()).getChannelData(0);
    const bytes = new ArrayBuffer(44 + pcm.length * 2);
    const view = new DataView(bytes);
    const text = (offset: number, s: string) => {
      for (let i = 0; i < s.length; i++)
        view.setUint8(offset + i, s.charCodeAt(i));
    };
    text(0, "RIFF");
    view.setUint32(4, 36 + pcm.length * 2, true);
    text(8, "WAVE");
    text(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, 16000, true);
    view.setUint32(28, 32000, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    text(36, "data");
    view.setUint32(40, pcm.length * 2, true);
    let peak = 0;
    for (let i = 0; i < pcm.length; i++) {
      const sample = Math.max(-1, Math.min(1, pcm[i]));
      peak = Math.max(peak, Math.abs(sample));
      view.setInt16(
        44 + i * 2,
        sample < 0 ? sample * 32768 : sample * 32767,
        true,
      );
    }
    if (peak < 0.001)
      throw Error(
        "No microphone audio was detected. Check your input device and try again.",
      );
    return bytes;
  } finally {
    await audio.close();
  }
}

export function useDictation(
  onText: (text: string) => void,
  onError: (text: string) => void,
) {
  const [phase, setPhase] = useState<
    "idle" | "preparing" | "recording" | "transcribing"
  >("idle");
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const alive = useRef(true);
  const busy = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const textCallback = useRef(onText),
    errorCallback = useRef(onError);
  textCallback.current = onText;
  errorCallback.current = onError;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      clearTimeout(timer.current);
      if (recorder.current?.state === "recording") recorder.current.stop();
      stream.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);
  const toggle = async () => {
    if (recorder.current?.state === "recording") {
      recorder.current.stop();
      return;
    }
    if (busy.current) return;
    busy.current = true;
    setPhase("preparing");
    try {
      // Setup is explicit; this can start an already configured local runtime,
      // but never downloads a model or requests the microphone on app boot.
      await window.memcode.prepareSpeech();
      if (!alive.current) return;
      if (
        !navigator.mediaDevices?.getUserMedia ||
        typeof MediaRecorder === "undefined"
      )
        throw Error(
          "This system browser cannot record audio. Update WebView2 or use another microphone-capable browser.",
        );
      const input = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        },
        video: false,
      });
      if (!alive.current) {
        input.getTracks().forEach((track) => track.stop());
        return;
      }
      stream.current = input;
      const mimeType = [
        "audio/webm;codecs=opus",
        "audio/webm",
        "audio/mp4",
        "audio/ogg;codecs=opus",
      ].find((type) => MediaRecorder.isTypeSupported(type));
      const media = new MediaRecorder(
        input,
        mimeType ? { mimeType } : undefined,
      );
      recorder.current = media;
      let failed = false;
      const chunks: Blob[] = [];
      media.ondataavailable = (event) => {
        if (event.data.size) chunks.push(event.data);
      };
      media.onstop = () => {
        clearTimeout(timer.current);
        input.getTracks().forEach((t) => t.stop());
        if (stream.current === input) stream.current = null;
        if (recorder.current === media) recorder.current = null;
        if (failed || !alive.current) return;
        setPhase("transcribing");
        void (async () => {
          try {
            const wav = await encodeWav(
              new Blob(chunks, { type: media.mimeType }),
            );
            if (!alive.current) return;
            const text = await window.memcode.transcribe(wav);
            if (alive.current) textCallback.current(text);
          } catch (error) {
            if (alive.current) errorCallback.current((error as Error).message);
          } finally {
            busy.current = false;
            if (alive.current) setPhase("idle");
          }
        })();
      };
      media.onerror = () => {
        failed = true;
        clearTimeout(timer.current);
        input.getTracks().forEach((track) => track.stop());
        busy.current = false;
        recorder.current = null;
        stream.current = null;
        if (alive.current) {
          setPhase("idle");
          errorCallback.current(
            "The microphone recording failed. Check the selected device and try again.",
          );
        }
      };
      media.start(1000);
      timer.current = setTimeout(() => {
        if (media.state === "recording") media.stop();
      }, 90000);
      setPhase("recording");
    } catch (error) {
      stream.current?.getTracks().forEach((track) => track.stop());
      stream.current = null;
      recorder.current = null;
      busy.current = false;
      const message =
        (error as Error).name === "NotAllowedError"
          ? "Microphone access was denied. Allow MemCode in your system microphone privacy settings, then try again."
          : (error as Error).name === "NotFoundError"
            ? "No microphone was found. Connect a microphone and try again."
            : (error as Error).message;
      if (alive.current) {
        errorCallback.current(message);
        setPhase("idle");
      }
    }
  };
  const label =
    phase === "preparing"
      ? "Starting local dictation…"
      : phase === "recording"
        ? "Listening…"
        : phase === "transcribing"
          ? "Transcribing on this computer…"
          : "Dictate a note";
  return { phase, toggle, label };
}
