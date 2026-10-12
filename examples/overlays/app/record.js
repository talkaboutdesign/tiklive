/**
 * tiklive sound recorder: the audio side of "New sound" on the Media Library page (media.html).
 * Plain ES module, no build step and no imports. Nothing touches the DOM or the audio APIs until a
 * function is called, so the pure functions can be tested under any runtime.
 *
 * Pure functions (channels are Float32Array[], one per channel, all the same length)
 *   MAX_RECORD_SECONDS, MIN_SELECTION_SECONDS
 *   downmix(channels)                       Mono Float32Array, the average of the channels.
 *   encodeWav(channels, sampleRate)         ArrayBuffer of a mono 16-bit PCM WAV file. Downmixes first.
 *   trimRange(channels, sampleRate, start, end)
 *                                           Copies of each channel from start to end (seconds).
 *   setSelectionEdge(selection, edge, value, duration)
 *                                           New { start, end } with one edge moved, kept MIN_SELECTION_SECONDS apart.
 *   peaks(samples, bins)                    Float32Array of length bins: the largest |sample| in each bucket.
 *   formatClock(seconds)                    "m:ss", e.g. "0:03".
 *   formatPrecise(seconds)                  "m:ss.t", e.g. "0:01.2".
 *
 * Browser side
 *   openMicrophone()                        getUserMedia({ audio: true }). Rejects with the browser's error.
 *   startRecording(stream, { maxSeconds, onTick, onLevel })
 *                                           Records with MediaRecorder and a level meter. Returns
 *                                           { stop(), cancel(), done }. done resolves to the Blob
 *                                           (or null after cancel). Every track is stopped when it ends.
 *   decodeRecording(blob)                   AudioBuffer, decoded with a short-lived AudioContext.
 *   playRange(buffer, start, end, { onTime, onEnd })
 *                                           Plays only [start, end). Returns { stop() }.
 *   drawWaveform(canvas, bins, options)     Draws peaks on a canvas, devicePixelRatio aware. Columns
 *                                           inside the selection use `accent`, the rest `faint`.
 */

export const MAX_RECORD_SECONDS = 30;
export const MIN_SELECTION_SECONDS = 0.1;

const BYTES_PER_SAMPLE = 2;
const WAV_HEADER_BYTES = 44;

function clamp(value, low, high) {
  return Math.max(low, Math.min(high, value));
}

export function downmix(channels) {
  if (channels.length === 0) return new Float32Array(0);
  if (channels.length === 1) return channels[0];
  const length = channels[0].length;
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    let sum = 0;
    for (const channel of channels) sum += channel[i];
    out[i] = sum / channels.length;
  }
  return out;
}

