// Eight bars, two performances. The renderer derives the plain take from this exact score.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '..');
const amp = (attack, decay, sustain, release) => ({ attack, decay, sustain, release });
const notes = [
  [0,'A4',1.5,.56],[1.75,'C5',.5,.7],[2.5,'D5',1,.88],
  [4.5,'F5',1.25,.75],[6,'E5',.5,.5],[6.75,'D5',1,.61],
  [8,'Bb4',1.5,.68],[9.75,'D5',.5,.52],[10.5,'F5',1.25,.82],
  [12.25,'E5',.75,.55],[13.25,'C#5',.5,.72],[14,'A4',1.5,.59],
  [16,'D5',2.5,.86],[19,'A4',.5,.5],[19.75,'C5',.75,.64],
  [20.75,'F5',1.5,.79],[22.5,'E5',1,.55],
  [24,'D5',1,.72],[25.5,'Bb4',.5,.5],[26.25,'G4',1.25,.67],
  [28,'A4',.75,.54],[29,'C#5',.5,.71],[30,'D5',2,.82],
];
function gesture([at,note,beats,vel], i) {
  const pitch = [[0, i % 3 === 0 ? -.8 : -.18], [Math.min(.16, beats / 3), 0]];
  // A delayed hand vibrato, small enough to hear as phrasing rather than a new note.
  if (beats >= 1) for (let t=.65,j=0;t<=beats;t+=.14,j++) pitch.push([+t.toFixed(3), j%2 ? -.065 : .065]);
  return { at, note, beats, vel, expression: { pitch,
    brightness: [[0,-.45],[Math.min(.3,beats/2),.65],[beats,-.25]],
  } };
}
const song = {
  schema:'beeps/song@1',name:'touch',title:'Touch',tags:['performance','expression','study'],bpm:92,loop:false,seed:308,
  instruments:{
    // Freeze the backing recipes into both downloads: project-local overrides and future
    // stock-library revisions must not change this controlled comparison.
    ...Object.fromEntries(['e-piano','sub-bass','rim','shaker'].map(name=>[name,JSON.parse(readFileSync(resolve(root,`library/instruments/${name}.json`),'utf8'))])),
    reed:{duration:1,layers:[{source:{type:'fm',pitch:'D5',operators:[{ratio:1,index:1},{ratio:1,index:1.7}],algorithm:[[1,0]]},
      amp:amp(.045,.22,.72,.16),filter:{type:'lowpass',cutoff:1800,resonanceDb:0},highpass:180}],
      xRuntime:{inputs:{touch:{min:0,max:1,default:.5}},bind:[
        {input:'touch',target:'/layers/0/filter/cutoff',range:[-.9,.8]},
        {input:'touch',target:'/layers/0/source/operators/1/index',range:[-.4,.9]},
        {input:'touch',target:'/layers/0/amp/attack',range:[1,-1.5]},
      ]}},
  },
  progressions:{changes:[['Dm9',4],['Bbmaj9',4],['Gm9',4],['A7',4],['Dm9',4],['Bbmaj9',4],['Gm9',4],['Dm9',4]]},
  tracks:{
    lead:{instrument:'reed',velocityInput:'touch',gainDb:-12,pan:.08,sends:{reverb:-17,delay:-22}},
    keys:{instrument:'e-piano',gainDb:-21,pan:-.25,sends:{reverb:-19}},
    bass:{instrument:'sub-bass',gainDb:-20},
    rim:{instrument:'rim',gainDb:-19,pan:.25},
    hat:{instrument:'shaker',gainDb:-24,pan:-.2},
  },
  patterns:{
    melody:{bars:8,notes:notes.map(gesture)},
    harmony:{bars:8,chords:{progression:'changes',octave:4,voicing:'lead',rhythm:'x... ..x. .... ..x.',strum:.012},hitBeats:.65,vel:.6},
    bassline:{bars:8,notes:['D2','Bb1','G2','A1','D2','Bb1','G2','D2'].flatMap((root,i)=>[
      [i*4,root,1.5,.65],[i*4+2.5,['A2','F2','D3','E2','A2','F2','D3','A2'][i],.5,.5],[i*4+3.5,root,.35,.55],
    ])},
    rim:{bars:1,steps:'.... x... .... x...',vel:.55},
    hat:{bars:2,steps:'..x. ..o. ..x. .ox. ..x. ..o. ..x. .o.o',vel:.5},
  },
  sections:{study:{bars:8,play:{lead:'melody',keys:'harmony',bass:'bassline',rim:'rim',hat:'hat'}}},form:['study'],
  master:{reverb:{preset:'room',returnDb:-7},delay:{beats:.75,feedback:.2,cutoff:2200,returnDb:-14}},
};
for (const path of ['library/songs/performance/touch.json','showcase/recipes/touch.json']) {
  const file=resolve(root,path);mkdirSync(resolve(file,'..'),{recursive:true});writeFileSync(file,JSON.stringify(song,null,2)+'\n');
}
const plain=structuredClone(song);plain.name='touch-plain';plain.title='Touch · plain';
delete plain.tracks.lead.velocityInput;
plain.patterns.melody.notes=notes;
writeFileSync(resolve(root,'showcase/recipes/touch-plain.json'),JSON.stringify(plain,null,2)+'\n');
console.log('Touch: eight bars, identical notes/velocities/arrangement, expression on the lead only.');
