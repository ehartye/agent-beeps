import { serveShowcase } from './showcase-server.mjs';
const site=await serveShowcase({host:'0.0.0.0',port:Number(process.env.PORT)||47320});
console.log(`Matter preview: http://localhost:${site.port}`);