export function encodeWav(channels, sampleRate) {
  const mono = downmix(channels);
  const dataBytes = mono.length * BYTES_PER_SAMPLE;
  const buffer = new ArrayBuffer(WAV_HEADER_BYTES + dataBytes);
  const view = new DataView(buffer);
  const writeText = (offset, text) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  writeText(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeText(8, "WAVE");
  writeText(12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * BYTES_PER_SAMPLE, true); // byte rate
  view.setUint16(32, BYTES_PER_SAMPLE, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeText(36, "data");
  view.setUint32(40, dataBytes, true);

  let offset = WAV_HEADER_BYTES;
  for (let i = 0; i < mono.length; i++) {
    const sample = clamp(mono[i] ?? 0, -1, 1);
    view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
    offset += BYTES_PER_SAMPLE;
  }
  return buffer;
}

export function trimRange(channels, sampleRate, start, end) {
  const length = channels[0]?.length ?? 0;
  const from = clamp(Math.round(start * sampleRate), 0, length);
  const to = clamp(Math.round(end * sampleRate), from, length);
  return channels.map((channel) => channel.slice(from, to));
}

export function setSelectionEdge(selection, edge, value, duration) {
  if (edge === "start") {
    return { start: clamp(value, 0, Math.max(0, selection.end - MIN_SELECTION_SECONDS)), end: selection.end };
  }
  return {
    start: selection.start,
    end: clamp(value, selection.start + MIN_SELECTION_SECONDS, Math.max(selection.start, duration)),
  };
}

export function peaks(samples, bins) {
  const out = new Float32Array(bins);
  const length = samples.length;
  if (length === 0 || bins === 0) return out;
  for (let bin = 0; bin < bins; bin++) {
    const from = Math.floor((bin * length) / bins);
    const to = Math.max(from + 1, Math.floor(((bin + 1) * length) / bins));
    let max = 0;
    for (let i = from; i < to && i < length; i++) {
      const abs = Math.abs(samples[i] ?? 0);
      if (abs > max) max = abs;
    }
    out[bin] = max;
  }
  return out;
}

export function formatClock(seconds) {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

export function formatPrecise(seconds) {
  const tenths = Math.max(0, seconds);
  const minutes = Math.floor(tenths / 60);
  const rest = (tenths - minutes * 60).toFixed(1).padStart(4, "0");
  return `${minutes}:${rest}`;
}

// ---------- Browser: microphone and recording ----------

export function openMicrophone() {
  return navigator.mediaDevices.getUserMedia({ audio: true });
}

export function startRecording(
  stream,
  { maxSeconds = MAX_RECORD_SECONDS, onTick = () => {}, onLevel = () => {} } = {},
) {
  const stopTracks = () => {
    for (const track of stream.getTracks()) track.stop();
  };
  let meter = null;
  let timer = 0;
  let settled = false;
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });

  // Runs once, from whichever of stop, cancel or the recorder's own stop comes first.
  const finish = (blob) => {
    if (settled) return;
    settled = true;
    clearInterval(timer);
    stopTracks();
    meter?.close().catch(() => {});
    meter = null;
    resolveDone(blob);
  };

  try {
    const recorder = new MediaRecorder(stream);
    const chunks = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    recorder.onstop = () => finish(new Blob(chunks, { type: recorder.mimeType || "audio/webm" }));

    meter = new AudioContext();
    const analyser = meter.createAnalyser();
    analyser.fftSize = 1024;
    meter.createMediaStreamSource(stream).connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    const level = () => {
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const s of samples) sum += s * s;
      return Math.min(1, Math.sqrt(sum / samples.length) * 4);
    };

    const started = performance.now();
    const stop = () => {
      if (!settled && recorder.state !== "inactive") recorder.stop();
      return done;
    };
    timer = setInterval(() => {
      const elapsed = Math.min(maxSeconds, (performance.now() - started) / 1000);
      onTick(elapsed);
      onLevel(level());
      if (elapsed >= maxSeconds) stop();
    }, 50);

    recorder.start(250);
    return {
      stop,
      cancel() {
        if (settled) return;
        if (recorder.state !== "inactive") recorder.stop();
        finish(null);
      },
      done,
    };
  } catch (error) {
    finish(null);
    throw error;
  }
}

export async function decodeRecording(blob) {
  const context = new AudioContext();
  try {
    return await context.decodeAudioData(await blob.arrayBuffer());
  } finally {
    await context.close();
  }
}

export function playRange(buffer, start, end, { onTime = () => {}, onEnd = () => {} } = {}) {
  const context = new AudioContext();
  const source = context.createBufferSource();
  source.buffer = buffer;
  source.connect(context.destination);
  const began = context.currentTime;
  let timer = 0;
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    clearInterval(timer);
    source.onended = null;
    try {
      source.stop();
    } catch {
      // Already stopped at the end of the range.
    }
    context.close().catch(() => {});
    onEnd();
  };
  source.onended = finish;
  timer = setInterval(() => onTime(Math.min(end, start + (context.currentTime - began))), 50);
  source.start(0, start, end - start);
  return { stop: finish };
}

// ---------- Waveform ----------

export function drawWaveform(canvas, bins, { start, end, duration, playhead = null, accent, faint, text }) {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (!width || !height || duration <= 0) return;
  const dpr = globalThis.devicePixelRatio || 1;
  const pixelWidth = Math.round(width * dpr);
  const pixelHeight = Math.round(height * dpr);
  if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
  if (canvas.height !== pixelHeight) canvas.height = pixelHeight;

  const g = canvas.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, width, height);
  const mid = height / 2;
  const reach = height * 0.45;
  const last = Math.max(0, bins.length - 1);
  // Two-pixel bars with a one-pixel gap.
  for (let x = 0; x < width; x += 3) {
    const amp = bins[Math.min(last, Math.floor((x / width) * bins.length))] ?? 0;
    const time = ((x + 1) / width) * duration;
    g.fillStyle = time >= start && time <= end ? accent : faint;
    const half = Math.max(1, amp * reach);
    g.fillRect(x, mid - half, 2, half * 2);
  }
  if (playhead !== null) {
    g.fillStyle = text;
    g.fillRect(clamp((playhead / duration) * width, 0, width) - 1, 0, 2, height);
  }
}
