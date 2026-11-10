const host = process.env.RFB_HOST;
if (!host) throw new Error("RFB_HOST is required");
const ws = new WebSocket(`ws://${host}:6080/websockify`, ["binary"]);
ws.binaryType = "arraybuffer";
let data = Buffer.alloc(0), stage = 0, init, updates = 0, done = false;
const finish = (value, code = 0) => { if (done) return; done = true; console.log(JSON.stringify(value)); ws.close(); process.exitCode = code; };
const request = () => { const b = Buffer.alloc(10); b[0] = 3; b.writeUInt16BE(init.width, 6); b.writeUInt16BE(init.height, 8); ws.send(b); };
function advance() {
  if (stage === 0 && data.length >= 12) { const v=data.subarray(0,12);data=data.subarray(12);if(!v.toString().startsWith("RFB "))return finish({ok:false,stage},1);ws.send(v);stage=1; }
  if (stage === 1 && data.length >= 1) { const n=data[0];if(data.length<1+n)return;const types=data.subarray(1,1+n);data=data.subarray(1+n);if(!types.includes(1))return finish({ok:false,stage},1);ws.send(Buffer.from([1]));stage=2; }
  if (stage === 2 && data.length >= 4) { const result=data.readUInt32BE(0);data=data.subarray(4);if(result)return finish({ok:false,stage,result},1);ws.send(Buffer.from([1]));stage=3; }
  if (stage === 3 && data.length >= 24) { const nameLength=data.readUInt32BE(20);if(data.length<24+nameLength)return;init={width:data.readUInt16BE(0),height:data.readUInt16BE(2),bytesPerPixel:data[4]/8};data=data.subarray(24+nameLength);ws.send(Buffer.from([2,0,0,1,0,0,0,0]));request();stage=4; }
  if (stage === 4 && data.length >= 16) { if(data[0]!==0)return;const count=data.readUInt16BE(2);if(!count)return;const width=data.readUInt16BE(8),height=data.readUInt16BE(10),encoding=data.readInt32BE(12);if(encoding!==0)return finish({ok:false,...init,encoding},1);const bytes=width*height*init.bytesPerPixel;if(data.length<16+bytes)return;const pixels=data.subarray(16,16+bytes);data=data.subarray(16+bytes);const variants=new Set();for(let i=0;i+init.bytesPerPixel<=pixels.length;i+=init.bytesPerPixel*10)variants.add(pixels.subarray(i,i+init.bytesPerPixel).toString("hex"));updates++;if(variants.size<2&&updates<4){setTimeout(request,500);return;}finish({ok:true,...init,nonblank:variants.size>1,pixelVariants:variants.size,updates},variants.size>1?0:1); }
}
ws.addEventListener("message", event => { data=Buffer.concat([data,Buffer.from(event.data)]);advance(); });
ws.addEventListener("error", () => finish({ok:false,stage,error:"websocket"},1));
setTimeout(() => finish({ok:false,stage,error:"timeout",...init},1), 15_000);
