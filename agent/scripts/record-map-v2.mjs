/** Normal-speed recording of the real desktop UI and real OSM routes.
 * Location is stopped through its visible control BEFORE any frames are saved.
 */
import {_electron as electron,expect} from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {isolatedEnvironment} from './test-environment.mjs';
const root=process.cwd(),out=path.join(root,'artifacts/map-v2'),framesDir=path.join(root,'.test-data','map-record-'+Date.now());
await fs.mkdir(framesDir,{recursive:true});await fs.mkdir(out,{recursive:true});
const env=isolatedEnvironment('map-record',path.join(framesDir,'profile'));delete env.ELECTRON_RUN_AS_NODE;
const app=await electron.launch({args:[root],env});
let cdp,recording=false,started=0;
const frames=[],writes=[];
try{
  const page=await app.firstWindow();await page.emulateMedia({colorScheme:'dark'});
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setBounds({width:1360,height:920}));
  await page.getByRole('button',{name:'打开校园地图',exact:true}).click();await page.locator('.campus-v2-stage[data-ready="true"]').waitFor();
  await page.getByRole('button',{name:'地图来源与覆盖范围',exact:true}).click();await page.getByRole('button',{name:'停止本机定位',exact:true}).click();
  await expect(page.locator('.campus-v2-about')).toContainText('本次会话已停止本机定位');
  await page.getByRole('button',{name:'关闭地图说明',exact:true}).click();await page.getByRole('button',{name:'返回对话',exact:true}).click();
  await page.getByRole('textbox',{name:'和在场说说'}).fill('看完地图，再继续刚才的对话。');
  cdp=await page.context().newCDPSession(page);recording=true;started=performance.now();
  cdp.on('Page.screencastFrame',event=>{
    void cdp.send('Page.screencastFrameAck',{sessionId:event.sessionId}).catch(()=>{});
    if(!recording)return;
    const file=path.join(framesDir,`frame-${String(frames.length).padStart(5,'0')}.jpg`);
    frames.push({file,time:(performance.now()-started)/1000});writes.push(fs.writeFile(file,Buffer.from(event.data,'base64')));
  });
  await cdp.send('Page.startScreencast',{format:'jpeg',quality:90,maxWidth:1360,maxHeight:920,everyNthFrame:1});
  await page.waitForTimeout(1200);
  await page.getByRole('button',{name:'打开校园地图',exact:true}).click();await page.locator('.campus-v2-stage[data-ready="true"]').waitFor();await page.waitForTimeout(1600);
  await page.screenshot({path:path.join(out,'demo-overview.png')});
  const stage=page.locator('.campus-v2-stage'),box=await stage.boundingBox();
  await page.mouse.move(box.x+box.width*.58,box.y+box.height*.44);await page.mouse.down();
  for(let i=1;i<=25;i++){await page.mouse.move(box.x+box.width*.58+90*i/25,box.y+box.height*.44+30*i/25);await page.waitForTimeout(16);}
  await page.mouse.up();await page.waitForTimeout(650);await page.mouse.wheel(0,-140);await page.waitForTimeout(850);
  await page.getByRole('button',{name:'查看校园全貌',exact:true}).click();await page.waitForTimeout(900);
  await page.getByRole('button',{name:'两点路线',exact:true}).click();await page.waitForTimeout(800);
  async function choose(name){await page.getByRole('combobox',{name:'搜索建筑或地点'}).fill(name);await page.waitForTimeout(900);await page.keyboard.press('Enter');await page.waitForTimeout(1000);}
  await choose('东3教学楼');await choose('东4教学楼');await expect(page.locator('.campus-v2-route')).toHaveAttribute('data-status','ready');await page.waitForTimeout(1400);
  await page.screenshot({path:path.join(out,'demo-route.png')});
  for(let i=0;i<3;i++){await page.getByRole('button',{name:'顺时针旋转地图',exact:true}).click();await page.waitForTimeout(300);}
  await page.getByRole('button',{name:'查看全路线',exact:true}).click();await page.waitForTimeout(1200);
  await page.getByRole('button',{name:'地图回北',exact:true}).click();await page.waitForTimeout(750);
  await page.getByRole('button',{name:'交换两端',exact:true}).click();await page.waitForTimeout(1300);
  await choose('桂花苑');await expect(page.locator('.campus-v2-route')).toHaveAttribute('data-status','unknown_entrance');await page.waitForTimeout(1500);
  await page.getByRole('button',{name:'地图来源与覆盖范围',exact:true}).click();await page.waitForTimeout(1500);
  await page.getByRole('button',{name:'关闭地图说明',exact:true}).click();await page.getByRole('button',{name:'返回对话',exact:true}).click();await page.waitForTimeout(1400);
  await expect(page.getByRole('textbox',{name:'和在场说说'})).toHaveValue('看完地图，再继续刚才的对话。');
  const duration=(performance.now()-started)/1000;recording=false;await cdp.send('Page.stopScreencast');await Promise.all(writes);
  const escape=f=>f.replaceAll('\\','/').replaceAll("'","'\\''");
  const concat=frames.map((f,i)=>`file '${escape(f.file)}'\nduration ${Math.max(.01,(frames[i+1]?.time??duration)-f.time).toFixed(6)}`).join('\n')+`\nfile '${escape(frames.at(-1).file)}'\n`;
  const list=path.join(framesDir,'frames.txt');await fs.writeFile(list,concat);
  await promisify(execFile)('ffmpeg.exe',['-y','-loglevel','error','-f','concat','-safe','0','-i',list,'-vf','fps=30,scale=1360:920:force_original_aspect_ratio=decrease,pad=1360:920:(ow-iw)/2:(oh-ih)/2','-c:v','libx264','-crf','20','-pix_fmt','yuv420p','-movflags','+faststart',path.join(out,'in-app-demo.mp4')],{windowsHide:true,maxBuffer:1024*1024});
  await fs.writeFile(path.join(out,'demo.json'),JSON.stringify({environment:'Real Electron production build',durationSeconds:duration,capturedFrames:frames.length,speed:'normal wall-clock timing, encoded at 30 fps',location:'Stopped through visible UI before recording; no position coordinates or account data captured.',dataVersion:JSON.parse(await fs.readFile('assets/map-v2/manifest.json','utf8')).version,steps:['open map','pan and zoom','two-point real route','rotate and fit','swap','unknown entry failure','source information','return with draft intact']},null,2));
  console.log(JSON.stringify({video:'artifacts/map-v2/in-app-demo.mp4',seconds:duration,frames:frames.length}));
}finally{recording=false;if(cdp)await cdp.send('Page.stopScreencast').catch(()=>{});await app.close();}
