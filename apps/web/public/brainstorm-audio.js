/* Ephemeral 16 kHz mono PCM transport, 40 ms frames. Worklet owns bounded audio queues only. */
class RoomAudio extends AudioWorkletProcessor {
  constructor() {
    super(); this.capture = new Int16Array(640); this.at = 0; this.phase = 0;
    this.peers = new Map(); this.muted = true; this.deafened = false;
    this.port.onmessage = ({ data }) => {
      if (data.type === "state") { this.muted = data.muted; this.deafened = data.deafened; if (this.deafened) this.peers.clear(); }
      if (data.type === "pcm" && !this.deafened) {
        if (!this.peers.has(data.id) && this.peers.size >= 8) return;
        const peer = this.peers.get(data.id) || { frames: [], offset: 0, phase: 0 };
        if (peer.frames.length >= 6) { peer.frames.shift(); peer.offset = 0; }
        peer.frames.push(new Int16Array(data.buffer)); this.peers.set(data.id, peer);
      }
    };
  }
  process(inputs, outputs) {
    const mic = inputs[0]?.[0], out = outputs[0]?.[0];
    if (!out) return true;
    const ratio = 16000 / sampleRate;
    for (let i = 0; i < out.length; i++) {
      this.phase += ratio;
      if (this.phase >= 1) {
        this.phase -= 1;
        this.capture[this.at++] = this.muted ? 0 : Math.max(-1, Math.min(1, mic?.[i] || 0)) * 32767;
        if (this.at === 640) {
          if (!this.muted) this.port.postMessage({ type: "pcm", buffer: this.capture.buffer }, [this.capture.buffer]);
          this.capture = new Int16Array(640); this.at = 0;
        }
      }
      let mixed = 0;
      if (!this.deafened) for (const peer of this.peers.values()) {
        if (!peer.frames.length) continue;
        mixed += peer.frames[0][peer.offset] / 32768;
        peer.phase += ratio;
        if (peer.phase >= 1) { peer.phase -= 1; peer.offset++; if (peer.offset >= peer.frames[0].length) { peer.frames.shift(); peer.offset = 0; } }
      }
      out[i] = Math.max(-1, Math.min(1, mixed));
    }
    return true;
  }
}
registerProcessor("brainstorm-audio", RoomAudio);
