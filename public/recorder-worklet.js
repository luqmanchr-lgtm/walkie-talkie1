// AudioWorklet: ambil mikrofon, turunkan ke 16 kHz mono, kirim sebagai PCM 16-bit (1600 sampel = 100 ms)
class RecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000;
    this.pos = 0; this.acc = 0; this.n = 0;
    this.buf = new Int16Array(1600);
    this.i = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let k = 0; k < ch.length; k++) {
      this.acc += ch[k]; this.n++; this.pos += 1;
      if (this.pos >= this.ratio) {
        this.pos -= this.ratio;
        const v = Math.max(-1, Math.min(1, this.acc / this.n));
        this.buf[this.i++] = v < 0 ? v * 32768 : v * 32767;
        this.acc = 0; this.n = 0;
        if (this.i === this.buf.length) {
          this.port.postMessage(this.buf.buffer.slice(0));
          this.i = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('recorder', RecorderProcessor);
