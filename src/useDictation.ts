import { useEffect, useRef, useState } from "react";

export async function encodeWav(blob: Blob): Promise<ArrayBuffer> {
  const audio = new AudioContext();
  try {
    const decoded = await audio.decodeAudioData(await blob.arrayBuffer());
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
    for (let i = 0; i < pcm.length; i++) {
      const sample = Math.max(-1, Math.min(1, pcm[i]));
      view.setInt16(
        44 + i * 2,
        sample < 0 ? sample * 32768 : sample * 32767,
        true,
      );
    }
    return bytes;
  } finally {
    await audio.close();
  }
}

export function useDictation(
  onText: (text: string) => void,
  onError: (text: string) => void,
) {
  const [phase, setPhase] = useState<"idle" | "recording" | "transcribing">(
    "idle",
  );
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (recorder.current?.state === "recording") recorder.current.stop();
      stream.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);
  const toggle = async () => {
    if (phase === "transcribing") return;
    if (recorder.current?.state === "recording") {
      recorder.current.stop();
      return;
    }
    try {
      stream.current = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        },
        video: false,
      });
      const media = new MediaRecorder(stream.current);
      recorder.current = media;
      const chunks: Blob[] = [];
      media.ondataavailable = (event) => {
        if (event.data.size) chunks.push(event.data);
      };
      media.onstop = () => {
        stream.current?.getTracks().forEach((t) => t.stop());
        if (!alive.current) return;
        setPhase("transcribing");
        void (async () => {
          try {
            const wav = await encodeWav(
              new Blob(chunks, { type: media.mimeType }),
            );
            const text = await window.memcode.transcribe(wav);
            if (alive.current) onText(text);
          } catch (error) {
            if (alive.current) onError((error as Error).message);
          } finally {
            if (alive.current) setPhase("idle");
          }
        })();
      };
      media.start();
      setPhase("recording");
    } catch (error) {
      onError(`Microphone unavailable: ${(error as Error).message}`);
      setPhase("idle");
    }
  };
  return { phase, toggle };
}
