'use strict';
const $=id=>document.getElementById(id);
const score=value=>Number.isFinite(value)?value.toFixed(3):'—';
const escapeHtml=value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const columns=['west','south','east','north','incomeOnlineSeg','incomeOfflineSeg','incomeDistance','ageOnlineSeg','ageOfflineSeg','ageDistance','incomeOnlineBivariate','incomeOfflineBivariate','ageOnlineBivariate','ageOfflineBivariate'];
const state={manifest:null,data:null,city:null,profile:'income',measure:'segregation',transparency:27,loading:true,request:0,selected:null};
const single=()=>state.measure!=='segregation';
const bivariate=()=>state.measure==='bivariate';
const distance=()=>state.measure==='distance';
const attribute=()=>state.profile==='income'?'Income':'Age';
const metricKey=mode=>state.profile+(distance()?'Distance':mode?'OfflineSeg':'OnlineSeg');
const metricColumn=mode=>columns.indexOf(metricKey(mode));
const bivariateStart=()=>state.profile==='income'?10:12;
// Only eight single-variable classes are released; colors remain shared across cities.
const segregationStops=[[0,[47,63,134]],[.2,[46,155,184]],[.4,[93,189,138]],[.6,[233,215,78]],[.8,[235,137,72]],[1,[168,40,74]]];
const distanceStops=[[0,[53,68,136]],[.25,[53,164,180]],[.5,[164,207,124]],[.75,[236,179,82]],[1,[174,49,80]]];
function rampColor(stops,value){
  const t=Math.max(0,Math.min(1,value/.4));
  const upper=stops.findIndex(stop=>stop[0]>=t);
  if(upper===0)return 'rgb('+stops[0][1].join(',')+')';
  const [a,from]=stops[upper-1],[b,to]=stops[upper],w=(t-a)/(b-a);
  return 'rgb('+from.map((v,i)=>Math.round(v+(to[i]-v)*w)).join(',')+')';
}
const rampPalette=stops=>Array.from({length:8},(_,level)=>rampColor(stops,level/7*.4));
const rampGradient=stops=>'linear-gradient(90deg,'+rampPalette(stops).flatMap((color,i)=>[color+' '+i*12.5+'%',color+' '+(i+1)*12.5+'%']).join(',')+')';
const segregationPalette=rampPalette(segregationStops),distancePalette=rampPalette(distanceStops);
const segregationGradient=rampGradient(segregationStops),distanceGradient=rampGradient(distanceStops);
const corners={low:[237,241,243],online:[74,166,207],offline:[214,92,92],both:[115,17,125]};
const matrix=Array.from({length:5},(_,online)=>Array.from({length:5},(_,offline)=>{
  const a=online/4,b=offline/4;
  return 'rgb('+corners.low.map((v,i)=>Math.round(v*(1-a)*(1-b)+corners.online[i]*a*(1-b)+corners.offline[i]*(1-a)*b+corners.both[i]*a*b)).join(',')+')';
}));
const mapbox=window.ATLAS_MAPBOX||{};
const hasMapbox=typeof mapbox.accessToken==='string'&&mapbox.accessToken.startsWith('pk.');
const safeStyle=value=>/^[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/.test(value||'');
const emptyGrid=()=>({type:'FeatureCollection',features:[]});
function gridGeoJSON(data){
  if(!data)return emptyGrid();
  if(!data.geojson)data.geojson={type:'FeatureCollection',features:data.rows.map((row,id)=>{
    const [w,s,e,n]=row;
    return {type:'Feature',id,properties:Object.fromEntries(columns.slice(4).map((key,i)=>[key,row[i+4]])),
      geometry:{type:'Polygon',coordinates:[[[w,s],[e,s],[e,n],[w,n],[w,s]]]}};
  })};
  return data.geojson;
}
const vectorGrid=mode=>basemapLayers[mode].find(layer=>layer.gridReady);
function refreshVectorGrids(){basemapLayers.forEach(group=>group.forEach(layer=>layer.syncGrid?.()));}
const maps=['map-online','map-offline'].map(id=>L.map(id,{zoomControl:false,zoomAnimation:false,trackResize:false,preferCanvas:true,minZoom:6,maxZoom:18}).setView([31.21,121.46],11));
let syncing=false,syncFrame;
const basemapLayers=maps.map(()=>[]),logoControls=maps.map(()=>null);
let basemapGeneration=0;
const mapboxAttribution='&copy; <a href="https://www.mapbox.com/about/maps/">Mapbox</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> <a class="mapbox-feedback" href="https://apps.mapbox.com/feedback/" target="_blank" rel="noopener">Improve this map</a>';
maps.forEach((map,mode)=>{
  map.on('move',()=>{
    if(syncing||single())return;
    cancelAnimationFrame(syncFrame);
    syncFrame=requestAnimationFrame(()=>{if(single())return;syncing=true;maps[1-mode].setView(map.getCenter(),map.getZoom(),{animate:false});syncing=false;});
  });
  L.control.zoom({position:'bottomright'}).addTo(map);
  L.control.scale({imperial:false,position:'bottomright'}).addTo(map);
  const pane=map.createPane('atlas-labels');pane.style.zIndex='450';pane.style.pointerEvents='none';
  map.on('moveend',()=>{const p=map.getCenter();map.getContainer().querySelectorAll('.mapbox-feedback').forEach(a=>a.href=`https://apps.mapbox.com/feedback/#/${p.lng}/${p.lat}/${map.getZoom()}`);});
});
// Leaflet owns navigation; the vector renderer follows the same flat camera.
const VectorBasemap=L.Layer.extend({
  initialize(options){L.setOptions(this,options);this.frame=0;this.gl=null;this.removed=false;this.gridReady=false;this.gridData=null;},
  onAdd(map){
    this.map=map;this.removed=false;
    this.container=L.DomUtil.create('div','atlas-mapbox-vector',map.getContainer());
    this.container.setAttribute('aria-hidden','true');this.container.dataset.loaded='false';
    map.on('move zoom resize',this.schedule,this);this.schedule();
  },
  schedule(){cancelAnimationFrame(this.frame);this.frame=requestAnimationFrame(()=>this.sync());},
  sync(){
    if(this.removed||!this.map)return;
    const size=this.map.getSize(),center=this.map.getCenter();
    if(!size.x||!size.y||!this.map.getContainer().clientWidth||!this.map.getContainer().clientHeight)return;
    if(!this.gl){
      try{
        this.gl=new mapboxgl.Map({container:this.container,accessToken:mapbox.accessToken,
          style:'mapbox://styles/'+this.options.styleId,center:[center.lng,center.lat],zoom:this.map.getZoom()-1,
          projection:'mercator',bearing:0,pitch:0,interactive:false,attributionControl:false,
          trackResize:false,fadeDuration:0,language:'en',performanceMetricsCollection:false});
        this.width=size.x;this.height=size.y;
        this.gl.on('load',()=>{if(this.removed)return;this.loaded=true;clearTimeout(this.timer);this.container.dataset.loaded='true';this.schedule();});
        this.gl.on('style.load',()=>{if(this.removed)return;this.styleReady=true;this.gridReady=false;this.gridData=null;this.gl.setProjection('mercator');this.syncGrid();this.schedule();});
        this.gl.on('error',event=>{
          if(this.removed)return;
          const error=event.error||{},message=String(error.message||'');
          if(error.status===401||error.status===403||/unauthorized|invalid token|webgl|style.*not found/i.test(message))this.options.onFailure();
        });
        this.timer=setTimeout(()=>{if(!this.removed&&!this.loaded)this.options.onFailure();},30000);
      }catch(error){this.options.onFailure();return;}
    }
    if(size.x!==this.width||size.y!==this.height){this.gl.resize();this.width=size.x;this.height=size.y;}
    this.gl.jumpTo({center:[center.lng,center.lat],zoom:this.map.getZoom()-1,bearing:0,pitch:0});
    this.container.dataset.camera=[center.lng.toFixed(6),center.lat.toFixed(6),(this.map.getZoom()-1).toFixed(2)].join(',');
  },
  syncGrid(){
    const gl=this.gl;
    if(this.removed||!gl||!this.styleReady)return;
    if(!gl.getSource('atlas-cells')){
      gl.addSource('atlas-cells',{type:'geojson',data:emptyGrid(),tolerance:0,buffer:0});
      const slots=gl.getSlots?.()||[],slot=slots.includes('middle')?{slot:'middle'}:{};
      const before=slot.slot?undefined:gl.getStyle().layers.find(layer=>layer.type==='symbol')?.id;
      gl.addLayer({id:'atlas-cells-fill',type:'fill',source:'atlas-cells',...slot,
        paint:{'fill-color':'#000','fill-antialias':false,'fill-opacity':1-state.transparency/100}},before);
      gl.addLayer({id:'atlas-cells-edge',type:'line',source:'atlas-cells',...slot,minzoom:14,
        paint:{'line-color':'#fff','line-width':.35,'line-opacity':.3*(1-state.transparency/100)}},before);
      for(const [id,color,width] of [['atlas-cell-selected-halo','#fff',3.5],['atlas-cell-selected-outline','#263b36',1.7]]){
        gl.addLayer({id,type:'line',source:'atlas-cells',...slot,filter:['==',['id'],-1],
          paint:{'line-color':color,'line-width':width}},before);
      }
      this.gridReady=true;
      this.container.dataset.gridRenderer='mapbox';
      this.container.dataset.gridPlacement=slot.slot||'below-symbols';
    }
    if(this.gridData!==state.data){gl.getSource('atlas-cells').setData(gridGeoJSON(state.data));this.gridData=state.data;}
    const start=bivariateStart(),online=columns[start],offline=columns[start+1],key=metricKey(this.options.mode);
    const hasValue=name=>['!=',['get',name],null];
    const filter=bivariate()?['all',hasValue(online),hasValue(offline)]:hasValue(key);
    const color=bivariate()?['match',['+',['*',5,['get',online]],['get',offline]],...matrix.flatMap((row,i)=>row.flatMap((value,j)=>[i*5+j,value])),'rgba(0,0,0,0)']:
      ['match',['get',key],...(distance()?distancePalette:segregationPalette).flatMap((value,i)=>[i,value]),'rgba(0,0,0,0)'];
    gl.setFilter('atlas-cells-fill',filter);gl.setFilter('atlas-cells-edge',filter);
    gl.setPaintProperty('atlas-cells-fill','fill-color',color);
    gl.setLayoutProperty('atlas-cells-fill','fill-sort-key',bivariate()?['max',['get',online],['get',offline]]:['get',key]);
    const selected=bivariate()&&state.selected!==null&&state.transparency<100?state.selected:-1;
    for(const id of ['atlas-cell-selected-halo','atlas-cell-selected-outline'])gl.setFilter(id,['==',['id'],selected]);
    this.container.dataset.measure=state.measure;this.container.dataset.profile=state.profile;
    this.container.dataset.cells=String(state.data?.rows.length||0);
    applyTransparency();layers[this.options.mode]?.schedule();
  },
  onRemove(map){
    this.removed=true;this.gridReady=false;cancelAnimationFrame(this.frame);clearTimeout(this.timer);
    map.off('move zoom resize',this.schedule,this);
    if(this.gl){this.gl.remove();this.gl=null;}
    if(this.container)this.container.remove();this.map=null;
  }
});
function failMapbox(generation){
  if(generation!==basemapGeneration)return;
  ++basemapGeneration;
  clearBasemap();
  applyTransparency();layers.forEach(layer=>layer.schedule());
  $('basemap-notice').textContent='Mapbox could not load. Check the token permissions or network.';$('basemap-notice').hidden=false;
}
function clearBasemap(){
  maps.forEach((map,mode)=>{
    basemapLayers[mode].forEach(layer=>map.removeLayer(layer));basemapLayers[mode]=[];
    if(logoControls[mode]){logoControls[mode].remove();logoControls[mode]=null;}
  });
}
function initMapbox(){
  const generation=++basemapGeneration;
  clearBasemap();document.body.dataset.basemap='mapbox';$('basemap-notice').hidden=true;
  const unavailable=!hasMapbox?'Mapbox token is not configured.':typeof mapboxgl==='undefined'||!mapboxgl.supported()?'Mapbox requires WebGL in this browser.':null;
  if(unavailable){$('basemap-notice').textContent=unavailable;$('basemap-notice').hidden=false;return;}
  maps.forEach((map,mode)=>{
    const layers=[];
    const style=safeStyle(mapbox.styleId)?mapbox.styleId:'mapbox/streets-v12';
    layers.push(new VectorBasemap({mode,styleId:style,attribution:mapboxAttribution,onFailure:()=>failMapbox(generation)}));
    if(safeStyle(mapbox.labelsStyleId)){
      const url='https://api.mapbox.com/styles/v1/'+mapbox.labelsStyleId+'/tiles/512/{z}/{x}/{y}?access_token='+encodeURIComponent(mapbox.accessToken);
      layers.push(L.tileLayer(url,{tileSize:512,zoomOffset:-1,maxZoom:18,pane:'atlas-labels'}));
    }
    const logo=L.control({position:'bottomleft'});logo.onAdd=()=>{const a=L.DomUtil.create('a','mapbox-credit');a.href='https://www.mapbox.com/';a.target='_blank';a.rel='noopener';a.innerHTML='<img src="vendor/mapbox-logo.svg" alt="Mapbox" width="80" height="20">';L.DomEvent.disableClickPropagation(a);return a;};logo.addTo(map);logoControls[mode]=logo;
    basemapLayers[mode]=layers;layers.forEach(layer=>layer.addTo(map));
  });
}
function applyTransparency(){
  $('transparency').value=String(state.transparency);
  $('transparency').setAttribute('aria-valuetext',state.transparency+'% transparent');
  $('transparency-value').value=state.transparency+'%';
  layers.forEach((layer,mode)=>{
    const vector=vectorGrid(mode),opacity=1-state.transparency/100;
    layer.canvas.style.opacity=String(vector?0:opacity);layer.canvas.dataset.transparency=String(state.transparency);
    layer.canvas.dataset.renderer=vector?'mapbox':'canvas-fallback';
    if(vector){
      vector.gl.setPaintProperty('atlas-cells-fill','fill-opacity',opacity);
      vector.gl.setPaintProperty('atlas-cells-edge','line-opacity',.3*opacity);
    }
  });
}
function updateLink(){
  if(state.city)history.replaceState(null,'','#'+new URLSearchParams({city:state.city.id,profile:state.profile,measure:state.measure,transparency:state.transparency}));
}
const CellLayer=L.Layer.extend({
  initialize(mode){this.mode=mode;this.frame=0;this.hits=new Map();},
  onAdd(map){this.map=map;this.canvas=L.DomUtil.create('canvas','cell-canvas',map.getPanes().overlayPane);this.canvas.setAttribute('aria-hidden','true');this.schedule=this.schedule.bind(this);map.on('moveend zoomend resize',this.schedule);map.on('click',this.click,this);this.schedule();},
  schedule(){cancelAnimationFrame(this.frame);this.frame=requestAnimationFrame(()=>this.draw());},
  draw(){
    const map=this.map,size=map.getSize(),dpr=window.devicePixelRatio||1;
    L.DomUtil.setPosition(this.canvas,map.containerPointToLayerPoint([0,0]));this.canvas.width=size.x*dpr;this.canvas.height=size.y*dpr;this.canvas.style.width=size.x+'px';this.canvas.style.height=size.y+'px';
    const ctx=this.canvas.getContext('2d');ctx.scale(dpr,dpr);this.canvas.dataset.rendered='0';this.hits.clear();
    if(!state.data||(single()&&this.mode===1))return;
    const bounds=map.getBounds(),start=bivariateStart(),index=metricColumn(this.mode),buckets=Array.from({length:bivariate()?5:8},()=>[]);
    const fallback=!vectorGrid(this.mode);
    for(let i=0;i<state.data.rows.length;i++){
      const row=state.data.rows[i],box=state.data.geometry[i];
      const value=bivariate()?Math.max(row[start],row[start+1]):row[index];
      if(value===null||(bivariate()&&(row[start]===null||row[start+1]===null))||box[2]<bounds.getWest()||box[0]>bounds.getEast()||box[3]<bounds.getSouth()||box[1]>bounds.getNorth())continue;
      buckets[value].push(i);
    }
    // Paint high classes last, preserving strong colors at city scales.
    let rendered=0;
    for(const bucket of buckets)for(const i of bucket){
      const row=state.data.rows[i],box=state.data.geometry[i],nw=map.latLngToContainerPoint([box[3],box[0]]),se=map.latLngToContainerPoint([box[1],box[2]]);
      if(fallback){
        ctx.fillStyle=bivariate()?matrix[row[start]][row[start+1]]:(distance()?distancePalette:segregationPalette)[row[index]];
        ctx.fillRect(nw.x,nw.y,se.x-nw.x,se.y-nw.y);
        if(map.getZoom()>=15){ctx.strokeStyle='#ffffff55';ctx.lineWidth=.35;ctx.strokeRect(nw.x,nw.y,se.x-nw.x,se.y-nw.y);}
      }
      if(bivariate()){
        const cell={index:i,x:nw.x,y:nw.y,width:se.x-nw.x,height:se.y-nw.y};
        for(let x=Math.floor(nw.x/32);x<=Math.floor(se.x/32);x++)for(let y=Math.floor(nw.y/32);y<=Math.floor(se.y/32);y++){
          const key=x+','+y;if(!this.hits.has(key))this.hits.set(key,[]);this.hits.get(key).push(cell);
        }
      }
      rendered++;
    }
    ctx.globalAlpha=1;
    if(fallback&&bivariate()&&state.selected!==null){
      const box=state.data.geometry[state.selected],nw=map.latLngToContainerPoint([box[3],box[0]]),se=map.latLngToContainerPoint([box[1],box[2]]);
      ctx.strokeStyle='#fff';ctx.lineWidth=3.5;ctx.strokeRect(nw.x,nw.y,se.x-nw.x,se.y-nw.y);
      ctx.strokeStyle='#263b36';ctx.lineWidth=1.7;ctx.strokeRect(nw.x,nw.y,se.x-nw.x,se.y-nw.y);
    }
    ctx.globalAlpha=1;this.canvas.dataset.rendered=String(rendered);this.canvas.dataset.measure=state.measure;this.canvas.dataset.profile=state.profile;
  },
  click(event){
    if(!bivariate()||state.loading||state.transparency===100||this.mode!==0)return;
    const p=event.containerPoint,cells=this.hits.get(Math.floor(p.x/32)+','+Math.floor(p.y/32))||[];
    // The last painted containing cell is the visible cell at small scales.
    const cell=[...cells].reverse().find(c=>p.x>=c.x&&p.x<=c.x+c.width&&p.y>=c.y&&p.y<=c.y+c.height);
    state.selected=cell?cell.index:null;renderBivariateLegend();refreshVectorGrids();this.schedule();
  }
});
const layers=maps.map((map,mode)=>new CellLayer(mode).addTo(map));
function renderBivariateLegend(){
  const d=17,point=(i,j)=>[150-d*i+d*j,202-d*i-d*j];
  let svg='<svg viewBox="0 0 300 248" role="img" aria-label="Blue: higher online segregation. Red: higher offline segregation. Purple: both high. Pale: both low.">';
  for(let online=0;online<5;online++)for(let offline=0;offline<5;offline++)svg+=`<polygon class="legend-cell" points="${[point(online,offline),point(online+1,offline),point(online+1,offline+1),point(online,offline+1)].map(p=>p.join(',')).join(' ')}" fill="${matrix[online][offline]}"/>`;
  if(state.data&&state.selected!==null){
    const row=state.data.rows[state.selected],start=bivariateStart(),i=row[start],j=row[start+1];
    if(i!==null&&j!==null)svg+=`<polygon class="legend-cell selected" aria-label="Selected grid color" points="${[point(i,j),point(i+1,j),point(i+1,j+1),point(i,j+1)].map(p=>p.join(',')).join(' ')}" fill="none"/><circle cx="${point(i+.5,j+.5)[0]}" cy="${point(i+.5,j+.5)[1]}" r="3" fill="#fff" stroke="#263b36" stroke-width="1.2"/>`;
  }
  svg+='<text x="150" y="17" text-anchor="middle" fill="#7a6582" font-size="11">Both high</text><text x="150" y="233" text-anchor="middle" fill="#89958f" font-size="10">Both low</text><path d="M124 207L52 135l2 8m-2-8l8 2" fill="none" stroke="#78b3ce"/><text x="76" y="184" text-anchor="middle" transform="rotate(45 76 184)" fill="#397c9d" font-size="11">Online</text><path d="M176 207L248 135l-8 2m8-2l-2 8" fill="none" stroke="#d48585"/><text x="224" y="184" text-anchor="middle" transform="rotate(-45 224 184)" fill="#af6268" font-size="11">Offline</text></svg>';
  $('legend-matrix').innerHTML=svg;$('bivariate-title').textContent=attribute()+' segregation';
}
let layoutFrame;
function scheduleLayout(){cancelAnimationFrame(layoutFrame);layoutFrame=requestAnimationFrame(()=>{
  $('legend-gradient').style.background=(distance()?distanceGradient:segregationGradient).replace('90deg',!single()&&window.innerWidth<=1140?'0deg':'90deg');
  const rect=$('univariate-legend').getBoundingClientRect();document.documentElement.style.setProperty('--legend-clearance',(window.innerHeight-rect.top+16)+'px');
});}
function resizeMaps(){
  const center=maps[0].getCenter(),zoom=maps[0].getZoom();cancelAnimationFrame(syncFrame);syncing=true;
  maps.forEach(map=>{map.invalidateSize({pan:false,animate:false});map.setView(center,zoom,{animate:false});});syncing=false;scheduleLayout();
}
function render(){
  const changed=$('map-grid').classList.contains('single')!==single();
  $('map-grid').classList.toggle('single',single());document.body.dataset.view=state.measure;applyTransparency();
  document.querySelectorAll('[data-profile]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.profile===state.profile)));
  $('measure').value=state.measure;$('univariate-legend').hidden=bivariate();$('bivariate-legend').hidden=!bivariate();$('bivariate-summary').hidden=!bivariate();$('online-stat').hidden=bivariate();
  $('map-online').setAttribute('aria-label',bivariate()?'Bivariate segregation map':distance()?'Composition difference map':'Online visitation map');
  $('online-title').textContent=distance()?'Composition difference':'Online visitation';$('online-stat-label').textContent=distance()?'CITY MEAN':'CITY MEAN · ONLINE';
  $('legend-name').textContent=distance()?'Composition difference':attribute()+' segregation';$('legend-hint').textContent=distance()?'Higher → more different':'Higher → more segregated';
  $('legend-gradient').style.background=distance()?distanceGradient:segregationGradient;
  $('legend-gradient').replaceChildren();
  $('legend-values').innerHTML=['0','0.10','0.20','0.30','≥ 0.35'].map((value,i)=>`<span style="--position:${[0,25,50,75,87.5][i]}%">${value}</span>`).join('');
  $('legend-gradient').setAttribute('aria-label','Eight color classes: below 0.05, 0.05–0.10, 0.10–0.15, 0.15–0.20, 0.20–0.25, 0.25–0.30, 0.30–0.35, and at least 0.35.');
  ['online','offline'].forEach((name,mode)=>{$(name+'-mean').textContent=score(state.data?.summary[metricKey(mode)]?.mean);layers[mode].schedule();});
  refreshVectorGrids();
  const matched=state.data?.matchedSummary[state.profile];$('bivariate-online-mean').textContent=score(matched?.onlineMean);$('bivariate-offline-mean').textContent=score(matched?.offlineMean);renderBivariateLegend();
  if(changed)resizeMaps();else scheduleLayout();
  updateLink();
}
function busy(value){state.loading=value;document.body.classList.toggle('loading',value);$('status').hidden=!value;$('status').textContent='Loading '+(state.city?.name||'atlas')+'…';}
let controller;const cache=new Map();
async function loadCity(){
  controller?.abort();controller=new AbortController();const request=++state.request;state.city=state.manifest.cities.find(city=>city.id===$('city').value);state.data=null;state.selected=null;$('error').hidden=true;busy(true);render();
  try{
    let data=cache.get(state.city.id);
    if(!data){const response=await fetch('data/'+state.city.file,{signal:controller.signal,cache:'no-cache'});if(!response.ok)throw new Error('City data unavailable.');data=await response.json();
      if(data.schemaVersion!==5||data.cellSizeMeters!==300)throw new Error('Please refresh to load the eight-class atlas.');
      // Shared aggregate bounds keep adjacent cells aligned without overlap.
      data.geometry=data.rows.map(row=>row.slice(0,4));
      cache.set(state.city.id,data);if(cache.size>3)cache.delete(cache.keys().next().value);
    }
    if(request!==state.request)return;state.data=data;syncing=true;maps.forEach(map=>map.setView(data.center,11,{animate:false}));syncing=false;render();
  }catch(error){if(request!==state.request||error.name==='AbortError')return;$('error').textContent=error.message+' Please refresh or check the static files.';$('error').hidden=false;}
  finally{if(request===state.request)busy(false);}
}
document.querySelectorAll('[data-profile]').forEach(button=>button.addEventListener('click',()=>{if(state.profile===button.dataset.profile)return;state.profile=button.dataset.profile;state.selected=null;render();}));
$('measure').addEventListener('change',()=>{state.measure=$('measure').value;state.selected=null;render();});$('city').addEventListener('change',loadCity);
$('transparency').addEventListener('input',()=>{state.transparency=Number($('transparency').value);if(state.transparency===100){state.selected=null;renderBivariateLegend();layers[0].schedule();}applyTransparency();updateLink();});
$('fit').addEventListener('click',()=>{if(state.data)maps[0].fitBounds(state.data.bounds,{padding:[40,40],maxZoom:13,animate:false});});
$('about-open').addEventListener('click',()=>$('about-dialog').showModal());
document.querySelector('[data-close="about-dialog"]').addEventListener('click',()=>$('about-dialog').close());
$('about-dialog').addEventListener('click',event=>{if(event.target!==$('about-dialog'))return;const r=$('about-dialog').getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)$('about-dialog').close();});
window.addEventListener('resize',resizeMaps);
async function init(){try{
  const response=await fetch('data/manifest.json',{cache:'no-cache'});if(!response.ok)throw new Error('Atlas manifest unavailable.');state.manifest=await response.json();
  if(state.manifest.schemaVersion!==5||state.manifest.cellSizeMeters!==300||JSON.stringify(state.manifest.columns)!==JSON.stringify(columns)||state.manifest.classification?.distance?.classCount!==8||state.manifest.classification?.distance?.step!==.05||state.manifest.classification?.distance?.cap!==.35)throw new Error('The eight-class atlas is being prepared. Please refresh shortly.');
  const params=new URLSearchParams(location.hash.slice(1)),transparency=params.has('transparency')?Number(params.get('transparency')):params.get('context')==='streets'?40:27;
  state.transparency=Number.isFinite(transparency)?Math.max(0,Math.min(100,Math.round(transparency))):27;if(params.get('profile')==='age')state.profile='age';if(['segregation','distance','bivariate'].includes(params.get('measure')))state.measure=params.get('measure');
  const cities=[...state.manifest.cities].sort((a,b)=>a.name.localeCompare(b.name));$('city').innerHTML=cities.map(city=>`<option value="${city.id}">${escapeHtml(city.name)}</option>`).join('');$('city').value=cities.some(city=>city.id===params.get('city'))?params.get('city'):cities.find(city=>city.name==='Shanghai')?.id||cities[0].id;$('city').disabled=false;
  $('city-count').textContent=String(cities.length);
  initMapbox();await loadCity();
}catch(error){$('error').textContent=error.message+' Open through a local or hosted web server.';$('error').hidden=false;busy(false);}}
init();
