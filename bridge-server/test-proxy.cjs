const { createRtspAuthProxy, parseRtspUrl } = require('./dist/rtsp-auth-proxy.js');
const { spawn } = require('child_process');

async function test() {
  const url = 'rtsp://adminbob:Test123.@10.10.33.32:554/live/0582abb4-1cd7-469e-9b7c-b0c1cffab49b';
  const { host, port } = parseRtspUrl(url);
  const proxy = await createRtspAuthProxy(host, port);
  const proxiedUrl = proxy.rewriteUrl(url);
  console.log('Proxied URL:', proxiedUrl);

  const proc = spawn('ffprobe', [
    '-rtsp_transport', 'tcp',
    '-analyzeduration', '2000000',
    '-probesize', '2000000',
    '-i', proxiedUrl,
    '-show_streams', '-select_streams', 'v:0',
    '-loglevel', 'warning',
    '-print_format', 'json',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  let stdout = '';
  proc.stdout.on('data', (d) => { stdout += d.toString(); });
  proc.stderr.on('data', (d) => { process.stderr.write(d); });

  proc.on('close', (code) => {
    console.log('Exit code:', code);
    if (stdout) {
      try {
        const info = JSON.parse(stdout);
        console.log('Streams found:', info.streams?.length ?? 0);
        if (info.streams?.[0]) {
          console.log('Codec:', info.streams[0].codec_name, info.streams[0].width + 'x' + info.streams[0].height);
        }
      } catch (e) {
        console.log('Raw output:', stdout.substring(0, 200));
      }
    }
    proxy.close();
    process.exit(0);
  });

  setTimeout(() => { console.log('Timeout!'); proxy.close(); process.exit(1); }, 15000);
}

test().catch((e) => { console.error(e); process.exit(1); });
