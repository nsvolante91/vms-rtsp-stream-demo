// Capture keyframe from bridge WS, write to file, validate with ffmpeg
const WebSocket = require('ws');
const fs = require('fs');
const { execSync } = require('child_process');

function findNALUnits(data) {
  const units = [];
  const sp = [];
  for (let i = 0; i < data.length - 2; i++) {
    if (data[i] === 0 && data[i+1] === 0 && data[i+2] === 1) {
      sp.push({ o: i, l: 3 });
      i += 2;
    }
  }
  for (let i = 0; i < sp.length; i++) {
    const s = sp[i].o + sp[i].l;
    const e = i+1 < sp.length ? sp[i+1].o : data.length;
    if (s < e) units.push({ type: data[s] & 0x1f, data: data.subarray(s, e) });
  }
  return units;
}

function buildAvcC(sps, pps) {
  const p = sps[1];
  const ext = (p===100||p===110||p===122||p===144) ? 4 : 0;
  const sz = 6+2+sps.length+1+2+pps.length+ext;
  const b = Buffer.alloc(sz);
  let o = 0;
  b[o++]=1; b[o++]=sps[1]; b[o++]=sps[2]; b[o++]=sps[3]; b[o++]=0xff; b[o++]=0xe1;
  b.writeUInt16BE(sps.length,o); o+=2;
  sps.copy(b,o); o+=sps.length;
  b[o++]=1;
  b.writeUInt16BE(pps.length,o); o+=2;
  pps.copy(b,o); o+=pps.length;
  if (ext) { b[o++]=0xfc|1; b[o++]=0xf8; b[o++]=0xf8; b[o++]=0; }
  return b;
}

const ws = new WebSocket('ws://127.0.0.1:9000/ws');
ws.binaryType = 'arraybuffer';
let sps = null, pps = null, done = false, frameCount = 0;

ws.on('open', () => {
  console.log('Connected');
  ws.send(JSON.stringify({ type: 'subscribe', streamId: 1 }));
});

ws.on('message', (rawData) => {
  if (typeof rawData === 'string') { console.log('ctrl:', rawData.substring(0,80)); return; }
  const data = Buffer.isBuffer(rawData) ? rawData : Buffer.from(rawData);
  if (data.length < 12) return;
  const flags = data[11];
  const isKey = (flags & 1) !== 0;
  const isCfg = (flags & 2) !== 0;
  const payload = data.subarray(12);
  frameCount++;

  if (isCfg) {
    const nalus = findNALUnits(payload);
    for (const n of nalus) {
      if (n.type === 7) { sps = Buffer.from(n.data); console.log('SPS:', sps.length, 'bytes:', sps.subarray(0,10).toString('hex')); }
      if (n.type === 8) { pps = Buffer.from(n.data); console.log('PPS:', pps.length, 'bytes:', pps.toString('hex')); }
    }
    return;
  }

  console.log(`Frame #${frameCount}: ${payload.length}b flags=0x${flags.toString(16)} isKey=${isKey}`);

  if (!done && isKey && sps && pps) {
    done = true;
    const nalus = findNALUnits(payload);
    console.log(`\nKeyframe NALUs: ${nalus.length}`);
    for (const n of nalus) {
      console.log(`  type=${n.type} size=${n.data.length} first8=${Buffer.from(n.data.subarray(0,8)).toString('hex')}`);
    }

    // Write Annex B file: SPS + PPS + keyframe payload
    const sc = Buffer.from([0,0,0,1]);
    const h264 = Buffer.concat([sc, sps, sc, pps, payload]);
    fs.writeFileSync('/tmp/cam-keyframe.264', h264);
    console.log(`\nWrote /tmp/cam-keyframe.264 (${h264.length} bytes)`);

    // Write avcC
    const avcc = buildAvcC(sps, pps);
    fs.writeFileSync('/tmp/cam-avcc.bin', avcc);
    console.log(`avcC: ${avcc.length} bytes, hex: ${avcc.toString('hex')}`);

    // Write AVCC-format keyframe (length-prefixed)
    const vclNalus = nalus.filter(n => n.type >= 1 && n.type <= 5);
    let avccSz = 0;
    for (const n of vclNalus) avccSz += 4 + n.data.length;
    const avccData = Buffer.alloc(avccSz);
    let off = 0;
    for (const n of vclNalus) {
      avccData.writeUInt32BE(n.data.length, off); off += 4;
      Buffer.from(n.data).copy(avccData, off); off += n.data.length;
    }
    fs.writeFileSync('/tmp/cam-keyframe-avcc.bin', avccData);
    console.log(`AVCC keyframe: ${avccData.length} bytes, first20: ${avccData.subarray(0,20).toString('hex')}`);

    // Validate with ffprobe
    try {
      const out = execSync('ffprobe -v error -show_streams /tmp/cam-keyframe.264 2>&1').toString();
      console.log('\n--- ffprobe ---');
      console.log(out.substring(0, 400));
    } catch(e) { console.log('ffprobe err:', (e.stdout||e.stderr||'').toString().substring(0,300)); }

    // Try to decode single frame
    try {
      execSync('rm -f /tmp/cam-frame.yuv');
      execSync('ffmpeg -y -i /tmp/cam-keyframe.264 -frames:v 1 -f rawvideo /tmp/cam-frame.yuv 2>&1');
      const sz = fs.statSync('/tmp/cam-frame.yuv').size;
      const expected = 1920*1080*3/2;
      console.log(`\n--- ffmpeg decode ---\nYUV: ${sz} bytes (expected ${expected}) ${sz===expected?'OK':'MISMATCH'}`);
    } catch(e) { console.log('ffmpeg decode err:', (e.stdout||e.stderr||'').toString().substring(0,300)); }

    // Try VideoToolbox decode
    try {
      execSync('ffmpeg -y -hwaccel videotoolbox -i /tmp/cam-keyframe.264 -frames:v 1 -f rawvideo /tmp/cam-frame-vt.yuv 2>&1');
      const sz = fs.statSync('/tmp/cam-frame-vt.yuv').size;
      console.log(`VideoToolbox decode: ${sz} bytes ${sz===1920*1080*3/2?'OK':'MISMATCH'}`);
    } catch(e) { console.log('VT decode err:', (e.stdout||e.stderr||'').toString().substring(0,300)); }

    // Create MP4 with proper avcC box for testing
    try {
      execSync('ffmpeg -y -i /tmp/cam-keyframe.264 -c:v copy -f mp4 /tmp/cam-keyframe.mp4 2>&1');
      // Extract the avcC from the MP4 for comparison
      const mp4 = fs.readFileSync('/tmp/cam-keyframe.mp4');
      const avcCOffset = mp4.indexOf(Buffer.from('avcC'));
      if (avcCOffset >= 0) {
        const mp4avcc = mp4.subarray(avcCOffset + 4, avcCOffset + 4 + 60);
        console.log(`\nMP4 avcC (ffmpeg): ${mp4avcc.subarray(0, 50).toString('hex')}`);
        console.log(`Our avcC:          ${avcc.toString('hex')}`);
      }
      console.log('MP4 written to /tmp/cam-keyframe.mp4');
    } catch(e) { console.log('mp4 err:', (e.stdout||e.stderr||'').toString().substring(0,200)); }

    ws.close();
  }
});

ws.on('error', e => { console.error('WS err:', e.message); process.exit(1); });
setTimeout(() => { if (!done) { console.log(`Timeout. Got ${frameCount} frames total.`); ws.close(); process.exit(1); } }, 30000);
