// The authored score for Matter. No samples: every instrument is an engine patch.
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const amp = (attack, decay, sustain = 0, release = .04) => ({ attack, decay, sustain, release });
const low = cutoff => ({ type: 'lowpass', cutoff, resonanceDb: 0 });
const band = (cutoff, q = .8) => ({ type: 'bandpass', cutoff, q });
const patch = (duration, layers) => ({ duration, layers });
const osc = (wave, pitch) => ({ type: 'osc', wave, pitch });
const noise = (color = 'pink', stereo = false) => ({ type: 'noise', color, stereo });
const instruments = {
  glass: patch(.25, [{ source: { type: 'additive', pitch: 'D5', partials: [[1,0,1.4],[2,-12,.65],[2.76,-21,.3],[4.07,-27,.15]] }, amp: amp(.004,1.5,0,.5), highpass: 300 }]),
  tine: patch(.35, [{ source: { type:'fm', pitch:'D4', operators:[{ratio:1,index:1},{ratio:2,index:1.8}], algorithm:[[1,0]] }, amp:amp(.006,.35,.12,.15), filter:low(3200), highpass:220 }]),
  silk: patch(1, [{ source:{...osc('triangle','D4'),unison:{voices:3,detuneCents:9}}, amp:amp(.3,.5,.65,.7), filter:low(2200), highpass:240 }]),
  rubber: patch(.3, [{ source:{type:'fm',pitch:'D2',operators:[{ratio:1,index:1},{ratio:1,index:.8}],algorithm:[[1,0]]}, amp:amp(.008,.2,.2,.08),filter:{...low(950),env:{to:260,time:.2}},highpass:38 }]),
  kick: patch(.23,[{source:osc('sine',55),pitchEnv:[{at:0,to:150},{at:.035,to:55},{at:.2,to:46}],amp:amp(.004,.21),highpass:35},{source:noise('white'),amp:amp(.004,.012),filter:band(2600),gainDb:-17}]),
  snare: patch(.21,[{source:{type:'modal',pitch:185,modes:[[1,14,0],[1.6,10,-6],[2.1,8,-14]],exciter:'noiseBurst'},amp:amp(.004,.15),gainDb:-4,highpass:120},{source:noise('white'),amp:amp(.004,.18),filter:band(2200,.65),gainDb:-9}]),
  hat: patch(.065,[{source:{type:'metal',base:43,bands:[4200,7700]},amp:amp(.004,.055),filter:{type:'highpass',cutoff:4400,resonanceDb:0},gainDb:12}]),
  iron: patch(.2,[{source:{type:'additive',pitch:'D3',partials:[...[1,2,3,4,5,6,7,8].map(h=>[h,-5-13*Math.log2(h),.2/(1+.16*(h-1))]),...[1,2,3,4].map(h=>[h*1.5,-10-13*Math.log2(h),.14/(1+.2*(h-1))])]},amp:amp(.005,.12,.12,.06),drive:.65,filter:{...low(4800),env:{to:1800,time:.11}},highpass:110},{source:noise('pink'),amp:amp(.004,.016),filter:band(2400),gainDb:-22}]),
  dust: patch(2,[{source:{type:'grains',rate:110,grainDecay:.012,center:3800,q:2,rateEnd:.05,stereo:true},amp:amp(.08,1.8),filter:band(3300),gainDb:0}]),
  choir: patch(1,[{source:{type:'voice',pitch:'D4',formants:[[650,5,0],[1100,7,-4],[2900,9,-14]],tilt:1.9,jitterCents:5,breath:.16,vibrato:{rate:4.8,cents:7}},amp:amp(.35,.8,.6,.8),highpass:230,filter:low(3600)}]),
  anvil: patch(.5,[{source:{type:'modal',pitch:170,modes:[[1,100,0],[2.76,130,-10],[5.4,85,-17],[8.93,70,-22]],exciter:'noiseBurst'},amp:amp(.004,.6),highpass:90},{source:noise(),amp:amp(.004,.05),filter:band(2100),gainDb:-14}]),
  air: patch(1,[{source:noise('pink',true),amp:amp(.5,.8,.5,.6),filter:{...band(1400,.6),env:{to:4200,time:1.8}},highpass:450,gainDb:0}]),
};
const tr = (instrument,gainDb,extra={}) => ({instrument,gainDb,...extra});
const tracks = {
  glass:tr('glass',-8,{pan:.3,sends:{reverb:-9,delay:-13},humanize:.13}),
  keys:tr('tine',-15,{pan:-.22,sends:{reverb:-17,delay:-20},humanize:.2,swing:.12}),
  silk:tr('silk',-18,{spread:.75,sends:{reverb:-12}}),
  bass:tr('rubber',-16),
  kick:tr('kick',-16,{fixed:true}),snare:tr('snare',-5,{fixed:true,sends:{reverb:-23},humanize:.08}),
  hat:tr('hat',5,{fixed:true,pan:.23,humanize:.3,swing:.12}),
  'iron-l':tr('iron',-14,{pan:-.78,humanize:.23}),
  'iron-r':tr('iron',-14,{pan:.78,humanize:.27}),
  dust:tr('dust',0,{fixed:true,sends:{reverb:-15}}),
  choir:tr('choir',-14,{spread:.6,sends:{reverb:-9}}),
  anvil:tr('anvil',-8,{fixed:true,pan:-.12,sends:{reverb:-16}}),
  air:tr('air',-4,{fixed:true,sends:{reverb:-18}}),
};
const notes=(bars,ns)=>({bars,notes:ns});
const patterns={
  glint:notes(4,[[0,'D5',.4,.8],[1.5,'A5',.25,.55],[3.25,'E5',.4,.65],[6,'F5',.5,.7],[8,'C6',.4,.5],[10.75,'A5',.3,.7],[12,'E5',.5,.5],[14.5,'D5',.5,.6]]),
  hook:notes(4,[[0,'D5',.7,.85],[1.5,'F5',.35,.65],[2.75,'E5',.5,.75],[4.5,'A5',.6,.8],[6,'G5',.7,.65],[8,'E5',1,.8],[10.5,'C5',.4,.65],[12,'D5',1.5,.9],[15,'A4',.35,.5]]),
  chords:{bars:4,chords:{progression:'colour',octave:4,voicing:'lead',rhythm:'..x_ .... ..x_ ...x',strum:.012},hitBeats:.4,vel:.65},
  pad:{bars:4,chords:{progression:'bloom',octave:4,voicing:'open'},vel:.65},
  choir:{bars:4,chords:{progression:'bloom',octave:4,voicing:'lead'},vel:.65},
  arp:{bars:4,arp:{progression:'bloom',octave:5,rate:2,shape:'converge',rhythm:'x..x.x..'},gate:.45,vel:.65},
  bass:notes(4,[[0,'D2',.6,.9],[1.75,'D3',.2,.6],[2.5,'A2',.3,.7],[3.5,'C3',.2,.55],[4,'Bb1',.7,.85],[5.5,'F2',.4,.75],[6.75,'A2',.3,.6],[8,'G2',.5,.85],[9.5,'D3',.25,.6],[10.5,'F2',.5,.75],[12,'A1',.7,.85],[13.75,'E2',.3,.6],[14.5,'C#3',.25,.6],[15.5,'A2',.2,.65]]),
  'bass-bloom':{bars:4,bass:{progression:'bloom',octave:2},vel:.65},
  kick:{bars:2,steps:'X... ..x. .... x... X... ...x ..x. ....'},
  snare:{bars:2,steps:'.... X... .... X..o .... X... ..o. X...'},
  hat:{bars:2,steps:'..x. o.x. ..x. o.xx ..x. o.x. ..x. o.xo',vel:.7},
  euclid:{bars:1,steps:'x(5,16,1)',vel:.6},
  stomp:{bars:2,steps:'X.xx ..x. X.xx .... X.xx ..x. X... ..xx',vel:.85},
  backbeat:{bars:2,steps:'.... .... X... .... .... .... X... ..oo'},
  'iron-hat':{bars:1,steps:'X.x. x.x. X.x. x.oo',vel:.6},
  sparks:notes(4,[[0,'D4',.2,.8],[8,'D4',.2,.6]]),
  strike:notes(4,[[0,'D3',.2,.7],[6.5,'D3',.2,.45],[12,'D3',.2,.6]]),
  breath:notes(4,[[0,'D4',6,.7],[10,'D4',4,.5]]),
  'single-glass':notes(4,[[0,'D5',1,.7],[3,'A5',.5,.5],[6,'E6',.7,.35]]),
  'last-chord':notes(4,[[0,'D4',6,.6],[0,'F4',6,.5],[0,'A4',6,.5],[0,'E5',6,.4]]),
};
// Two four-bar riffs: actual gaps and displaced accents; bass doubles the attacks an octave down.
const riffBars=['D.DD ..D. F.FD ....','D.DD ..Eb. D... ..AA','Bb.BbBb ..Bb. A.AD ....','Eb.EbD ..D. D... ....'];
const riff=[];
riffBars.forEach((bar,b)=>{const cells=bar.replaceAll(' ','').match(/Eb|Bb|[DFA]|\./g);cells.forEach((n,i)=>{if(n!=='.')riff.push([b*4+i/4,n+'3',.17,i%4===0?.9:.62]);});});
patterns.riff=notes(4,riff);
patterns['riff-bass']=notes(4,riff.map(([t,n,d,v])=>[t,n.replace('3','2'),d+.03,v]));
const section=(bars,play,mix={})=>({bars,play,mix,mixScope:'section'});
const groove={glass:'hook',keys:'chords',bass:'bass',kick:'kick',snare:'snare',hat:'hat'};
const iron={'iron-l':'riff','iron-r':'riff',bass:'riff-bass',kick:'stomp',snare:'backbeat',hat:'iron-hat',anvil:'strike'};
const song={schema:'beeps/song@1',name:'matter',title:'Matter',description:'A miniature world built from oscillators: struck glass, broken-beat circuitry, double-tracked iron and a formant-choir release.',tags:['showcase','electronic','cinematic','gritty'],bpm:128,loop:false,
  progressions:{colour:[['Dm9',4],['Bbmaj7',4],['Gm9',4],['A7b9',4]],bloom:[['Dm9',4],['Fmaj9',4],['Bbmaj7#11',4],['Dm6/9',4]]},
  instruments,tracks,patterns,
  sections:{
    glass:section(4,{glass:'glint',dust:'sparks'}),
    current:section(4,{keys:'chords',bass:'bass',hat:'euclid',glass:'glint'}),
    circuit:section(8,groove),
    fracture:section(4,{keys:'chords',bass:'bass',snare:'snare',dust:'sparks'},{keys:{cutoff:1500}}),
    pressure:{...section(4,{air:'breath',anvil:'strike','iron-l':'riff','iron-r':'riff'},{'iron-l':{gainDb:-12,cutoff:4500,from:{gainDb:-22,cutoff:700}},'iron-r':{gainDb:-12,cutoff:4500,from:{gainDb:-22,cutoff:700}}}),ramp:true},
    iron:section(8,iron),
    vacuum:section(4,{glass:'single-glass',dust:'sparks',silk:'last-chord'},{silk:{gainDb:-22}}),
    bloom:section(8,{choir:'choir',silk:'pad',glass:'arp',bass:'bass-bloom',kick:'kick',hat:'euclid'},{silk:{gainDb:-23},glass:{gainDb:-16}}),
    afterglow:section(4,{choir:'last-chord',glass:'single-glass',dust:'sparks'},{choir:{gainDb:-17}}),
  },form:['glass','current','circuit','fracture','pressure','iron','vacuum','bloom','afterglow'],
  master:{reverb:{preset:'hall',returnDb:-8},delay:{beats:.75,feedback:.27,returnDb:-10,cutoff:2800}},
};
mkdirSync(resolve(root,'showcase/recipes'),{recursive:true});
writeFileSync(resolve(root,'showcase/recipes/matter.json'),JSON.stringify(song,null,2)+'\n');
console.log('Wrote Matter: 48 bars, 128 BPM, D minor → D Dorian, nine scenes.');
await import('./compose-expression.mjs');
await import('./compose-flux.mjs');
