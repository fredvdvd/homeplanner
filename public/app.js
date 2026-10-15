(function(){
  var COLS=[{id:'backlog',name:'Backlog'},{id:'next',name:'This week'},{id:'doing',name:'In progress'},{id:'done',name:'Done'}];
  var H0=7,H1=22,HH=56,SNAP=15,LS='dayplanner.v1';
  var DURS=[15,30,45,60,90,120,180,240];
  var $=function(s){return document.querySelector(s)};
  var state={tasks:[]};
  var selDate=iso(new Date());
  var dragId=null,grabMin=0,dirty=false,saveT=null;

  function iso(d){var m=d.getMonth()+1,x=d.getDate();return d.getFullYear()+'-'+(m<10?'0':'')+m+'-'+(x<10?'0':'')+x}
  function parse(s){var p=s.split('-');return new Date(+p[0],+p[1]-1,+p[2])}
  function addDays(s,n){var d=parse(s);d.setDate(d.getDate()+n);return iso(d)}
  function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
  function uid(){return 't'+Date.now().toString(36)+Math.random().toString(36).slice(2,6)}
  function hm(min){var h=Math.floor(min/60),m=min%60;return (h<10?'0':'')+h+':'+(m<10?'0':'')+m}
  function human(min){var h=Math.floor(min/60),m=min%60;return (h?h+'h':'')+(h&&m?' ':'')+(m?m+'m':'')||'0m'}
  function toMin(t){if(!t)return null;var p=t.split(':');return +p[0]*60+ +p[1]}
  function dayLabel(s){return parse(s).toLocaleDateString(undefined,{weekday:'long',month:'long',day:'numeric'})}
  function byId(id){return state.tasks.find(function(t){return t.id===id})}

  /* ---------- storage (server API) ---------- */
  var version=0,saving=false;
  function lsGet(){try{var r=localStorage.getItem(LS);return r?JSON.parse(r):null}catch(e){return null}}
  function lsSet(){try{localStorage.setItem(LS,JSON.stringify(state))}catch(e){}}
  function setSync(t){$('#sync').textContent=t}
  function changed(){
    dirty=true;lsSet();setSync('Saving\u2026');
    clearTimeout(saveT);
    saveT=setTimeout(flush,500);
  }
  function api(method,body){
    return fetch('/api/tasks',{method:method,credentials:'same-origin',headers:{'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined})
      .then(function(r){
        if(r.status===401){location.reload();throw new Error('auth')}
        return r.json().then(function(j){return {status:r.status,body:j}});
      });
  }
  function retry(){dirty=true;setSync('Offline \u2013 will retry');clearTimeout(saveT);saveT=setTimeout(flush,5000)}
  function flush(){
    if(!dirty)return;
    if(saving){saveT=setTimeout(flush,300);return}
    saving=true;dirty=false;
    api('PUT',{tasks:state.tasks,version:version}).then(function(r){
      if(r.status===200){version=r.body.version;if(!dirty)setSync('Saved')}
      else if(r.status===409){version=r.body.version;state={tasks:r.body.tasks};lsSet();render();toast('Updated from another device');setSync('Saved')}
      else retry();
    }).catch(retry).then(function(){saving=false});
  }
  function load(first){
    return api('GET').then(function(r){
      if(r.status!==200||dirty||saving)return;
      if(first&&r.body.version===0&&r.body.tasks.length===0){state=seed();lsSet();dirty=true;render();flush();return}
      if(first||r.body.version!==version){version=r.body.version;state={tasks:r.body.tasks};lsSet();render();setSync('Saved')}
    }).catch(function(){setSync('Offline')});
  }
  function connect(){
    load(true);
    setInterval(function(){load(false)},30000);
    document.addEventListener('visibilitychange',function(){if(!document.hidden)load(false)});
    window.addEventListener('online',function(){if(dirty)flush();else load(false)});
  }

  function seed(){
    var t=iso(new Date());
    return {tasks:[
      {id:uid(),title:'Plan the week',notes:'',col:'doing',prio:2,date:t,start:540,dur:30},
      {id:uid(),title:'Reply to important emails',notes:'',col:'next',prio:1,date:t,start:600,dur:45},
      {id:uid(),title:'Deep work block',notes:'',col:'next',prio:2,date:t,start:null,dur:120},
      {id:uid(),title:'Book dentist',notes:'',col:'backlog',prio:0,date:null,start:null,dur:15}
    ]};
  }

  /* ---------- calendar events (read-only overlay) ---------- */
  var evCache={},evPending={};
  function events(date){
    var c=evCache[date];
    if(c&&Date.now()-c.at<60000)return c.list;
    if(!evPending[date]){
      evPending[date]=true;
      fetch('/api/events?date='+date,{credentials:'same-origin'}).then(function(r){return r.ok?r.json():null}).then(function(j){
        evPending[date]=false;
        if(!j)return;
        var changed=!c||JSON.stringify(c.list)!==JSON.stringify(j.events);
        evCache[date]={at:Date.now(),list:j.events};
        if(changed&&date===selDate)renderDay();
      }).catch(function(){evPending[date]=false});
    }
    return c?c.list:[];
  }

  /* ---------- render ---------- */
  function render(){renderBoard();renderDay();}

  function metaFor(t){
    var bits=[];
    if(t.date){var d=parse(t.date);bits.push(d.toLocaleDateString(undefined,{month:'short',day:'numeric'})+(t.start!=null?' '+hm(t.start):''))}
    if(t.dur)bits.push(human(t.dur));
    return bits.map(function(b){return '<span>'+esc(b)+'</span>'}).join('');
  }

  function renderBoard(){
    var h='';
    COLS.forEach(function(c){
      var list=state.tasks.filter(function(t){return t.col===c.id});
      h+='<div class="col" data-col="'+c.id+'"><h3><i style="background:var(--c-'+c.id+')"></i>'+c.name+'<span class="n">'+list.length+'</span></h3><div class="cards">';
      list.forEach(function(t){
        h+='<button class="card p'+t.prio+(t.col==='done'?' done':'')+'" draggable="true" data-id="'+t.id+'"><div class="t">'+esc(t.title)+'</div>'+(metaFor(t)?'<div class="m">'+metaFor(t)+'</div>':'')+'</button>';
      });
      if(!list.length)h+='<div class="empty">'+(c.id==='done'?'Finished tasks land here.':'Drop a task here.')+'</div>';
      h+='</div><div class="add"><input data-add="'+c.id+'" placeholder="Add a task" aria-label="Add a task to '+c.name+'" maxlength="140"></div></div>';
    });
    $('#board').innerHTML=h;
  }

  function weekStart(s){var d=parse(s);var w=(d.getDay()+6)%7;d.setDate(d.getDate()-w);return iso(d)}

  function renderDay(){
    var today=iso(new Date());
    var ws=weekStart(selDate),dh='';
    for(var i=0;i<7;i++){
      var ds=addDays(ws,i),d=parse(ds);
      var has=state.tasks.some(function(t){return t.date===ds&&t.col!=='done'});
      dh+='<button class="wd'+(has?' has':'')+(ds===today?' today':'')+'" data-day="'+ds+'" aria-pressed="'+(ds===selDate)+'" aria-label="'+esc(dayLabel(ds))+'"><small>'+d.toLocaleDateString(undefined,{weekday:'short'})+'</small><b>'+d.getDate()+'</b><span class="dot"></span></button>';
    }
    $('#days').innerHTML=dh;
    $('#dayTitle').textContent=selDate===today?'Today':dayLabel(selDate);
    var dayTasks=state.tasks.filter(function(t){return t.date===selDate});
    var sched=dayTasks.filter(function(t){return t.start!=null});
    var uns=dayTasks.filter(function(t){return t.start==null&&t.col!=='done'});
    var planned=sched.filter(function(t){return t.col!=='done'}).reduce(function(a,t){return a+(t.dur||60)},0);
    var open=dayTasks.filter(function(t){return t.col!=='done'}).length;
    $('#daySum').textContent=open+' open'+(planned?' \u00b7 '+human(planned)+' blocked':'');
    $('#todayBtn').style.visibility=selDate===today?'hidden':'visible';

    var evs=events(selDate);
    var u='';
    var allDay=evs.filter(function(e){return e.allDay});
    if(allDay.length){allDay.forEach(function(e){u+='<span class="chip ev" title="Calendar, all day">'+esc(e.title)+'</span>'})}
    if(uns.length){u+='<div class="unsched-label">Not scheduled yet</div>';uns.forEach(function(t){u+='<button class="chip" draggable="true" data-id="'+t.id+'" title="Drag onto the timeline">'+esc(t.title)+'</button>'})}
    $('#unsched').innerHTML=u;

    var total=(H1-H0)*HH,tl='';
    for(var h=H0;h<=H1;h++){
      var y=(h-H0)*HH;
      tl+='<div class="hr" style="top:'+y+'px"><span>'+(h<10?'0':'')+h+':00</span></div>';
      if(h<H1)tl+='<div class="hr half" style="top:'+(y+HH/2)+'px"></div>';
    }
    // lanes for overlaps
    var items=sched.map(function(t){return {t:t,s:t.start,e:t.start+(t.dur||60)}})
      .concat(evs.filter(function(e){return !e.allDay}).map(function(e){return {ev:e,s:e.start,e:Math.max(e.end,e.start+15)}}))
      .sort(function(a,b){return a.s-b.s});
    var lanes=[];
    items.forEach(function(it){
      var placed=false;
      for(var l=0;l<lanes.length;l++){if(lanes[l]<=it.s){it.lane=l;lanes[l]=it.e;placed=true;break}}
      if(!placed){it.lane=lanes.length;lanes.push(it.e)}
    });
    // lane count per cluster (simple: global max among overlapping)
    items.forEach(function(it){
      var n=1;
      items.forEach(function(o){if(o.s<it.e&&o.e>it.s)n=Math.max(n,o.lane+1,it.lane+1)});
      it.n=n;
    });
    items.forEach(function(it){
      var t=it.t,top=(it.s-H0*60)/60*HH,ht=Math.max(22,(it.e-it.s)/60*HH-2);
      var w=100/it.n;
      if(it.ev){
        tl+='<div class="evb" title="Calendar event" style="top:'+top+'px;height:'+ht+'px;left:calc('+(it.lane*w)+'% + 2px);width:calc('+w+'% - 4px)">'+esc(it.ev.title)+(ht>40?'<small>'+hm(it.s)+'\u2013'+hm(it.e)+'</small>':'')+'</div>';
        return;
      }
      tl+='<button class="blk p'+t.prio+(t.col==='done'?' done':'')+'" draggable="true" data-id="'+t.id+'" style="top:'+top+'px;height:'+ht+'px;left:calc('+(it.lane*w)+'% + 2px);width:calc('+w+'% - 4px)">'+esc(t.title)+(ht>40?'<small>'+hm(it.s)+'\u2013'+hm(it.e)+'</small>':'')+'</button>';
    });
    tl+='<div class="nowline" id="now" style="display:none"></div>';
    var el=$('#tl');el.style.height=total+'px';el.innerHTML=tl;
    placeNow();
  }

  function placeNow(){
    var n=$('#now');if(!n)return;
    var d=new Date(),m=d.getHours()*60+d.getMinutes();
    if(selDate!==iso(d)||m<H0*60||m>H1*60){n.style.display='none';return}
    n.style.display='block';n.style.top=((m-H0*60)/60*HH)+'px';
  }
  setInterval(placeNow,60000);

  /* ---------- calendar settings ---------- */
  function postJson(url,body){return fetch(url,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})}
  function initCalendar(){
    var tz='';try{tz=Intl.DateTimeFormat().resolvedOptions().timeZone}catch(e){}
    fetch('/api/me',{credentials:'same-origin'}).then(function(r){return r.ok?r.json():null}).then(function(me){
      if(!me)return;
      if(tz&&tz!==me.tz)postJson('/api/me/settings',{tz:tz});
      if(!me.calendar.connected)toast('Calendar not connected \u2013 use Calendar \u2192 Reconnect');
      else if(me.calendar.error)toast('Calendar sync: '+me.calendar.error);
    }).catch(function(){});
    $('#calCancel').onclick=function(){$('#calDlg').close()};
    $('#calBtn').onclick=function(){
      $('#calStatus').textContent='Loading\u2026';$('#calDlg').showModal();
      Promise.all([
        fetch('/api/me',{credentials:'same-origin'}).then(function(r){return r.json()}),
        fetch('/api/calendars',{credentials:'same-origin'}).then(function(r){return r.ok?r.json():{calendars:[]}})
      ]).then(function(a){
        var me=a[0].calendar,cals=a[1].calendars;
        $('#calStatus').textContent=me.connected?(me.error?'Last sync problem: '+me.error:'Connected. Tasks with a date and start time appear in your calendar; moving or finishing them updates it.'):'Not connected. Use Reconnect Google and allow calendar access.';
        var target=me.target==='primary'?(cals.filter(function(c){return c.primary})[0]||{}).id||me.target:me.target;
        $('#calTarget').innerHTML=cals.filter(function(c){return c.writable}).map(function(c){return '<option value="'+esc(c.id)+'"'+(c.id===target?' selected':'')+'>'+esc(c.name)+(c.primary?' (primary)':'')+'</option>'}).join('');
        var show={};me.show.forEach(function(id){show[id]=1});
        var prim=(cals.filter(function(c){return c.primary})[0]||{}).id;if(show.primary&&prim)show[prim]=1;
        $('#calShow').innerHTML=cals.map(function(c){return '<label><input type="checkbox" value="'+esc(c.id)+'"'+(show[c.id]?' checked':'')+'>'+esc(c.name)+'</label>'}).join('');
      }).catch(function(){$('#calStatus').textContent='Could not load calendars.'});
    };
    $('#calSave').onclick=function(){
      var show=[].slice.call(document.querySelectorAll('#calShow input:checked')).map(function(i){return i.value});
      var body={calShow:show};
      if($('#calTarget').value)body.calTarget=$('#calTarget').value;
      postJson('/api/me/settings',body).then(function(r){
        if(!r.ok)throw 0;
        evCache={};$('#calDlg').close();renderDay();toast('Calendar settings saved');
      }).catch(function(){toast('Could not save')});
    };
  }

  /* ---------- actions ---------- */
  function toast(t){var e=$('#toast');e.textContent=t;e.classList.add('show');clearTimeout(toast.t);toast.t=setTimeout(function(){e.classList.remove('show')},1800)}
  function addTask(title,col,extra){
    title=(title||'').trim();if(!title)return;
    var t=Object.assign({id:uid(),title:title,notes:'',col:col||'backlog',prio:0,date:null,start:null,dur:60},extra||{});
    state.tasks.push(t);changed();render();return t;
  }
  function moveToCol(id,col,beforeId){
    var t=byId(id);if(!t)return;
    state.tasks=state.tasks.filter(function(x){return x.id!==id});
    t.col=col;
    var idx=beforeId?state.tasks.findIndex(function(x){return x.id===beforeId}):-1;
    if(idx<0)state.tasks.push(t);else state.tasks.splice(idx,0,t);
    changed();render();
  }
  function snap(min){return Math.round(min/SNAP)*SNAP}

  /* ---------- dialog ---------- */
  var editing=null,pre=null;
  function openEdit(id,preset){
    editing=id?byId(id):null;pre=preset||{};
    var t=editing||Object.assign({title:'',notes:'',col:'backlog',prio:0,date:null,start:null,dur:60},pre);
    $('#dlgTitle').textContent=editing?'Edit task':'New task';
    $('#fTitle').value=t.title;$('#fNotes').value=t.notes||'';
    $('#fCol').value=t.col;$('#fPrio').value=String(t.prio);
    $('#fDate').value=t.date||'';$('#fStart').value=t.start!=null?hm(t.start):'';
    $('#fDur').value=String(t.dur||60);
    $('#fDel').style.visibility=editing?'visible':'hidden';
    $('#dlg').showModal();
    setTimeout(function(){$('#fTitle').focus()},30);
  }
  function saveEdit(){
    var title=$('#fTitle').value.trim();
    if(!title){$('#fTitle').focus();toast('Give the task a title');return}
    var date=$('#fDate').value||null,start=toMin($('#fStart').value);
    if(start!=null&&!date)date=selDate;
    var data={title:title,notes:$('#fNotes').value,col:$('#fCol').value,prio:+$('#fPrio').value,date:date,start:date?start:null,dur:+$('#fDur').value};
    if(editing)Object.assign(editing,data);
    else state.tasks.push(Object.assign({id:uid()},data));
    $('#dlg').close();changed();render();
  }

  /* ---------- events ---------- */
  function init(){
    $('#fCol').innerHTML=COLS.map(function(c){return '<option value="'+c.id+'">'+c.name+'</option>'}).join('');
    $('#fDur').innerHTML=DURS.map(function(d){return '<option value="'+d+'">'+human(d)+'</option>'}).join('');

    $('#newBtn').onclick=function(){openEdit(null,{date:selDate})};

    var SR=window.SpeechRecognition||window.webkitSpeechRecognition,mic=$('#micBtn'),rec=null;
    if(SR){
      mic.hidden=false;
      mic.onclick=function(){
        if(rec){rec.stop();return}
        rec=new SR();
        rec.lang=navigator.language||'en-US';
        rec.interimResults=false;
        rec.onresult=function(e){
          var text=e.results[0][0].transcript.trim().slice(0,140);
          if(!text)return;
          text=text.charAt(0).toUpperCase()+text.slice(1);
          addTask(text,'backlog');toast('Added: '+text);
        };
        rec.onerror=function(e){toast(e.error==='not-allowed'||e.error==='service-not-allowed'?'Microphone access is blocked':e.error==='no-speech'?'Heard nothing':'Voice input failed')};
        rec.onend=function(){rec=null;mic.classList.remove('rec');mic.setAttribute('aria-pressed','false')};
        mic.classList.add('rec');mic.setAttribute('aria-pressed','true');
        toast('Listening\u2026');
        try{rec.start()}catch(err){rec=null;mic.classList.remove('rec')}
      };
    }
    $('#fSave').onclick=saveEdit;
    $('#fCancel').onclick=function(){$('#dlg').close()};
    $('#fDel').onclick=function(){if(editing){state.tasks=state.tasks.filter(function(t){return t!==editing});$('#dlg').close();changed();render();toast('Task deleted')}};
    $('#dlg').addEventListener('keydown',function(e){if(e.key==='Enter'&&e.target.id==='fTitle'){e.preventDefault();saveEdit()}});

    $('#prevW').onclick=function(){selDate=addDays(selDate,-7);renderDay()};
    $('#nextW').onclick=function(){selDate=addDays(selDate,7);renderDay()};
    $('#todayBtn').onclick=function(){selDate=iso(new Date());renderDay()};
    $('#days').addEventListener('click',function(e){var b=e.target.closest('[data-day]');if(b){selDate=b.dataset.day;renderDay()}});

    document.querySelectorAll('[data-tab]').forEach(function(b){b.onclick=function(){
      $('#layout').dataset.view=b.dataset.tab;
      document.querySelectorAll('[data-tab]').forEach(function(x){x.setAttribute('aria-pressed',x===b)});
    }});

    $('#themeBtn').onclick=function(){
      var r=document.documentElement,cur=r.getAttribute('data-theme');
      var dark=cur?cur==='dark':window.matchMedia('(prefers-color-scheme: dark)').matches;
      r.setAttribute('data-theme',dark?'light':'dark');
    };

    // open card / block / chip
    document.addEventListener('click',function(e){
      var c=e.target.closest('.card,.blk,.chip');
      if(c&&c.dataset.id&&!dragId){openEdit(c.dataset.id)}
    });

    // quick add on board
    $('#board').addEventListener('keydown',function(e){
      if(e.key==='Enter'&&e.target.dataset.add){
        var col=e.target.dataset.add,v=e.target.value;
        var extra=col==='next'||col==='doing'?{date:selDate}:{};
        addTask(v,col,extra);
        var again=document.querySelector('[data-add="'+col+'"]');if(again)again.focus();
      }
    });

    // drag & drop
    document.addEventListener('dragstart',function(e){
      var c=e.target.closest&&e.target.closest('.card,.blk,.chip');
      if(!c)return;
      dragId=c.dataset.id;grabMin=0;
      if(c.classList.contains('blk')){grabMin=snap((e.clientY-c.getBoundingClientRect().top)/HH*60)}
      e.dataTransfer.effectAllowed='move';
      try{e.dataTransfer.setData('text/plain',dragId)}catch(_){}
      setTimeout(function(){c.classList.add('dragging')},0);
    });
    document.addEventListener('dragend',function(){
      dragId=null;
      document.querySelectorAll('.dragging').forEach(function(x){x.classList.remove('dragging')});
      document.querySelectorAll('.over').forEach(function(x){x.classList.remove('over')});
    });
    $('#board').addEventListener('dragover',function(e){
      var col=e.target.closest('.col');if(!col||!dragId)return;
      e.preventDefault();
      document.querySelectorAll('.col.over').forEach(function(x){if(x!==col)x.classList.remove('over')});
      col.classList.add('over');
    });
    $('#board').addEventListener('drop',function(e){
      var col=e.target.closest('.col');if(!col||!dragId)return;
      e.preventDefault();
      var before=e.target.closest('.card');
      var id=dragId;dragId=null;
      moveToCol(id,col.dataset.col,before&&before.dataset.id!==id?before.dataset.id:null);
    });
    var tl=$('#tl');
    function minAt(e){
      var r=tl.getBoundingClientRect();
      return H0*60+snap((e.clientY-r.top)/HH*60);
    }
    tl.addEventListener('dragover',function(e){if(dragId){e.preventDefault();tl.classList.add('over')}});
    tl.addEventListener('dragleave',function(e){if(e.target===tl)tl.classList.remove('over')});
    tl.addEventListener('drop',function(e){
      e.preventDefault();tl.classList.remove('over');
      var t=byId(dragId);if(!t)return;
      var s=minAt(e)-grabMin,dur=t.dur||60;
      s=Math.max(H0*60,Math.min(s,H1*60-dur));
      t.date=selDate;t.start=s;t.dur=dur;
      if(t.col==='backlog')t.col='next';
      dragId=null;changed();render();
    });
    // click empty slot to add
    tl.addEventListener('click',function(e){
      if(e.target.closest('.blk,.evb'))return;
      var s=Math.max(H0*60,Math.min(minAt(e),(H1-1)*60));
      s=Math.floor(s/30)*30;
      openEdit(null,{date:selDate,start:s,col:'next'});
    });
  }

  init();
  initCalendar();
  $('#logoutBtn').onclick=function(){fetch('/api/logout',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:'{}'}).then(function(){location.reload()})};
  var cached=lsGet();
  state=cached&&Array.isArray(cached.tasks)?cached:{tasks:[]};
  render();
  setSync('Loading\u2026');
  (function(){var n=new Date().getHours();var h=Math.min(Math.max(n,H0),H1-6);$('#tlWrap').scrollTop=(h-H0)*HH-20})();
  connect();
})();
