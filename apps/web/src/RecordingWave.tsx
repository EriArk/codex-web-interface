import { useEffect, useState } from "react";

const SAMPLES = 64;
export function RecordingWave({
  stream,
  context,
}: {
  stream: MediaStream;
  context: AudioContext | null;
}) {
  const [levels, setLevels] = useState<number[]>(() => Array(SAMPLES).fill(0));
  useEffect(() => {
    if (!context || context.state === "closed") return;
    let source: MediaStreamAudioSourceNode | undefined;
    let analyser: AnalyserNode | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    try {
      source = context.createMediaStreamSource(stream);
      analyser = context.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser); // Never connect the microphone to speakers.
      const data = new Float32Array(512);
      timer = setInterval(() => {
        if (!analyser || context.state !== "running") return;
        analyser.getFloatTimeDomainData(data);
        const rms = Math.sqrt(data.reduce((sum, value) => sum + value * value, 0) / data.length);
        const level = Math.min(1, Math.max(0, rms - 0.005) * 7);
        setLevels((previous) => [...previous.slice(1), level]);
      }, 80);
    } catch {
      /* Keep a quiet baseline instead of inventing microphone activity. */
    }
    return () => {
      clearInterval(timer);
      source?.disconnect();
      analyser?.disconnect();
    };
  }, [stream, context]);
  const points = levels
    .map((value, i) => `${i * 4},${20 - Math.max(0.6, value * 18)}`)
    .concat(levels.map((value, i) => `${i * 4},${20 + Math.max(0.6, value * 18)}`).reverse())
    .join(" ");
  return (
    <svg
      className="dictation-wave"
      viewBox="0 0 252 40"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <polygon points={points} />
    </svg>
  );
}
