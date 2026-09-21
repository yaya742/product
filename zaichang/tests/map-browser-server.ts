/** Visual fallback harness only. Same App/Map code + real map service; synthetic account bridge.
 * Never included in the desktop package. Does not prove Electron IPC or native input support.
 */
import {createServer} from 'vite';
import {CampusMapAdapter} from '../src/main/mapService';
import {DEFAULT_SETTINGS} from '../src/shared/types';
import {MapLocationProvider} from '../src/main/mapLocation';
const service=new CampusMapAdapter('assets/map-v2');
const drafts=new Map();
const provider=new MapLocationProvider();
const state={settings:DEFAULT_SETTINGS,conversations:[],memories:[],agenda:[],interfaces:[],plugins:[],campus:null,campusConnector:null};
const bridge=`
const call=async(method,arg)=>{const r=await fetch('/__map-test/api',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({method,arg})});if(!r.ok)throw new Error(await r.text());return r.json();};
window.zaichang=new Proxy({onEvent:()=>()=>{},window:()=>{}},{get:(o,k)=>k in o?o[k]:(arg)=>call(k,arg)});
window.addEventListener('DOMContentLoaded',()=>{document.title='在场 · 浏览器验证（非桌面验收）';});
`;
const server=await createServer({plugins:[{
  name:'map-v2-browser-test-only',
  transformIndexHtml(html){return html.replace('</head>','<script type="module" src="/__map-test/bridge.js"></script></head>');},
  configureServer(s){s.middlewares.use(async(req,res,next)=>{
    if(req.url==='/__map-test/bridge.js'){res.setHeader('Content-Type','text/javascript');res.end(bridge);return;}
    if(req.url!=='/__map-test/api')return next();
    if(req.method!=='POST'){res.statusCode=405;res.end();return;}
    try{
      let body='';for await(const b of req){body+=b;if(body.length>10000)throw new Error('Too large');}
      const {method,arg}=JSON.parse(body);let value:unknown=null;
      if(method==='state')value=state;
      else if(method==='draft')value=drafts.get(arg)||{text:'',attachment:null};
      else if(method==='saveDraft')drafts.set(arg.id,arg.draft);
      else if(method==='messages')value=[];
      else if(method==='mapOverview')value=service.overview();
      else if(method==='mapSearch')value=service.search(arg.query,arg.limit);
      else if(method==='mapRoute')value=service.route(arg);
      else if(method==='mapLocationStatus')value=service.locationStatus();
      else if(method==='mapLocate')value={status:'unavailable',source:'test-harness',phoneConnected:false,reason:'浏览器视觉测试未启用位置；原生服务另行实测。'};
      else if(method==='mapStopLocation')value=null;
      else if(method==='openLink')value=null;
      else throw new Error('This browser harness only supports read-only map verification.');
      res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));
    }catch(e){res.statusCode=400;res.end(String(e));}
  });}
}],server:{host:'127.0.0.1',port:5173,strictPort:true}});
await server.listen();console.log('Browser-only verification: http://127.0.0.1:5173');
process.on('SIGINT',async()=>{provider.cancel();await server.close();process.exit(0);});
process.on('SIGTERM',async()=>{provider.cancel();await server.close();process.exit(0);});
