import { createReadStream, existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { serveStatic } from '../src/render/host.ts';

/** Local preview mirrors Pages byte ranges; the renderer's minimal server doesn't serve ranges. */
export function serveShowcase({host='127.0.0.1',port=0,prefix='',rootDir=resolve(import.meta.dirname,'../_site')}={}) {
  const root=resolve(rootDir);
  return serveStatic(root,{host,port,extra:(req,res)=>{
    const url=new URL(req.url,'http://preview');
    if(prefix&&!url.pathname.startsWith(`${prefix}/`)){res.writeHead(404).end();return true;}
    const path=url.pathname.slice(prefix.length);req.url=path+url.search;
    if(!/^\/media\/[a-z0-9-]+\.mp3$/.test(path))return false;
    if(!['GET','HEAD'].includes(req.method)){res.writeHead(405).end();return true;}
    const file=resolve(root,`.${path}`);
    if(!existsSync(file))return false;
    const size=statSync(file).size;
    let start=0,end=size-1;
    if(req.headers.range){
      const match=/^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
      if(!match||(!match[1]&&!match[2])){res.writeHead(416,{'content-range':`bytes */${size}`}).end();return true;}
      if(!match[1])start=Math.max(0,size-Number(match[2]));
      else {start=Number(match[1]);if(match[2])end=Math.min(size-1,Number(match[2]));}
      if(start>end||start>=size){res.writeHead(416,{'content-range':`bytes */${size}`}).end();return true;}
    }
    res.writeHead(req.headers.range?206:200,{'content-type':'audio/mpeg','accept-ranges':'bytes','content-length':end-start+1,...(req.headers.range?{'content-range':`bytes ${start}-${end}/${size}`}:{})});
    if(req.method==='HEAD')res.end();else createReadStream(file,{start,end}).pipe(res);
    return true;
  }});
}
