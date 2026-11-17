/* 3.0.0：数据不再放 localStorage，改由主进程写入 todo-data.json。
   渲染层只认 window.todoAPI.loadData / saveData，结构定义见 data-layer.js。 */
var api=window.todoAPI||null;
var S={todos:[],ideas:[],habits:[],books:[],curBook:0,readDays:{},ledger:[],moodLog:[],moodPick:0,
       journal:"",journals:[],settings:{motion:true,autoStart:false,keepRunning:false},seeded:false,
       planDays:{},goalLog:[],lastPlanDay:''};
var $=function(s,r){return (r||document).querySelector(s);};
var ce=function(t,c){var e=document.createElement(t);if(c)e.className=c;return e;};
/* 保存节流：界面上连续操作（拖拽、连点）只落一次盘 */
var saveTimer=null,saveInFlight=false;
function persist(){
  if(!api||!api.saveData)return;
  clearTimeout(saveTimer);
  saveTimer=setTimeout(function(){
    if(saveInFlight)return;
    saveInFlight=true;
    try{
      var p=api.saveData(JSON.parse(JSON.stringify(S)));
      if(p&&p.then)p.then(function(){saveInFlight=false;},function(){saveInFlight=false;});
      else saveInFlight=false;
    }catch(e){saveInFlight=false;}
  },120);
}
function save(){updateStatCard();persist();}

/* ═══ v8 计划/目标历史：跨天归档 ═══════════════════════════
   启动时（以及跨零点后每分钟）检查：把上次归档日的计划与目标各存一份快照。
   今日任务：已完成的移出轨道，未完成的顺延到今天；
   阶段性任务：长期项，不移动不清除，只按天存状态快照（可查某天有哪些目标、完成到哪一步）；
   多天没打开时，中间几天没有快照 —— 文件里只有最后状态，不伪造历史。 */
function rollPlanDay(){
  if(!S.planDays||typeof S.planDays!=='object')S.planDays={};
  if(!Array.isArray(S.goalLog))S.goalLog=[];
  var tk=dayKey(TODAY());
  if(!S.lastPlanDay){S.lastPlanDay=tk;return true;}
  if(S.lastPlanDay===tk)return false;
  var list=S.todos.filter(function(x){return x.hor==='today';});
  var goals=S.todos.filter(function(x){return x.hor!=='today';});
  if(list.length||goals.length){
    S.planDays[S.lastPlanDay]={
      items:list.map(function(x){return {t:x.t,k:x.k,note:x.note,done:!!x.done};}),
      done:list.filter(function(x){return x.done;}).length,total:list.length,
      goals:goals.map(function(x){return {t:x.t,k:x.k,note:x.note,done:!!x.done,hor:x.hor};}),
      goalDone:goals.filter(function(x){return x.done;}).length,goalTotal:goals.length
    };
  }
  S.todos=S.todos.filter(function(x){return x.hor!=='today'||!x.done;});
  S.lastPlanDay=tk;
  return true;
}
function logGoal(t,hor,action){
  if(!Array.isArray(S.goalLog))S.goalLog=[];
  S.goalLog.unshift({ts:Date.now(),t:t,hor:hor,action:action});
  if(S.goalLog.length>300)S.goalLog.length=300;
}
/* 目标完成日期：从目标动态里取最后一次「完成」的时间 */
function goalDoneDate(t){
  var g=(S.goalLog||[]).filter(function(x){return x.t===t&&x.action==='done';})[0];
  if(!g)return '';
  var d=new Date(g.ts);
  return d.getFullYear()+'.'+two(d.getMonth()+1)+'.'+two(d.getDate());
}
function planHistoryHTML(focusDay){
  var keys=Object.keys(S.planDays||{}).sort().reverse(),h='',n=0;
  keys.forEach(function(k){
    var d=S.planDays[k];if(!(d.items||[]).length)return;
    n++;
    h+='<div class="ph-day'+(k===focusDay?' focus':'')+'" data-day="'+k+'">'+
      '<div class="ph-h"><b>'+esc(k)+'</b><span>'+d.done+' / '+d.total+' 已完成</span></div><ul>';
    (d.items||[]).forEach(function(it){
      h+='<li class="'+(it.done?'done':'')+'">'+(it.done?'✓':'○')+' '+esc(it.t)+
        (it.note?'<i>'+esc(it.note)+'</i>':'')+'</li>';
    });
    h+='</ul></div>';
  });
  return n?h:'<div class="s-empty">还没有计划历史 · 从明天起，今天的计划会自动归档 📂</div>';
}
function goalHistoryHTML(focusDay){
  var keys=Object.keys(S.planDays||{}).sort().reverse(),h='',n=0;
  keys.forEach(function(k){
    var d=S.planDays[k],gs=d.goals||[];if(!gs.length)return;
    n++;
    h+='<div class="ph-day'+(k===focusDay?' focus':'')+'" data-day="'+k+'">'+
      '<div class="ph-h"><b>'+esc(k)+'</b><span>'+(d.goalDone||0)+' / '+(d.goalTotal||gs.length)+' 已完成</span></div>';
    ['short','mid','long'].forEach(function(hz){
      var sub=gs.filter(function(g){return g.hor===hz;});
      if(!sub.length)return;
      h+='<div class="ph-grp"><em>'+({short:'短期',mid:'中期',long:'长期'}[hz])+'</em><ul>';
      sub.forEach(function(g){
        var fin=g.done?goalDoneDate(g.t):'';
        h+='<li class="'+(g.done?'done':'')+'">'+(g.done?'✓':'○')+' '+esc(g.t)+
          (fin?'<i>完成于 '+fin+'</i>':'')+(g.note?'<i>'+esc(g.note)+'</i>':'')+'</li>';
      });
      h+='</ul></div>';
    });
    h+='</div>';
  });
  if(!n)h='<div class="s-empty">还没有目标历史 · 从明天起，每天的目标状态会自动归档 🎯</div>';
  /* 11-17 用户定：底部那块「目标动态」（目标新增/完成/删除的流水）整块去掉。
     goalLog 仍然照常记录 —— goalDoneDate() 要靠它算「完成于 X 月 X 日」。 */
  return h;
}
function historyPaneHTML(tab,focusDay){
  return tab==='goals'?goalHistoryHTML(focusDay):planHistoryHTML(focusDay);
}
function openPlanHistory(focusDay,tab){
  tab=tab||'plan';
  openModal('历史档案',{view:true,viewHtml:
    '<div class="ph-tabs"><button class="ph-tab'+(tab==='plan'?' on':'')+'" data-tab="plan" type="button">今日任务</button>'+
    '<button class="ph-tab'+(tab==='goals'?' on':'')+'" data-tab="goals" type="button">阶段性任务</button></div>'+
    '<div class="plan-hist" id="phPane">'+historyPaneHTML(tab,focusDay)+'</div>'+
    '<div class="ph-acts"><button class="jview-btn neutral" type="button" id="phClose">关闭</button></div>'});
  modalBox.classList.add('hist');
  var c=$('#phClose');if(c)c.addEventListener('click',closeModal);
  var pane=$('#phPane');
  modalBox.querySelectorAll('.ph-tab').forEach(function(b){
    b.addEventListener('click',function(){
      modalBox.querySelectorAll('.ph-tab').forEach(function(x){x.classList.toggle('on',x===b);});
      pane.innerHTML=historyPaneHTML(b.dataset.tab,focusDay);
      pane.scrollTop=0;
      var f2=pane.querySelector('.ph-day.focus');if(f2&&f2.scrollIntoView)f2.scrollIntoView({block:'nearest'});
    });
  });
  if(focusDay&&pane){var f=pane.querySelector('.ph-day.focus');if(f&&f.scrollIntoView)f.scrollIntoView({block:'nearest'});}
}
window.addEventListener('beforeunload',function(){
  if(!api||!api.saveData)return;
  clearTimeout(saveTimer);
  try{api.saveData(JSON.parse(JSON.stringify(S)));}catch(e){}
});

/* 日期工具：日历、打卡、演示数据共用，必须在顶层 */
function dayKey(d){return d.getFullYear()+'.'+String(d.getMonth()+1).padStart(2,'0')+'.'+String(d.getDate()).padStart(2,'0');}
function TODAY(){var d=new Date();return new Date(d.getFullYear(),d.getMonth(),d.getDate());}
function shiftDay(base,n){return new Date(base.getFullYear(),base.getMonth(),base.getDate()+n);}

/* 【当前不调用 · 11-17 停用】原「全新安装才灌的演示数据」。
   停用原因：新装用户什么都没建，概览却出现假的阶段任务账目与「第 31 天练习」，
   被用户当成 BUG 反馈。现在新装一律从空白开始。
   函数保留仅作日后「主动体验示例」入口用，不要在 boot() 里无调用。 */
function seedDemo(){
if(!S.todos.length)S.todos=[
 {t:"完成季度 OKR 复盘",k:"imp",note:"对齐目标",done:true,hor:"today"},
 {t:"晨间日报手帐",k:"daily",note:"已同步",done:true,hor:"today"},
 {t:"准备季度汇报 PPT",k:"heavy",note:"配图待定",done:false,hor:"today"},
 {t:"读《认知觉醒》1 章",k:"daily",note:"第 9 章",done:false,hor:"today"},
 {t:"健身 40 分钟",k:"imp",note:"练腿日",done:false,hor:"today"},
 {t:"记账今日支出",k:"daily",note:"咖啡 ¥28",done:false,hor:"today"},
 {t:"回复合作邮件",k:"heavy",note:"3 封",done:false,hor:"short"},
 {t:"灵感墙贴一张",k:"daily",note:"选题待定",done:false,hor:"short"},
 {t:"整理项目文档",k:"daily",note:"API/架构",done:false,hor:"short",ten:"持续 7 天"},
 {t:"学习 React 新特性",k:"imp",note:"并发渲染",done:false,hor:"mid",ten:"持续 12 天"},
 {t:"读完《认知觉醒》",k:"heavy",note:"8/12 章",done:false,hor:"mid",dl:"7天后截止"},
 {t:"提升团队协作效率",k:"imp",note:"周会流程",done:false,hor:"long",ten:"持续 22 天"}
];
if(!S.ideas.length)S.ideas=[{t:"做一个 ikun 主题的开屏动画"},{t:"周报模板化，省半小时"},{t:"周末拍组练习室 vlog"}];
/* 打卡历史用 { 'YYYY.MM.DD': 1 } 存，done 只作为当日派生值兼容旧数据 */
if(!S.habits.length)S.habits=[{ic:"🏀",nm:"投篮 50 个"},{ic:"💪",nm:"力量训练"},{ic:"🏃",nm:"慢跑 3km"},{ic:"🧘",nm:"拉伸放松"}];
S.habits.forEach(function(h){
  if(!h.hist)h.hist={};
  if(h.done&&!h.hist[dayKey(TODAY())])h.hist[dayKey(TODAY())]=1;
  delete h.done;
});
if(!S.book)S.book={nm:"认知觉醒",cur:8,total:12};
/* 书架：从单本升级成多本；老的 S.book 自动变成第一本 */
if(!S.books||!S.books.length)S.books=[{id:1,nm:"认知觉醒",cur:8,total:12,cv:"#E8552D"},{id:2,nm:"被讨厌的勇气",cur:3,total:10,cv:"#7C5CBF"}];
if(!S.curBook)S.curBook=S.books[0].id;
if(!S.readDays)S.readDays={};
if(!S.ledger.length)S.ledger=[{d:"早餐",a:-18,ts:(TODAY().getTime()-3*86400000)},{d:"打车",a:-24,ts:(TODAY().getTime()-2*86400000)},{d:"咖啡",a:-28,ts:(TODAY().getTime()-1*86400000)},{d:"超市采购",a:-86,ts:(TODAY().getTime()-4*86400000)},{d:"午饭",a:-32,ts:(TODAY().getTime()-6*86400000)},{d:"工资入账",a:8000,ts:(TODAY().getTime()-12*86400000)},{d:"兼职稿费",a:600,ts:(TODAY().getTime()-30*86400000)}];
if(!S.moodLog)S.moodLog=[];
if(!S.moodPick)S.moodPick=4;
/* 一次性铺点演示数据（只在首次生成时写，之后用户改成什么样就留什么样） */
if(!S.seeded){
  S.seeded=1;
  [[0,1,2],[0,2],[1],[0,1]].forEach(function(offs,hi){
    if(!S.habits[hi])return;
    offs.forEach(function(o){S.habits[hi].hist[dayKey(shiftDay(TODAY(),-o))]=1;});
  });
  [1,2,3].forEach(function(o){S.readDays[dayKey(shiftDay(TODAY(),-o))]=1;});
  S.moodLog=[{ts:(TODAY().getTime()-86400000+21*3600000),m:4,t:"今天练完球心情很好，投进了三个三分。"},
             {ts:(TODAY().getTime()-3*86400000+23*3600000),m:2,t:"PPT 改到第三版还是不满意，有点烦。"}];
}
}

/* 【一次性清理历史演示数据 · 11-17】
   历史版本新装用户被 seedDemo 灌过 12 条假待办 / 3 条灵感 / 4 个假习惯 / 2 本假书 /
   7 笔假账（含 30 天前的「兼职稿费」，是「第 31 天练习」的来源）/ 2 条假心情。
   即使 seedDemo 已停用，这些已落盘的数据也不会自己消失。
   本函数只删「标题 / 金额 / 文本完全匹配种子特征」的条目 —— 用户改过的、或后来
   自己新建的同名条目一律不动（A 方案：精确匹配，宁可留一半也不误删）。
   执行完打 demoCleaned 标记，之后启动不再运行。
   练习天数 practiceDayNo() 是动态从最早数据算的，删掉假账本后自动回第 1 天。 */
function cleanLegacyDemo(){
  if(S.demoCleaned)return false;
  var TD=['完成季度 OKR 复盘','晨间日报手帐','准备季度汇报 PPT','读《认知觉醒》1 章',
    '健身 40 分钟','记账今日支出','回复合作邮件','灵感墙贴一张','整理项目文档',
    '学习 React 新特性','读完《认知觉醒》','提升团队协作效率'];
  var ID=['做一个 ikun 主题的开屏动画','周报模板化，省半小时','周末拍组练习室 vlog'];
  var HB=['投篮 50 个','力量训练','慢跑 3km','拉伸放松'];
  var BK=['认知觉醒','被讨厌的勇气'];
  var LG=['早餐|-18','打车|-24','咖啡|-28','超市采购|-86','午饭|-32','工资入账|8000','兼职稿费|600'];
  var MD=['今天练完球心情很好，投进了三个三分。','PPT 改到第三版还是不满意，有点烦。'];
  function strip(arr,keys,field){
    if(!Array.isArray(arr)||!keys.length)return;
    var out=arr.filter(function(x){return keys.indexOf(String(x&&x[field]!=null?x[field]:''))<0;});
    if(out.length!==arr.length){arr.length=0;Array.prototype.push.apply(arr,out);}
  }
  strip(S.todos,TD,'t');
  strip(S.ideas,ID,'t');
  strip(S.habits,HB,'nm');
  strip(S.books,BK,'nm');
  strip(S.moodLog,MD,'t');
  if(Array.isArray(S.ledger)){
    var keep=S.ledger.filter(function(x){return LG.indexOf(String(x&&x.d)+'|'+String(x&&x.a))<0;});
    if(keep.length!==S.ledger.length){S.ledger.length=0;Array.prototype.push.apply(S.ledger,keep);}
  }
  /* 旧的单本 book 字段也是演示值，一并清掉（UI 不读它，清了不影响显示） */
  if(S.book&&S.book.nm==='认知觉醒'&&S.book.cur===8&&S.book.total===12)delete S.book;
  /* 演示书删光后，curBook 会悬空，归零；baseNormalize 也会兜底修正 */
  if((!S.books||!S.books.length)&&S.curBook)S.curBook=0;
  S.demoCleaned=1;
  return true;   /* 标记本身也要落盘，所以无论是否真删了东西都要 save 一次 */
}

function esc(s){return (s||'').replace(/[&<>]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;'}[c];});}

/* 视图切换 + 入场动画重播。
   旧实现用 `void vb.offsetWidth` 强制同步布局来重启动画，每次切视图都会卡一帧；
   display:none → block 本来就会自动重播 CSS 动画，这里改用 Web Animations API 显式重播，
   全程不读布局属性，避免 forced synchronous layout。 */
function replayViewAnim(){
  var vb=document.querySelector('.view.on');if(!vb||typeof vb.getAnimations!=='function')return;
  vb.getAnimations().forEach(function(a){try{a.cancel();a.play();}catch(e){}});
}
function switchView(v){
  document.querySelectorAll('.view').forEach(function(x){x.classList.toggle('on',x.dataset.view===v);});
  document.querySelectorAll('[data-go]').forEach(function(b){b.classList.toggle('on',b.dataset.go===v);});
  replayViewAnim();
}
document.querySelectorAll('[data-go]').forEach(function(b){b.addEventListener('click',function(){switchView(b.dataset.go);});});

/* 待办 */
var TRASH_SVG='<svg class="trash-svg" viewBox="0 -10 64 74" aria-hidden="true">'+
  '<rect class="trash-bin" x="16" y="24" width="32" height="30" rx="3" ry="3"/>'+
  '<g class="lid-group">'+
    '<rect class="trash-lid" x="12" y="12" width="40" height="6" rx="2" ry="2"/>'+
    '<rect class="trash-lid" x="26" y="8" width="12" height="4" rx="2" ry="2"/>'+
  '</g></svg>';
var KLAB={imp:["重要","imp"],daily:["日常","daily"],heavy:["高重","heavy"]};
function tcard(it){
  var c=ce('div','tcard'+(it.done?' done':''));
  var k=KLAB[it.k]||KLAB.daily;
  c.innerHTML='<div class="flip-inner">'+
      '<div class="flip-face flip-front">'+
        '<div class="row1"><span class="tag3 '+k[1]+'">'+k[0]+'</span></div>'+
        '<div class="ttl">'+esc(it.t)+'</div>'+
        '<button class="del trash-btn" type="button" title="删除" aria-label="删除这条">'+TRASH_SVG+'</button>'+
      '</div>'+
      '<div class="flip-face flip-back">'+
        '<div class="bk-label">NOTE / 备注</div>'+
        '<div class="bk-note">'+esc(it.note||'这条还没写备注，回来补一笔。')+'</div>'+
        '<div class="bk-status"><span class="st-do">○ 进行中</span><span class="st-done">● 已完成</span></div>'+
      '</div>'+
    '</div>';
  var front=c.querySelector('.flip-front'),back=c.querySelector('.flip-back');
  var b=ce('button','hold-btn');b.type='button';b.dataset.glow='true';b.dataset.phase='idle';b.innerHTML=holdBtnHTML();
  front.appendChild(b);
  installHold(b,{holdTime:400,resetAfter:600,getDone:function(){return it.done;},onComplete:function(){toggleTodo(it,c);}});
  back.inert=true;
  function flip(on){c.classList.toggle('flipped',on);front.inert=on;back.inert=!on;}
  c.addEventListener('click',function(e){
    if(e.target.closest('.hold-btn')||e.target.closest('.del'))return;
    flip(!c.classList.contains('flipped'));
  });
  c.querySelector('.del').addEventListener('click',function(e){e.stopPropagation();confirmDelete('确定删除这条吗？',function(){
    if(it.hor!=='today')logGoal(it.t,it.hor,'removed');
    S.todos=S.todos.filter(function(x){return x!==it;});save();renderTodos();paintHolidayCard();});});
  return c;
}
function updateStats(){
  $('#footIdea').textContent=S.ideas.length;
  $('#ideaCnt').textContent=S.ideas.length+' 张';
  paintHolidayCard();updateStatCard();
}
/* 空轨道提示：没有卡片时给一句引导，避免看着像加载失败 */
function emptyTrack(txt){var d=ce('div','track-empty');d.textContent=txt;return d;}
/* ══ 任务 tab + 两行网格分页 ══
   一屏 6 张（2 行 × 3 列），超过 6 张按页切。轨道不滚，箭头改成翻页按钮。
   页码按列表维护，切阶段/切 tab/增删改后重置到第一页。 */
var PAGE_SIZE=6;
var pageState={today:0,hor:0};
function pageOf(list,key){
  var p=pageState[key]||0;
  var pages=Math.max(1,Math.ceil(list.length/PAGE_SIZE));
  if(p>=pages)p=pages-1;if(p<0)p=0;pageState[key]=p;
  return {items:list.slice(p*PAGE_SIZE,(p+1)*PAGE_SIZE),page:p,pages:pages};
}
function paintPage(tr,carousel,pg){
  tr.innerHTML='';
  if(!pg.items.length)tr.appendChild(emptyTrack(tr.id==='todayTrack'?'今天还未开团 · 点「＋ 来一段」记一条':'目标还未开团 · 点「＋ 加一个」'));
  else pg.items.forEach(function(it){tr.appendChild(tcard(it));});
  if(carousel){
    var prev=carousel.querySelector('.prev'),next=carousel.querySelector('.next');
    if(prev)prev.disabled=pg.page<=0;
    if(next)next.disabled=pg.page>=pg.pages-1;
  }
}
function renderTodos(){
  var tr=$('#todayTrack');
  if(tr){
    var list=S.todos.filter(function(x){return x.hor==='today';});
    paintPage(tr,tr.closest('.carousel'),pageOf(list,'today'));
  }
  renderHorTodos();
  updateStats();
}
var curHor='short';
function renderHorTodos(){
  var tr=$('#horTrack');if(!tr)return;
  var list=S.todos.filter(function(x){return x.hor===curHor;});
  paintPage(tr,tr.closest('.carousel'),pageOf(list,'hor'));
}
/* 切当前 tab：today | hor。偏好不落盘（下次打开默认今日） */
/* 历史页签内子视图：plan（今日任务历史）| goals（阶段性任务历史） */
var inlineHistTab='plan',inlineHistDay='';
function renderInlineHist(){
  var pane=$('#inlineHistPane');if(!pane)return;
  pane.innerHTML=historyPaneHTML(inlineHistTab,inlineHistDay);
  var btns=document.querySelectorAll('.hist-pane .ph-tab');
  btns.forEach(function(b){b.classList.toggle('on',b.dataset.tab===inlineHistTab);});
}
function setTaskTab(tab,focusDay){
  if(tab!=='today'&&tab!=='hor'&&tab!=='hist')tab='today';
  /* 页签改成 radio + label 后，程序化切换必须把 radio 的 checked 一起改：
     glider 的位置只认 :checked，不认 .on 类，漏了就会「面板换了、滑块没动」。 */
  document.querySelectorAll('.todo-tabs input[type=radio]').forEach(function(r){r.checked=(r.dataset.tab===tab);});
  document.querySelectorAll('.todo-tab').forEach(function(b){
    var on=b.dataset.tab===tab;
    b.classList.toggle('on',on);b.setAttribute('aria-selected',on?'true':'false');
  });
  document.querySelectorAll('.todo-panel').forEach(function(p){p.classList.toggle('on',p.dataset.panel===tab);});
  /* 加号跟着页签走：历史页没有新增入口，藏起来但不摘掉占位；
     短/中/长只在阶段性任务页有用，同样用 visibility 隐藏，保住两个按钮的位置不左右晃 */
  var add=document.querySelector('#taskAdd');
  if(add)add.style.visibility=(tab==='hist')?'hidden':'visible';
  var seg=document.querySelector('.seg-slot');
  if(seg)seg.classList.toggle('on',tab==='hor');
  if(tab==='hist'){inlineHistDay=focusDay||'';renderInlineHist();}
}
/* glider 是 CSS 里 1/3 等分宽的滑块，位置由 :checked 决定，不再需要 JS 量按钮宽度。
   保留空函数是为了不惊动各处历史调用点。 */
function placeTabSlider(){}
/* label 点击 → 对应 radio 的 change；键盘方向键切换也走 change。 */
document.querySelectorAll('.todo-tabs input[type=radio]').forEach(function(r){
  r.addEventListener('change',function(){if(r.checked)setTaskTab(r.dataset.tab);});
});
function toggleTodo(it,card){
  it.done=!it.done;
  if(it.hor!=='today')logGoal(it.t,it.hor,it.done?'done':'undone');
  save();
  if(card)card.classList.toggle('done',it.done);
  updateStats();
  if(it.done&&card)showDoneBurst(card);
}
/* 长按完成：小手 + 星从卡片头上弹出，卡片抬一下、抖两抖再落回（不再弹底部 toast） */
var HAND_SVG='<svg viewBox="0 0 24 24" aria-hidden="true">'+
  '<path d="M7 10.2v8.3h10.1a2 2 0 0 0 1.96-1.6l1.2-6.1a1.55 1.55 0 0 0-1.52-1.84H13.4V5.2A2.1 2.1 0 0 0 11.3 3.1c-.5 0-.96.29-1.17.75L7 10.2Z" fill="var(--court)" stroke="var(--ink)" stroke-width="2" stroke-linejoin="round"/>'+
  '<path d="M4 10.2h3v8.3H4a1.05 1.05 0 0 1-1.05-1.05v-6.2A1.05 1.05 0 0 1 4 10.2Z" fill="var(--paper)" stroke="var(--ink)" stroke-width="2" stroke-linejoin="round"/>'+
  '</svg>';
var STAR_SVG='<svg viewBox="0 0 24 24" aria-hidden="true">'+
  '<path d="M12 2.6l2.9 6 6.5.9-4.7 4.6 1.1 6.5L12 17.5l-5.8 3.1 1.1-6.5-4.7-4.6 6.5-.9L12 2.6Z" fill="var(--lilac)" stroke="var(--ink)" stroke-width="2" stroke-linejoin="round"/>'+
  '</svg>';
function showDoneBurst(card){
  var old=card.querySelector('.done-burst');if(old)old.remove();
  var b=ce('div','done-burst');b.setAttribute('aria-hidden','true');
  b.innerHTML='<span class="db-hand">'+HAND_SVG+'</span><span class="db-star">'+STAR_SVG+'</span>';
  card.appendChild(b);
  setTimeout(function(){if(b.parentNode)b.remove();},1200);
  if(document.body.classList.contains('no-motion'))return;
  if(window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches)return;
  if(!card.animate)return;
  /* 蓄力压扁 → 跳起（逆时针倾斜，右上角比左上角高）→ 落地压扁缓冲 → 小回弹 → 再落定
     落地不再一帧归位，用 squash & stretch 两段缓冲，看起来有重量 */
  card.style.zIndex=6;
  var anim=card.animate([
    {transform:'translateY(0) rotate(0deg) scale(1,1)',offset:0,easing:'cubic-bezier(.3,.9,.4,1)'},
    {transform:'translateY(3px) rotate(0deg) scale(1.025,.975)',offset:.09,easing:'cubic-bezier(.2,.85,.3,1)'},
    {transform:'translateY(-27px) rotate(-2.8deg) scale(.985,1.02)',offset:.42,easing:'cubic-bezier(.45,0,.75,.45)'},
    {transform:'translateY(0) rotate(0deg) scale(1.06,.93)',offset:.66,easing:'cubic-bezier(.2,.85,.35,1)'},
    {transform:'translateY(-7px) rotate(-.9deg) scale(.99,1.015)',offset:.79,easing:'cubic-bezier(.4,0,.75,.5)'},
    {transform:'translateY(0) rotate(0deg) scale(1.02,.98)',offset:.89,easing:'cubic-bezier(.3,.9,.4,1)'},
    {transform:'translateY(-1.5px) rotate(-.2deg) scale(1,1)',offset:.95},
    {transform:'translateY(0) rotate(0deg) scale(1,1)',offset:1}
  ],{duration:820,fill:'none'});
  anim.onfinish=function(){card.style.zIndex='';};
  anim.oncancel=function(){card.style.zIndex='';};
}

/* 按住确认完成：把 HoldButton(React) 移植为原生实现 */
function holdBtnHTML(){
  var inner='<span class="hold-btn__idle">按住完成</span><span class="hold-btn__done">已完成 ✓</span>';
  return '<span class="hold-btn__pulse"></span>'+
    '<span class="hold-btn__label">'+inner+'</span>'+
    '<span class="hold-btn__clip">'+
      '<span class="hold-btn__fill"><span class="hold-btn__label hold-btn__label--fill">'+inner+'</span></span>'+
      '<span class="hold-btn__crest"><span class="hold-btn__label hold-btn__label--fill">'+inner+'</span></span>'+
    '</span>';
}
function installHold(btn,opts){
  var holdTime=opts.holdTime||800,releaseTime=opts.releaseTime||200,resetAfter=opts.resetAfter!=null?opts.resetAfter:0;
  var phase='idle',input=null,g={pointerId:null,start:0,rect:null};
  var mt={raf:0,p:0,from:0,to:0,start:0},timers={complete:0,reset:0};
  function setPhase(p,k){phase=p;input=k;btn.dataset.phase=p;if(k)btn.dataset.input=k;else delete btn.dataset.input;}
  function drive(to,dur,ease){cancelAnimationFrame(mt.raf);mt.from=mt.p;mt.to=to;mt.start=performance.now();
    function step(now){var t=dur>0?Math.min(1,(now-mt.start)/dur):1;mt.p=mt.from+(mt.to-mt.from)*ease(t);
      btn.style.setProperty('--hb-p',mt.p.toFixed(4));if(t<1){mt.raf=requestAnimationFrame(step);return;}mt.raf=0;if(mt.to===1)complete();}
    mt.raf=requestAnimationFrame(step);}
  function updateLabels(){
    var done=opts.getDone?opts.getDone():false;
    var idle=btn.querySelector('.hold-btn__idle');
    if(idle)idle.textContent=done?'已完成 ✓':'按住完成';
    btn.style.setProperty('--hb-bg',done?'var(--mint)':'var(--ink)');
    btn.style.setProperty('--hb-text',done?'#fff':'var(--cream)');
  }
  function complete(){
    if(phase!=='holding')return;
    if(performance.now()-g.start<holdTime-50)return;
    clearTimeout(timers.complete);
    if(opts.onComplete)opts.onComplete();
    if(opts.getDone&&opts.getDone()){
      setPhase('done',input);
      timers.reset=setTimeout(function(){
        if(opts.getDone&&opts.getDone()){setPhase('idle',null);drive(0,releaseTime,function(t){return 1-Math.pow(1-t,3);});}
        updateLabels();
      },resetAfter||0);
    } else {
      setPhase('idle',null);drive(0,releaseTime,function(t){return 1-Math.pow(1-t,3);});
    }
    updateLabels();
  }
  function begin(k){if(btn.disabled||phase!=='idle')return false;g.start=performance.now();g.rect=btn.getBoundingClientRect();
    setPhase('holding',k);drive(1,holdTime,function(t){return t;});timers.complete=setTimeout(complete,holdTime+100);return true;}
  function release(o){o=o||{};if(phase!=='holding')return;clearTimeout(timers.complete);
    var held=performance.now()-g.start;setPhase('idle',null);drive(0,releaseTime,function(t){return 1-Math.pow(1-t,3);});
    if(!o.drifted&&held<250&&opts.onTap)opts.onTap();}
  btn.addEventListener('pointerdown',function(e){if(e.button!==0||!e.isPrimary||g.pointerId!==null)return;if(!begin('pointer'))return;g.pointerId=e.pointerId;try{e.currentTarget.setPointerCapture(e.pointerId);}catch(_){}});
  btn.addEventListener('pointermove',function(e){if(e.pointerId!==g.pointerId)return;var r=g.rect;if(!r)return;
    var out=e.clientX<r.left-10||e.clientX>r.right+10||e.clientY<r.top-10||e.clientY>r.bottom+10;if(out)release({drifted:true});});
  function endP(e){if(e.pointerId!==g.pointerId)return;g.pointerId=null;try{if(e.currentTarget.hasPointerCapture(e.pointerId))e.currentTarget.releasePointerCapture(e.pointerId);}catch(_){}release();}
  btn.addEventListener('pointerup',endP);
  btn.addEventListener('pointercancel',function(e){if(e.pointerId===g.pointerId){g.pointerId=null;release({drifted:true});}});
  btn.addEventListener('lostpointercapture',function(e){if(e.pointerId===g.pointerId){g.pointerId=null;release({drifted:true});}});
  btn.addEventListener('pointerleave',function(e){if(e.pointerType!=='touch'&&g.pointerId!==null){g.pointerId=null;release({drifted:true});}});
  btn.addEventListener('contextmenu',function(e){e.preventDefault();});
  btn.addEventListener('keydown',function(e){if(e.key===' '||e.key==='Enter'){e.preventDefault();if(!e.repeat)begin('key');}});
  btn.addEventListener('keyup',function(e){if(e.key===' '||e.key==='Enter'){e.preventDefault();if(input==='key')release();}});
  function measure(){btn.style.setProperty('--hb-w',btn.offsetWidth+'px');btn.style.setProperty('--hb-h',btn.offsetHeight+'px');}
  measure();if(window.ResizeObserver){var ro=new ResizeObserver(measure);ro.observe(btn);}
  updateLabels();
}

/* 右栏「下个假期」：全部从 holidays.js 的离线数据算，不联网。
   ① 把放假日按「连续块」合并成一次次假期；② 今天正在假期里 → 显示还剩几天；
   ③ 不在假期里 → 显示距下一个假期几天、这中间还要上几天班；
   ④ 进度条＝从上一个假期结束走到今天，越满越近。 */
function paintHolidayCard(now){
  var daysEl=$('#holDays');if(!daysEl)return;
  var map=(window.CN_HOLI&&window.CN_HOLI.map)||null;
  var DAY=86400000;
  function setCard(n,unit,name,note,pct){
    daysEl.textContent=n;
    var u=$('#holUnit');if(u)u.textContent=unit;
    var nm=$('#holName');if(nm)nm.textContent=name;
    var nt=$('#holNote');if(nt)nt.textContent=note;
    var fg=$('#holFg');if(fg)fg.style.width=Math.max(0,Math.min(100,pct||0))+'%';
  }
  function parse(k){var p=k.split('.');return new Date(+p[0],+p[1]-1,+p[2]);}
  function keyOf(d){return d.getFullYear()+'.'+('0'+(d.getMonth()+1)).slice(-2)+'.'+('0'+d.getDate()).slice(-2);}
  if(!map){setCard('—','天后','未收录','假期数据没覆盖到这一年',0);return;}

  var ks=Object.keys(map).filter(function(k){return map[k].k==='rest';}).sort();
  var blocks=[],i,d,last;
  for(i=0;i<ks.length;i++){
    d=parse(ks[i]);
    last=blocks[blocks.length-1];
    if(last&&(d-last.to)===DAY){last.to=d;}
    else blocks.push({from:d,to:d,name:map[ks[i]].n||''});
  }

  /* 传进来的日期先归零（只比日期不比时刻），不传就用今天 */
  var t=now||TODAY(),inb=null,next=null,prev=null;
  t=new Date(t.getFullYear(),t.getMonth(),t.getDate());
  blocks.forEach(function(b){
    if(t>=b.from&&t<=b.to)inb=b;
    else{
      if(b.from>t&&(!next||b.from<next.from))next=b;
      if(b.to<t&&(!prev||b.to>prev.to))prev=b;
    }
  });

  /* 正在假期里：大字改成「还剩几天」，进度条直接拉满 */
  if(inb){
    var left=Math.round((inb.to-t)/DAY)+1;
    var len0=Math.round((inb.to-inb.from)/DAY)+1;
    setCard(left,'天',inb.name+' · '+len0+' 天',
      left>1?('假期还剩 '+left+' 天'):'今天最后一天，收心',100);
    return;
  }
  if(!next){setCard('—','天后','未收录','假期数据没覆盖到这一年',0);return;}

  var dd=Math.round((next.from-t)/DAY);
  var len=Math.round((next.to-next.from)/DAY)+1;
  /* 中间还要上几天班：周一到周五算班，碰上调休补班日加回来、碰上放假日本来就不算 */
  var work=0,c=shiftDay(t,1);
  while(c<next.from){
    var mk=map[keyOf(c)],wd=c.getDay();
    if(mk){if(mk.k==='work')work++;}
    else if(wd>=1&&wd<=5)work++;
    c=shiftDay(c,1);
  }
  var pct=0;
  if(prev){
    var total=(next.from-prev.to)/DAY;
    if(total>0)pct=(t-prev.to)/DAY/total*100;
  }
  var note=dd===1?'明天就放假啦':(work>0?('中间还要上 '+work+' 天班'):'假期就在眼前');
  setCard(dd,'天后',next.name+' · '+len+' 天',note,pct);
}
/* 环形进度：dashoffset 和中心数字用同一段 rAF 插值，两者才对得上；
   纯 CSS transition 只能动环，数字会硬跳。 */
var ringPrev={p:0,done:0,total:0},ringRAF=0;
function setRingNow(p,done,total){
  var fg=$('#fitRingFg');if(fg)fg.style.strokeDashoffset=String(100-p);
  var d=$('#fitRingDone'),t=$('#fitRingTot');
  if(d)d.textContent=done;if(t)t.textContent=total;
  var box=$('#fitRingBox');if(box)box.classList.toggle('is-empty',total===0);
}
function animateRing(p,done,total){
  var fg=$('#fitRingFg');if(!fg)return;
  var dEl=$('#fitRingDone'),tEl=$('#fitRingTot'),box=$('#fitRingBox');
  var fromP=ringPrev.p,fromD=ringPrev.done;
  ringPrev={p:p,done:done,total:total};
  if(tEl)tEl.textContent=total;
  // 动效关掉、或数值没变（比如只是保存了一次）就别重播
  if(document.body.classList.contains('no-motion')||(fromP===p&&fromD===done)){
    setRingNow(p,done,total);return;
  }
  cancelAnimationFrame(ringRAF);
  var t0=null,dur=720;
  function step(ts){
    if(t0===null)t0=ts;
    var k=Math.min(1,(ts-t0)/dur);
    var e=1-Math.pow(1-k,3);                 // easeOutCubic：先快后缓，像球进网
    fg.style.strokeDashoffset=String(100-(fromP+(p-fromP)*e));
    if(dEl)dEl.textContent=Math.round(fromD+(done-fromD)*e);
    if(k<1){ringRAF=requestAnimationFrame(step);}
    else{
      if(box){
        box.classList.toggle('is-empty',total===0);
        if(p>=100&&fromP<100){                 // 刚好打满：整环弹一下
          box.classList.add('is-full');
          setTimeout(function(){box.classList.remove('is-full');},700);
        }
      }
    }
  }
  ringRAF=requestAnimationFrame(step);
}

/* 今日概览卡 · 全部指标直接从 S 计算，任何 save() 后自动刷新 */
function updateStatCard(){
  if(typeof $!=='function')return;
  var ring=$('#fitRingFg');if(!ring)return;
  var all=S.todos||[],ad=all.filter(function(x){return x.done;}).length;
  var td=all.filter(function(x){return x.hor==='today';});
  var dn=td.filter(function(x){return x.done;}).length;
  var p=td.length?Math.round(dn/td.length*100):0;
  animateRing(p,dn,td.length);
  var rb=$('#fitRingBox');if(rb)rb.setAttribute('aria-label','今日完成 '+dn+' / '+td.length+' 条，命中率 '+p+'%');
  var histDone=0;
  Object.keys(S.planDays||{}).forEach(function(k){histDone+=(S.planDays[k].done||0);});
  /* 目标完成按「完成事件」计，不能按每天快照累加（目标完成后会天天出现在快照里） */
  var goalDoneN=(S.goalLog||[]).filter(function(g){return g.action==='done';}).length;

  /* 日报累计 + 阶段性任务（11-17 定：连续天数换成阶段性任务统计，
     和旁边「今日待办」一样给 完成/总数，一眼看出阶段目标推进到哪了） */
  var jrns=S.journals||[];
  var gsAll=all.filter(function(x){return x.hor!=='today';});
  var gsDone=gsAll.filter(function(x){return x.done;}).length;

  var vals=[
    ['fitJournal',jrns.length+' 篇','日报累计'],
    ['fitStage',gsDone+'/'+gsAll.length,'阶段性任务完成'],
    ['fitTodayTask',dn+'/'+td.length,'今日待办'],
    ['fitDone',(histDone+dn+goalDoneN)+' 条','历史累计完成']
  ];
  vals.forEach(function(v){
    var el=$('#'+v[0]);if(!el)return;
    el.textContent=v[1];
    var tile=el.closest('.fit-tile');if(tile)tile.setAttribute('aria-label',v[2]+' '+v[1]);
  });
}

/* 灵感 */
function renderIdeas(){
  var n=$('#notes');n.innerHTML='';
  S.ideas.forEach(function(it,idx){
    var d=ce('div','note');d.innerHTML='<span class="pin"></span><div class="tx">'+esc(it.t)+'</div><button class="x trash-btn" type="button" aria-label="删除便签">'+TRASH_SVG+'</button>';
    d.querySelector('.x').addEventListener('click',function(){confirmDelete('确定撕掉这张灵感吗？',function(){S.ideas.splice(idx,1);save();renderIdeas();renderTodos();});});
    n.appendChild(d);
  });
}

/* 锻炼：今日打卡 + 本周 7 格 + 连续天数 + 本周统计 + 近 7 天明细 */
function weekDays(){
  /* 本周（周一起）7 天 */
  var t=TODAY(),dow=(t.getDay()+6)%7;          /* 周一=0 */
  var mon=shiftDay(t,-dow),arr=[];
  for(var i=0;i<7;i++)arr.push(shiftDay(mon,i));
  return arr;
}
function habitStreak(h){
  var n=0,d=TODAY();
  /* 今天没打卡就从昨天开始数，不让当天未打把连续天数清成 0 */
  if(!h.hist[dayKey(d)])d=shiftDay(d,-1);
  while(h.hist[dayKey(d)]){n++;d=shiftDay(d,-1);}
  return n;
}
function toggleHabitDay(h,d){
  var k=dayKey(d);
  if(h.hist[k])delete h.hist[k];else h.hist[k]=1;
  save();renderHabits();
}
function renderHabits(){
  var l=$('#habitList');l.innerHTML='';
  var td=TODAY(),tdk=dayKey(td),wk=weekDays();
  if(!S.habits.length)l.innerHTML='<div class="hempty">还没有锻炼目标，点右上角「＋ 新建目标」加一个</div>';
  S.habits.forEach(function(h){
    h.hist=h.hist||{};
    var st=habitStreak(h),done=!!h.hist[tdk];
    var r=ce('div','hrow');
    var strip=wk.map(function(d,i){
      var on=!!h.hist[dayKey(d)],cls=''+(on?' on':'')+(dayKey(d)===tdk?' td':'');
      return '<i class="'+cls+'" data-day="'+dayKey(d)+'" title="'+dayKey(d)+'">'+['一','二','三','四','五','六','日'][i]+'</i>';
    }).join('');
    r.innerHTML='<div class="ico">'+h.ic+'</div>'+
      '<div class="nm">'+esc(h.nm)+'<b>连续 '+st+' 天</b></div>'+
      '<div class="wstrip" title="本周打卡，点一下可补打">'+strip+'</div>'+
      '<button class="hdel" type="button" title="删除「'+esc(h.nm)+'」">✕</button>'+
      '<div class="box'+(done?' on':'')+'">'+(done?'✓':'')+'</div>';
    r.querySelector('.box').addEventListener('click',function(){
      toggleHabitDay(h,td);toast(done?'已取消今天的打卡':'打卡成功 🏀');
    });
    r.querySelector('.hdel').addEventListener('click',function(e){
      e.stopPropagation();
      var idx=S.habits.indexOf(h),nm=h.nm;
      confirmDelete('删除「'+nm+'」？它的打卡记录也会一起删掉',function(){
        if(idx>-1)S.habits.splice(idx,1);
        save();renderHabits();toast('已删除「'+nm+'」');
      });
    });
    r.querySelectorAll('.wstrip i').forEach(function(el){
      el.addEventListener('click',function(){
        var p=el.dataset.day.split('.').map(Number);
        toggleHabitDay(h,new Date(p[0],p[1]-1,p[2]));
      });
    });
    l.appendChild(r);
  });
  /* 统计 */
  var total=S.habits.length*7,got=0,best=0,todayN=0;
  S.habits.forEach(function(h){
    h.hist=h.hist||{};
    var s=habitStreak(h);if(s>best)best=s;
    if(h.hist[tdk])todayN++;
    wk.forEach(function(d){if(h.hist[dayKey(d)])got++;});
  });
  var rate=total?Math.round(got/total*100):0;
  $('#habCnt').textContent=todayN+' / '+S.habits.length;
  $('#footHab').textContent=todayN+'/'+S.habits.length;
  $('#habStreak').textContent=best;
  $('#habWeek').textContent=got+' / '+total;
  $('#habToday').textContent=todayN;
  $('#habBest').textContent=best+' 天';
  $('#habRate').textContent=rate+'%';
  $('#habTip').textContent=rate>=80?'这周够狠，保持住':'';
  /* 近 14 天柱状：当天完成了几项 */
  var bars='';
  for(var i=13;i>=0;i--){
    var d=shiftDay(td,-i),n=0;
    S.habits.forEach(function(h){if(h.hist[dayKey(d)])n++;});
    var pct=S.habits.length?Math.round(n/S.habits.length*100):0;
    bars+='<i'+(i===0?' class="td"':'')+' title="'+dayKey(d)+' · '+n+' 项"><b style="height:'+pct+'%"></b></i>';
  }
  $('#habBars').innerHTML=bars;
  /* 近 7 天明细 */
  var hist='';
  for(var j=0;j<7;j++){
    var dd=shiftDay(td,-j),done=[];
    S.habits.forEach(function(h){if(h.hist[dayKey(dd)])done.push(h.ic);});
    var wd=['日','一','二','三','四','五','六'][dd.getDay()];
    hist+='<div class="hist-row'+(done.length?'':' empty')+'"><span class="dt">'+(j===0?'今天':(dd.getMonth()+1)+'.'+dd.getDate()+' 周'+wd)+
      '</span><span class="em">'+(done.length?done.join(' '):'没练')+'</span><span class="n">'+done.length+'/'+S.habits.length+'</span></div>';
  }
  $('#habHist').innerHTML=hist;
}

/* 阅读：书架多本 + 每日打卡 */
function renderBook(){
  var sh=$('#shelf');if(!sh)return;
  sh.innerHTML='';
  S.books.forEach(function(b){
    var pct=Math.round(b.cur/b.total*100);
    var it=ce('div','shelf-item'+(b.id===S.curBook?' on':''));
    it.innerHTML='<div class="cv" style="background:'+(b.cv||'#E8552D')+'">'+esc(b.nm.slice(0,2))+'</div>'+
      '<div class="mid"><h4>'+esc(b.nm)+'</h4>'+
      '<div class="pg2">第 '+b.cur+' / '+b.total+' 章 · '+pct+'%</div>'+
      '<div class="bar2"><i style="width:'+pct+'%"></i></div></div>'+
      '<div class="acts"><button class="jbtn" data-up>＋1 章</button><button class="jbtn ghost" data-fin>读完</button></div>';
    it.addEventListener('click',function(e){
      if(e.target.closest('button'))return;
      S.curBook=b.id;save();renderBook();
    });
    it.querySelector('[data-up]').addEventListener('click',function(){
      if(b.cur<b.total){b.cur++;save();renderBook();toast('进度 +1 📖');}else toast('这本已经读完啦');
    });
    it.querySelector('[data-fin]').addEventListener('click',function(){
      b.cur=b.total;save();renderBook();toast('读完啦 🎉 铁山靠');
    });
    sh.appendChild(it);
  });
  var cur=S.books.filter(function(b){return b.id===S.curBook;})[0]||S.books[0];
  $('#shelfCnt').textContent=S.books.length+' 本';
  var rf=$('#readFoot');if(rf&&cur)rf.textContent=cur.cur+'/'+cur.total;
  $('#readTotal').textContent=S.books.reduce(function(a,b){return a+b.cur;},0);

  /* 本周打卡格 */
  var td=dayKey(TODAY()),wk=weekDays(),g='',cnt=0;
  var labs=['一','二','三','四','五','六','日'];
  wk.forEach(function(d,i){
    var k=dayKey(d),on=!!S.readDays[k];if(on)cnt++;
    g+='<button type="button" class="'+(on?'on':'')+(k===td?' td':'')+'" data-day="'+k+'">'+
       '<span>周'+labs[i]+'</span><span class="dot"></span><span style="font-family:var(--mono);font-size:10px">'+d.getDate()+'</span></button>';
  });
  $('#readGrid').innerHTML=g;
  $('#readGrid').querySelectorAll('button').forEach(function(btn){
    btn.addEventListener('click',function(){
      var k=btn.dataset.day;
      if(S.readDays[k])delete S.readDays[k];else S.readDays[k]=1;
      save();renderBook();toast(S.readDays[k]?'打卡成功 📚':'已取消打卡');
    });
  });
  $('#readWeek').textContent=cnt+' / 7';
  $('#readStreak').textContent=readStreak();

  /* 近 7 天明细 */
  var hist='';
  for(var j=0;j<7;j++){
    var dd=shiftDay(TODAY(),-j),on=S.readDays[dayKey(dd)];
    var wd=['日','一','二','三','四','五','六'][dd.getDay()];
    hist+='<div class="hist-row'+(on?'':' empty')+'"><span class="dt">'+(j===0?'今天':(dd.getMonth()+1)+'.'+dd.getDate()+' 周'+wd)+
      '</span><span class="em">'+(on?'读了《'+esc(cur?cur.nm:'')+'》':'没读')+'</span><span class="n">'+(on?'✓':'—')+'</span></div>';
  }
  $('#readHist').innerHTML=hist;
}
function readStreak(){
  var n=0,d=TODAY();
  if(!S.readDays[dayKey(d)])d=shiftDay(d,-1);
  while(S.readDays[dayKey(d)]){n++;d=shiftDay(d,-1);}
  return n;
}
var newBookBtn=$('#newBook');
if(newBookBtn)newBookBtn.addEventListener('click',function(){
  var nm=prompt('新书的名字？');
  if(!nm||!nm.trim())return;
  var t=parseInt(prompt('一共几章？','12'),10)||12;
  S.books.push({id:Date.now(),nm:nm.trim(),cur:0,total:t,cv:['#E8552D','#7C5CBF','#46B59A','#D9A441'][S.books.length%4]});
  save();renderBook();toast('上架一本 📚');
});

/* 记账 */
var ledF='all';
function renderLedger(){
  var l=$('#ledgerList');l.innerHTML='';var sum=0,shown=0;
  var groups={};
  S.ledger.forEach(function(e,idx){
    if(ledF==='in'&&e.a<0)return;
    if(ledF==='out'&&e.a>0)return;
    sum+=e.a;shown++;
    var dt=e.ts?new Date(e.ts):new Date();
    var mk=dt.getFullYear()+'.'+String(dt.getMonth()+1).padStart(2,'0');
    (groups[mk]=groups[mk]||[]).push({e:e,idx:idx});
  });
  Object.keys(groups).sort().reverse().forEach(function(mk){
    var gh=ce('div','ledger-group');gh.innerHTML='<div class="lg-head">'+mk+' 月</div>';
    groups[mk].forEach(function(o){
      var e=o.e,idx=o.idx;
      var r=ce('div','ledger-row');
      r.innerHTML='<div class="d">'+esc(e.d)+'</div><div class="a '+(e.a<0?'out':'in')+'">'+(e.a<0?'-':'+')+'¥'+Math.abs(e.a)+'</div><button class="x trash-btn" type="button" aria-label="删除这笔">'+TRASH_SVG+'</button>';
      r.querySelector('.x').addEventListener('click',function(){confirmDelete('确定删除这笔账目吗？',function(){S.ledger.splice(idx,1);save();renderLedger();});});
      gh.appendChild(r);
    });
    l.appendChild(gh);
  });
  if(!shown)l.innerHTML='<div class="s-empty">这个筛选下还没有记录 💸</div>';
  $('#ledTotal').textContent='¥'+sum.toLocaleString();
  renderLedgerStats();
}

/* 记账统计 + 历史（补在流水卡下方） */
function ledMonthKey(ts){var d=new Date(ts);return d.getFullYear()+'.'+String(d.getMonth()+1).padStart(2,'0');}
function renderLedgerStats(){
  var byM={};
  S.ledger.forEach(function(e){
    var k=ledMonthKey(e.ts);
    var g=byM[k]=byM[k]||{in:0,out:0,n:0};
    if(e.a<0)g.out+=-e.a;else g.in+=e.a;
    g.n++;
  });
  var t=TODAY(),cur=ledMonthKey(t.getTime()),g=byM[cur]||{in:0,out:0,n:0};
  var net=g.in-g.out,days=t.getDate();
  var fmt=function(n){return '¥'+Math.round(n).toLocaleString();};
  $('#statMonth').textContent=cur;
  $('#statIn').textContent=fmt(g.in);
  $('#statOut').textContent=fmt(g.out);
  $('#statNet').textContent=(net<0?'-':'')+fmt(Math.abs(net));
  $('#ledMonth').textContent=(net<0?'-':'')+fmt(Math.abs(net));   /* 头部“本月净结余”，跟统计卡同源 */
  $('#footLed').textContent=fmt(g.out);
  var avg=days?g.out/days:0;
  $('#ledTip').textContent='日均支出 '+fmt(avg)+' · 共 '+g.n+' 笔';
  /* 近 6 个月支出柱 */
  var max=1,keys=[];
  for(var i=5;i>=0;i--){
    var d=new Date(t.getFullYear(),t.getMonth()-i,1),k=ledMonthKey(d.getTime());
    keys.push(k);max=Math.max(max,(byM[k]||{out:0}).out);
  }
  $('#ledBars').innerHTML=keys.map(function(k,i){
    var out=(byM[k]||{out:0}).out,pct=Math.round(out/max*100);
    return '<i'+(i===5?' class="td"':'')+' title="'+k+' 支出 '+fmt(out)+'"><b style="height:'+pct+'%"></b></i>';
  }).join('');
  /* 历史：按月倒序 */
  var hist=Object.keys(byM).sort().reverse().slice(0,8).map(function(k){
    var x=byM[k],n=x.in-x.out;
    return '<div class="hist-row"><span class="dt">'+k+'</span>'+
      '<span class="em">收 '+fmt(x.in)+' · 支 '+fmt(x.out)+'</span>'+
      '<span class="n" style="color:'+(n<0?'var(--court-d)':'#2c8576')+'">'+(n<0?'-':'+')+fmt(Math.abs(n))+'</span></div>';
  }).join('');
  $('#ledHist').innerHTML=hist||'<div class="s-empty">还没有历史 🗂</div>';
}
var ledFilter=$('#ledFilter');
if(ledFilter)ledFilter.querySelectorAll('button').forEach(function(b){b.addEventListener('click',function(){ledF=b.dataset.f;ledFilter.querySelectorAll('button').forEach(function(x){x.classList.toggle('on',x===b);});renderLedger();});});

/* 心情 */
var FACE=['😞','😕','😐','🙂','😄'];
function renderMood(){
  var n=(S.moodLog||[]).length;
  if($('#footMood'))$('#footMood').textContent=n?n+' 篇':'还没写';
  renderMoodPick();renderMoodLog();
}

/* 今天的心情：选脸 + 写一段 + 存进心情日记 */
function renderMoodPick(){
  var p=$('#moodPick');if(!p)return;
  p.innerHTML='';
  FACE.forEach(function(f,i){
    var b=ce('button',S.moodPick===i+1?'on':'');
    b.type='button';b.textContent=f;b.title='心情 '+f;
    b.addEventListener('click',function(){S.moodPick=i+1;save();renderMoodPick();});
    p.appendChild(b);
  });
  if($('#moodSaved'))$('#moodSaved').textContent='已记 '+S.moodLog.length+' 篇 · 心情存本机不上传';
}

function showMoodDetail(it){
  var d=new Date(it.ts),wd=['日','一','二','三','四','五','六'][d.getDay()];
  var dateStr=d.getFullYear()+'.'+(d.getMonth()+1)+'.'+d.getDate()+' 周'+wd;
  var html='<div class="jview-date">'+esc(dateStr)+' <span>'+FACE[(it.m||3)-1]+'</span></div>'+
    '<div class="jview-text">'+esc(it.t)+'</div>'+
    '<div class="jview-acts">'+
      '<button class="jview-btn danger" type="button" data-md-del>删除</button>'+
      '<button class="jview-btn neutral" type="button" data-md-close>关闭</button>'+
    '</div>';
  openModal('心情日记详情',{view:true,viewHtml:html});
  var cls=modalView.querySelector('[data-md-close]');
  if(cls)cls.addEventListener('click',closeModal);
  var del=modalView.querySelector('[data-md-del]');
  if(del)del.addEventListener('click',function(){
    confirmDelete('删掉这篇心情日记？',function(){
      var i=S.moodLog.indexOf(it);if(i>-1)S.moodLog.splice(i,1);
      save();closeModal();renderMoodLog();
      if($('#footMood'))$('#footMood').textContent=S.moodLog.length+' 篇';
      toast('已删除这篇心情日记 🗑️');
    });
  });
}
/* 右侧「查看详情」箭头，日报与心情两个列表共用 */
var ARROW_SVG='<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M5 13h11.17l-4.88 4.88c-.39.39-.39 1.03 0 1.42s1.02.39 1.41 0l6.59-6.59a.996.996 0 0 0 0-1.41l-6.58-6.6a.996.996 0 1 0-1.41 1.41L16.17 11H5c-.55 0-1 .45-1 1s.45 1 1 1"/></svg>';
function renderMoodLog(){
  var l=$('#moodLog');if(!l)return;
  l.innerHTML='';
  $('#moodLogCnt').textContent=S.moodLog.length+' 篇';
  if(!S.moodLog.length){l.innerHTML='<div class="s-empty">还没有心情日记，写一条试试 🌈</div>';return;}
  S.moodLog.slice().sort(function(a,b){return b.ts-a.ts;}).forEach(function(it){
    var d=new Date(it.ts),wd=['日','一','二','三','四','五','六'][d.getDay()];
    /* 日期格式与工作日报一致：2026.11.16 + 周x */
    var ds=d.getFullYear()+'.'+String(d.getMonth()+1).padStart(2,'0')+'.'+String(d.getDate()).padStart(2,'0');
    var r=ce('div','jrow');
    r.innerHTML='<span class="jrow-fill"></span>'+
      '<div class="jdate">'+esc(ds)+'<span class="wd">周'+wd+'</span></div>'+
      '<div class="jbody">'+FACE[(it.m||3)-1]+' '+esc(it.t)+'</div>'+
      '<div class="jacts"><button class="jarrow" type="button" aria-label="查看这篇心情日记"><span class="jarrow-sq">'+ARROW_SVG+'</span></button></div>';
    r.querySelector('.jarrow').addEventListener('click',function(e){e.stopPropagation();showMoodDetail(it);});
    l.appendChild(r);
  });
}
var saveMoodBtn=$('#saveMood');
if(saveMoodBtn)saveMoodBtn.addEventListener('click',function(){
  var ta=$('#moodText'),v=ta.value.trim();
  if(!v){toast('写点什么再存吧 ✍️');return;}
  S.moodLog.unshift({ts:Date.now(),m:S.moodPick||3,t:v});
  /* 顺手把今天的心情格也点成这个脸 */
  save();ta.value='';renderMood();
  toast('心情日记已存 🌈');
});

/* 日报 · 历史列表 */
function todayJKey(){var d=new Date(),wd=['日','一','二','三','四','五','六'][d.getDay()];
  return d.getFullYear()+'.'+String(d.getMonth()+1).padStart(2,'0')+'.'+String(d.getDate()).padStart(2,'0')+' 周'+wd;}
function makeEntry(text,key){
  text=(text||'').replace(/\r/g,'');
  var m=text.match(/^(\d{4}\.\d{2}\.\d{2} 周[日一二三四五六])\s*\n?/);
  if(m){if(!key)key=m[1];text=text.slice(m[0].length);}
  return {date:key||todayJKey(),text:text,ts:Date.now()};
}
function renderJournals(enterTs){
  var l=$('#journalList');l.innerHTML='';
  S.journals.forEach(function(it,idx){
    var r=ce('div','jrow'+(enterTs&&it.ts===enterTs?' enter':''));
    var p=it.date.split(' ');
    r.innerHTML='<span class="jrow-fill"></span>'+
      '<div class="jdate">'+esc(p[0]||it.date)+'<span class="wd">'+(p[1]||'')+'</span></div>'+
      '<div class="jbody">'+esc(it.text)+'</div>'+
      '<div class="jacts">'+
        '<button class="jarrow" type="button" aria-label="查看这条日报详情"><span class="jarrow-sq">'+ARROW_SVG+'</span></button>'+
      '</div>';
    r.querySelector('.jarrow').addEventListener('click',function(e){e.stopPropagation();showJournalDetail(it);});
    l.appendChild(r);
  });
  $('#journalCnt').textContent=S.journals.length+' 篇';
}
/* 兼容旧版单字符串 journal，并入历史 */
if(!S.journals)S.journals=[];
if(typeof S.journal==='string'&&S.journal.trim()&&!S.journals.length){S.journals.push(makeEntry(S.journal));S.journal='';}
if(!S.journals.length)S.journals=[
  makeEntry('昨天把季度汇报 PPT 初稿写完，配图用了练习室 vlog 截图，主管说节奏感不错。','2026.08.22 周六'),
  makeEntry('周五摸鱼日，顺手把灵感墙「ikun 开屏动画」立项，周末开工。','2026.08.21 周五'),
  makeEntry('读了《认知觉醒》两章，关于元认知的部分很受用，记了三条笔记。','2026.08.20 周四')
];
$('#journal').value='';
renderJournals();
$('#saveJournal').addEventListener('click',function(){
  var v=$('#journal').value.trim();if(!v){toast('还没写呢 ✍️');return;}
  var p=$('#jPanel');p.classList.add('sending');setTimeout(function(){p.classList.remove('sending');},300);
  var e=makeEntry(v);S.journals.unshift(e);save();renderJournals(e.ts);
  $('#journal').value='';$('#journalSaved').textContent='已存入本机 · '+todayJKey();
  toast('存好了 📓');
});

/* 轮播箭头：任务轨道改两行网格后不滚，箭头按页切；其余视图仍用 scrollBy */
document.querySelectorAll('.carousel').forEach(function(c){
  var prev=c.querySelector('.prev'),next=c.querySelector('.next'),tr=c.querySelector('.track');
  if(!prev||!next||!tr)return;
  if(tr.classList.contains('task-grid')){
    var key=tr.id==='horTrack'?'hor':'today';
    function turn(d){
      var list=S.todos.filter(function(x){return key==='today'?x.hor==='today':x.hor===curHor;});
      var pages=Math.max(1,Math.ceil(list.length/PAGE_SIZE));
      var p=(pageState[key]||0)+d;if(p<0)p=0;if(p>=pages)p=pages-1;
      pageState[key]=p;
      paintPage(tr,c,pageOf(list,key));
    }
    prev.addEventListener('click',function(){turn(-1);});
    next.addEventListener('click',function(){turn(1);});
    /* 初始禁用态由 paintPage 在渲染时设置，这里不发 scroll 事件（轨道不滚） */

    /* 滚轮翻页：轨道自己不滚（两行网格，一屏就是一页），所以滚轮得手动接管。
       两条纪律：①累积到阈值才翻，触控板那种连续小 delta 不会一抖一页；
       ②翻页后 340ms 静默，一次滑轮不会连翻三四页。
       已经翻到头上/尾上时不拦截默认行为 —— 让页面接着往下滚，别把人卡在卡片里。 */
    var accW=0, lockW=0, WTH=40, WLOCK=340;
    function canTurn(d){
      var list=S.todos.filter(function(x){return key==='today'?x.hor==='today':x.hor===curHor;});
      var pages=Math.max(1,Math.ceil(list.length/PAGE_SIZE));
      var q=(pageState[key]||0)+d;
      return q>=0&&q<pages;
    }
    c.addEventListener('wheel',function(e){
      /* 只认「纵向为主」的滚动。两指横滑（deltaX 占优，含 45° 斜滑）整条忽略，
         并且把已累积的量清零 —— 否则横滑末尾那点零头会把下一页顶出去。
         纵向滚动时 deltaX 通常只有几像素，0.85 这个比值不会误伤正常滚动。 */
      var ax=Math.abs(e.deltaX),ay=Math.abs(e.deltaY);
      if(ax>=ay*0.85){accW=0;return;}
      if(Date.now()<lockW){e.preventDefault();return;}   /* 刚翻过页：这段静默期连页面滚动一起吃掉 */
      accW+=e.deltaY;
      if(Math.abs(accW)<WTH)return;
      var d=accW>0?1:-1;
      if(!canTurn(d)){accW=0;return;}                    /* 到头了：交给页面滚 */
      e.preventDefault();
      accW=0;
      var before=pageState[key]||0;
      turn(d);
      if((pageState[key]||0)!==before)lockW=Date.now()+WLOCK;
    },{passive:false});
    return;
  }
  function up(){prev.disabled=tr.scrollLeft<3;next.disabled=tr.scrollLeft>tr.scrollWidth-tr.clientWidth-3;}
  prev.addEventListener('click',function(){tr.scrollBy({left:-tr.clientWidth*.98,behavior:'smooth'});});
  next.addEventListener('click',function(){tr.scrollBy({left:tr.clientWidth*.98,behavior:'smooth'});});
  tr.addEventListener('scroll',up);up();
});

/* 日历：完整月视图（7 列 × 固定 6 行），上下滚动翻月，无左右按钮 */
var DOW=['日','一','二','三','四','五','六'];
var CAL_TODAY=TODAY();   /* 日历以真实今天为基准 */
var CAL_SPAN=3;                      /* 今天所在月份前后各 3 个月，共 7 块 */
var calBody=$('#cal'), calMH=0;

function calKey(d){return d.getFullYear()+'.'+String(d.getMonth()+1).padStart(2,'0')+'.'+String(d.getDate()).padStart(2,'0')+' 周'+DOW[d.getDay()];}
function calSame(a,b){return a.getFullYear()===b.getFullYear()&&a.getMonth()===b.getMonth()&&a.getDate()===b.getDate();}

function monthHTML(off){
  var first=new Date(CAL_TODAY.getFullYear(),CAL_TODAY.getMonth()+off,1);
  var y=first.getFullYear(),m=first.getMonth(),lead=first.getDay();
  var start=new Date(y,m,1-lead),h='<div class="cal-m"><div class="cal-dow">'+
    DOW.map(function(d){return '<span>'+d+'</span>';}).join('')+'</div><div class="cal-grid7">';
  /* 固定 42 格：本月前后用邻月的日期补位（灰色、不可点），这样每个月块等高，
     滚动吸附才对得上，日期看上去也是连续的 */
  for(var i=0;i<42;i++){
    var d=new Date(start.getFullYear(),start.getMonth(),start.getDate()+i);
    var out=d.getMonth()!==m,wd=d.getDay();
    /* 法定节假日 / 调休补班：数据来自 holidays.js（离线内置，缺年份就只按周末上色） */
    var hd=(typeof window.cnHoliday==='function')?window.cnHoliday(d):null;
    var rest=!!(hd&&hd.k==='rest'),swap=!!(hd&&hd.k==='work');
    var cls='cal-cell'+(out?' muted':'')+((wd===0||wd===6)?' we':'')+(calSame(d,CAL_TODAY)?' today':'')+
      ((S.planDays&&S.planDays[dayKey(d)]&&!out)?' has-plan':'')+
      (!out&&rest?' rest':'')+(!out&&swap?' swap':'');
    /* 另起一行的 muted 日期只是补位，不标记，免得灰格里还挂「休」字 */
    var tip=out||!hd?'':(rest?hd.n+' · 放假':hd.n+' · 调休上班');
    /* 「休 / 班」跟数字并排且基线对齐：格子只有 32.5px，贴角放会顶到右边界，
       并排放永远在格子中间，双位数也不挤 */
    var tag=(!out&&hd)?'<i class="'+(!rest?'s':'r')+'">'+(rest?'休':'班')+'</i>':'';
    /* 农历小字：邻月补位格不写（灰格再塞字就糊成一团），节日/节气/初一加深一档 */
    var ln=(!out&&typeof window.cnLunar==='function')?window.cnLunar(d):null;
    var cn=ln&&ln.t?'<span class="cl'+(ln.m?' mk':'')+'">'+ln.t+'</span>':'';
    h+='<div class="'+cls+'" data-d="'+calKey(d)+'"'+(out?'':' data-day="1"')+
      (tip?' title="'+tip+'"':'')+'><span class="cd">'+d.getDate()+tag+'</span>'+cn+'</div>';
  }
  return h+'</div></div>';
}

function renderCal(){
  var h='';
  for(var i=-CAL_SPAN;i<=CAL_SPAN;i++)h+=monthHTML(i);
  calBody.innerHTML=h;
  measureCal(true);
}

/* 容器高度 = 一个整月块的高度，保证任何时刻只完整露出一个月 */
function measureCal(init){
  var b=calBody.children[0];if(!b)return;
  var mh=b.getBoundingClientRect().height;if(!mh)return;
  if(Math.abs(mh-calMH)>0.5){calMH=mh;calBody.style.height=mh+'px';}
  if(init){
    var sb=calBody.style.scrollBehavior;calBody.style.scrollBehavior='auto';
    calBody.scrollTop=calMH*CAL_SPAN;
    calBody.style.scrollBehavior=sb||'';
  }
  syncCalLabel();
}

function syncCalLabel(){
  if(!calMH)return;
  var idx=Math.max(0,Math.min(CAL_SPAN*2,Math.round(calBody.scrollTop/calMH)));
  var d=new Date(CAL_TODAY.getFullYear(),CAL_TODAY.getMonth()+idx-CAL_SPAN,1);
  $('#calM').textContent=d.getFullYear()+' 年 '+(d.getMonth()+1)+' 月';
}

/* 日历只做展示：不绑点击、不跳页、不写日报（用户要求）。
   以前点日期会切到日报页并插入日期前缀，现在这条路已经去掉 —— 写日报走侧栏入口。 */
calBody.addEventListener('scroll',syncCalLabel,{passive:true});
renderCal();
if(window.ResizeObserver)new ResizeObserver(function(){measureCal(false);}).observe(calBody);

/* ── 本地天气（只看）────────────────────────────────────
   位置在日历标题行右侧，和月份同一行。拿不到数据就整块 hidden，
   日历照常显示 —— 天气是附加信息，不能因为断网影响主功能。
   温度取整、城市放 title（国内 IP 定位返回的是拼音，直接摆在脸上不好看）。 */
var wxEl=$('#wx');
function paintWeather(w){
  if(!wxEl)return;
  if(!w||!w.icon){wxEl.hidden=true;return;}
  var i=$('#wxIcon'),t=$('#wxTemp'),d=$('#wxText');
  if(i)i.textContent=w.icon;
  if(t)t.textContent=w.temp+'°';
  if(d)d.textContent=w.text;
  wxEl.hidden=false;
  var tip=(w.place?w.place+' · ':'')+w.text+' '+w.temp+'°';
  if(w.hi!=null&&w.lo!=null)tip+='（'+w.lo+'~'+w.hi+'°）';
  wxEl.title=tip;
}
function loadWeather(force){
  if(!api||!api.weatherGet)return;
  api.weatherGet(force===true).then(paintWeather).catch(function(){});
}
loadWeather(false);
/* 半小时刷一次：天气按小时变，和主进程的缓存周期对齐 */
setInterval(function(){loadWeather(false);},30*60*1000);

/* 弹窗 */
var modalBg=$('#modalBg'),modalBox=$('#modalBox'),modalTitle=$('#modalTitle'),modalInput=$('#modalInput'),modalArea=$('#modalArea'),
    modalAmount=$('#modalAmount'),modalCatRow=$('#modalCatRow'),modalAmtRow=$('#modalAmtRow'),modalView=$('#modalView'),
    modalOk=$('#modalOk'),modalCancel=$('#modalCancel'),pending=null;
var curCat='daily',curSign='out';
modalCatRow.querySelectorAll('button').forEach(function(b){b.addEventListener('click',function(){curCat=b.dataset.k;modalCatRow.querySelectorAll('button').forEach(function(x){x.classList.toggle('on',x===b);});});});
modalAmtRow.querySelectorAll('button').forEach(function(b){b.addEventListener('click',function(){curSign=b.dataset.s;modalAmtRow.querySelectorAll('button').forEach(function(x){x.classList.toggle('on',x===b);});});});
function openModal(title,opts){
  opts=opts||{};pending=opts.ctx||null;
  var view=!!opts.view;
  modalBox.classList.remove('hist');   /* 每次打开先清掉上一个弹窗的专用类 */
  modalTitle.textContent=title;
  modalInput.value='';modalArea.value='';modalAmount.value='';
  modalView.style.display=view?'flex':'none';
  modalInput.style.display=view?'none':'block';
  modalArea.style.display=(!view&&opts.area)?'block':'none';
  modalCatRow.style.display=(!view&&opts.cat)?'flex':'none';
  modalAmtRow.style.display=(!view&&opts.amount)?'flex':'none';
  modalOk.style.display=view?'none':'inline-block';
  modalCancel.textContent=view?'关闭':'取消';
  var modalActs=modalBox.querySelector('.acts');
  if(modalActs)modalActs.style.display=view?'none':'flex';
  modalBox.classList.toggle('wide',view);
  if(view){modalView.innerHTML=opts.viewHtml||'';}
  else{
    curCat='daily';curSign='out';
    modalCatRow.querySelectorAll('button').forEach(function(x){x.classList.toggle('on',x.dataset.k==='daily');});
    modalAmtRow.querySelectorAll('button').forEach(function(x){x.classList.toggle('on',x.dataset.s==='out');});
    modalInput.placeholder=opts.ph||'标题';
  }
  modalBg.classList.add('on');
  if(!view)(opts.amount?modalAmount:modalInput).focus();
}
function showJournalDetail(it){
  var p=(it.date||'').split(' ');
  var idx=S.journals.indexOf(it);
  var html='<div class="jview-date">'+esc(p[0]||it.date)+' <span>'+(p[1]||'')+'</span></div>'+
    '<div class="jview-text">'+esc(it.text)+'</div>'+
    '<div class="jview-acts">'+
      '<button class="jview-btn danger" type="button" data-jdel>删除</button>'+
      '<button class="jview-btn neutral" type="button" data-jclose>关闭</button>'+
    '</div>';
  openModal('日报详情',{view:true,viewHtml:html});
  var del=modalView.querySelector('[data-jdel]');
  if(del)del.addEventListener('click',function(){
    confirmDelete('确定删除这条日报吗？',function(){
      if(idx>-1){S.journals.splice(idx,1);save();renderJournals();}
      closeModal();toast('已删除这条日报 🗑️');
    });
  });
  var cls=modalView.querySelector('[data-jclose]');
  if(cls)cls.addEventListener('click',closeModal);
}
function closeModal(){modalBg.classList.remove('on');}
document.querySelectorAll('[data-add]').forEach(function(b){b.addEventListener('click',function(){
  var t=b.dataset.add;
  if(t==='idea')openModal('贴一张灵感',{ph:'一句话灵感…',ctx:{type:'idea'}});
  else if(t==='ledger')openModal('记一笔',{amount:true,ph:'这笔是啥，如：午餐',ctx:{type:'ledger'}});
  else openModal('新增待办',{area:true,cat:true,ph:'想做点啥…',ctx:{type:'todo',hor:t==='today'?'today':t==='short'?'short':t==='mid'?'mid':'long'}});
});});
var newHabitBtn=$('#newHabit');
if(newHabitBtn)newHabitBtn.addEventListener('click',function(){
  openModal('新建锻炼目标',{ph:'比如：跳绳 200 个、平板支撑 3 组',ctx:{type:'habit'}});
});
$('#modalCancel').addEventListener('click',closeModal);
modalBg.addEventListener('click',function(e){if(e.target===modalBg)closeModal();});
$('#modalOk').addEventListener('click',function(){
  var v=modalInput.value.trim();
  if(pending.type==='idea'){
    if(!v){toast('先写点东西嘛');return;}
    S.ideas.push({t:v});
    save();closeModal();renderIdeas();toast('已贴上墙 🎧');
  } else if(pending.type==='habit'){
    if(!v){toast('先写个目标名嘛');return;}
    /* 图标按已有数量轮换，不打断新增流程 */
    var HICON=['🏀','💪','🏃','🧘','🚴','🤸','🏋️','⛹️','🪢','🥊','🦵','🧗'];
    S.habits.push({ic:HICON[S.habits.length%HICON.length],nm:v,hist:{}});
    save();closeModal();renderHabits();toast('目标已加进打卡清单 🏀');
  } else if(pending.type==='ledger'){
    var amt=parseFloat(modalAmount.value);
    if(!v&&!amt){toast('写个名儿或金额呗');return;}
    if(isNaN(amt)||amt<=0){toast('金额填个正数嘛');return;}
    S.ledger.push({d:v||'一笔',a:curSign==='in'?Math.abs(amt):-Math.abs(amt),ts:Date.now()});
    save();closeModal();renderLedger();toast(curSign==='in'?('入账 +¥'+amt+' 💰'):('已支出 -¥'+amt+' 💸'));
  } else {
    if(!v){toast('先写点东西嘛');return;}
    S.todos.push({t:v,k:curCat,note:modalArea.value.trim(),done:false,hor:pending.hor});
    if(pending.hor!=='today')logGoal(v,pending.hor,'added');
    /* 新增后切到对应 tab，并跳到含新项的那页（新项 push 在末尾），保证新卡片可见 */
    if(pending.hor==='today'){
      var n=S.todos.filter(function(x){return x.hor==='today';}).length;
      pageState.today=Math.max(0,Math.ceil(n/PAGE_SIZE)-1);setTaskTab('today');
    } else {
      curHor=pending.hor;horSegApi.setActive({short:0,mid:1,long:2}[pending.hor]||0);
      var m=S.todos.filter(function(x){return x.hor===curHor;}).length;
      pageState.hor=Math.max(0,Math.ceil(m/PAGE_SIZE)-1);setTaskTab('hor');
    }
    save();closeModal();renderTodos();renderIdeas();paintHolidayCard();toast('已添加 ✦');
  }
});

/* toast */
var toastTimer;function toast(msg){var t=$('#toast');t.innerHTML=msg;t.classList.add('on');clearTimeout(toastTimer);toastTimer=setTimeout(function(){t.classList.remove('on');},1800);}

/* 二次确认（所有删除统一走这里防误触） */
var confirmBg=$('#confirmBg'),confirmMsg=$('#confirmMsg'),confirmYes=$('#confirmYes'),confirmNo=$('#confirmNo'),confirmCb=null;
function confirmDelete(msg,onYes){confirmMsg.textContent=msg;confirmCb=onYes;confirmBg.classList.add('on');confirmYes.focus();}
function closeConfirm(){confirmBg.classList.remove('on');confirmCb=null;}
confirmNo.addEventListener('click',closeConfirm);
confirmBg.addEventListener('click',function(e){if(e.target===confirmBg)closeConfirm();});
confirmYes.addEventListener('click',function(){var cb=confirmCb;closeConfirm();if(cb)cb();});

/* 粒子动效背景 */
(function(){
  if(window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches)return;
  var cv=$('#bg'),ctx=cv.getContext('2d'),ps=[],W,H;
  function rs(){W=cv.width=innerWidth;H=cv.height=innerHeight;}
  rs();addEventListener('resize',rs);
  var cols=['rgba(232,85,45,','rgba(185,139,224,'];
  for(var i=0;i<46;i++)ps.push({x:Math.random()*W,y:Math.random()*H,r:Math.random()*2.2+0.6,
    vx:(Math.random()-.5)*.25,vy:(Math.random()-.5)*.25,c:cols[i%2],a:Math.random()*.4+.15});
  (function loop(){
    ctx.clearRect(0,0,W,H);
    for(var i=0;i<ps.length;i++){var p=ps[i];p.x+=p.vx;p.y+=p.vy;
      if(p.x<0||p.x>W)p.vx*=-1;if(p.y<0||p.y>H)p.vy*=-1;
      ctx.beginPath();ctx.arc(p.x,p.y,p.r,0,7);ctx.fillStyle=p.c+p.a+')';ctx.fill();}
    requestAnimationFrame(loop);
  })();
})();

/* RubberSegment 原生实现（把 React 组件移植为原生，支持点击/拖拽/键盘，配色见 CSS） */
function rubber(over,dim){return (over*dim*0.55)/(dim+0.55*Math.abs(over));}
var placeHor=function(){};
function initRubberSegment(seg,onChange){
  var btns=Array.prototype.slice.call(seg.querySelectorAll('.rubber-segment__item'));
  var thumb=seg.querySelector('.rubber-segment__thumb');
  var idx=0;btns.forEach(function(b,i){if(b.getAttribute('aria-checked')==='true')idx=i;});
  function inset(){var v=parseFloat(getComputedStyle(seg).getPropertyValue('--rs-inset'));return isNaN(v)?3:v;}
  function rects(){var p=seg.getBoundingClientRect();return btns.map(function(b){var r=b.getBoundingClientRect();return {l:r.left-p.left,w:r.width};});}
  function place(i,anim){
    var rs=rects();if(!rs[i])return;var ins=inset();
    thumb.style.transition=anim?('left .3s cubic-bezier(.23,1,.32,1),width .3s cubic-bezier(.23,1,.32,1)'):'none';
    thumb.style.left=rs[i].l+'px';thumb.style.width=rs[i].w+'px';thumb.style.top=ins+'px';thumb.style.bottom=ins+'px';
  }
  placeHor=function(){place(idx,false);};
  function setActive(i,fire){
    if(i<0||i>=btns.length)return;
    btns.forEach(function(b,j){b.setAttribute('aria-checked',j===i?'true':'false');});
    place(i,true);
    if(fire&&i!==idx){idx=i;onChange(btns[i].dataset.hor,i);}else idx=i;
  }
  btns.forEach(function(b,i){
    b.addEventListener('click',function(e){if(e.detail===0)setActive(i,true);});
    b.addEventListener('keydown',function(e){
      if(e.key==='ArrowRight'||e.key==='ArrowDown'){e.preventDefault();setActive(Math.min(btns.length-1,idx+1),true);}
      else if(e.key==='ArrowLeft'||e.key==='ArrowUp'){e.preventDefault();setActive(Math.max(0,idx-1),true);}
    });
  });
  var drag=null;
  seg.addEventListener('pointerdown',function(e){
    if(e.button!==0)return;
    try{seg.setPointerCapture(e.pointerId);}catch(_){}
    drag={id:e.pointerId,x0:e.clientX,live:false,w:0,off:0};
    btns[idx].dataset.pressed='';
  });
  seg.addEventListener('pointermove',function(e){
    if(!drag||e.pointerId!==drag.id||!drag.live&&Math.abs(e.clientX-drag.x0)<4)return;
    if(!drag.live){drag.live=true;var rs=rects();drag.off=rs[idx].l;drag.w=rs[idx].w;}
    var p=seg.getBoundingClientRect(),ins=inset(),l=drag.off+(e.clientX-drag.x0),maxL=p.width-drag.w-ins*2;
    if(l<0)l=rubber(l,drag.w);
    else if(l>maxL)l=maxL+rubber(l-maxL,drag.w);
    thumb.style.transition='none';thumb.style.left=l+'px';
  });
  function endDrag(e){
    if(!drag||e.pointerId!==drag.id)return;
    delete btns[idx].dataset.pressed;seg.removeAttribute('data-held');
    if(drag.live){
      var rs=rects(),center=parseFloat(thumb.style.left)+drag.w/2,best=0;
      for(var i=1;i<rs.length;i++){if(Math.abs(rs[i].l+rs[i].w/2-center)<Math.abs(rs[best].l+rs[best].w/2-center))best=i;}
      setActive(best,true);
    }else if(e.clientX!==undefined){
      var tap=-1;
      btns.forEach(function(b,i){var r=b.getBoundingClientRect();if(e.clientX>=r.left&&e.clientX<=r.right)tap=i;});
      if(tap>=0)setActive(tap,true);
    }
    drag=null;
  }
  seg.addEventListener('pointerup',endDrag);
  seg.addEventListener('pointercancel',endDrag);
  seg.addEventListener('lostpointercapture',endDrag);
  seg.addEventListener('pointerdown',function(){seg.setAttribute('data-held','');});
  requestAnimationFrame(function(){place(idx,false);});
  return {setActive:function(i){setActive(i,false);}};
}

/* 阶段性任务：分类切换 + 新增 */
/* 页签行右侧的加号（today / hor 共用一个，原来各有一个、各占一行）。
   加什么由当前页签决定：阶段性任务按当前阶段（短期/中期/长期）建，今日任务固定 today。
   历史页没有新增，按钮隐藏但保留占位，避免整行左右跳动。 */
var taskAddBtn=$('#taskAdd');
function curTaskPanel(){var p=document.querySelector('.todo-panel.on');return p?p.dataset.panel:'today';}
if(taskAddBtn)taskAddBtn.addEventListener('click',function(){
  if(curTaskPanel()==='hor'){
    var lb={short:'短期',mid:'中期',long:'长期'}[curHor]||'待办';
    openModal('新增'+lb,{area:true,cat:true,ph:'想做点啥…',ctx:{type:'todo',hor:curHor}});
  }else{
    openModal('新增待办',{area:true,cat:true,ph:'想做点啥…',ctx:{type:'todo',hor:'today'}});
  }
});
/* 历史页签内的子页签（今日任务历史 / 阶段性任务历史） */
document.querySelectorAll('.hist-pane .ph-tab').forEach(function(b){
  b.addEventListener('click',function(){inlineHistTab=b.dataset.tab;inlineHistDay='';renderInlineHist();});
});
/* 「历史累计」磁贴只做展示：11-17 起不再点开历史页（连 ↗ 一起删掉），
   免得一格数据看着像入口。历史入口只剩今日任务标题下的「历史」页签。 */
/* 阶段性任务：扇形展开分段控件（三块叠放 + 三个热区联动），
   对外接口与旧 rubber-segment 一致，搜索定位仍可调 setActive(i)。 */
function initFanSegment(seg,onChange){
  var touches=Array.prototype.slice.call(seg.querySelectorAll('.touch'));
  var blocks=Array.prototype.slice.call(seg.querySelectorAll('.button'));
  var idx=0;
  touches.forEach(function(t,i){if(t.getAttribute('aria-checked')==='true')idx=i;});
  function setActive(i,fire){
    if(i<0||i>=touches.length)return;
    var changed=(i!==idx);
    touches.forEach(function(t,j){
      t.setAttribute('aria-checked',j===i?'true':'false');
      blocks[j].classList.toggle('on',j===i);
    });
    idx=i;
    if(fire&&changed)onChange(touches[i].dataset.hor,i);
  }
  touches.forEach(function(t,i){
    t.addEventListener('click',function(){setActive(i,true);});
    t.addEventListener('keydown',function(e){
      if(e.key==='Enter'||e.key===' '){e.preventDefault();setActive(i,true);}
      else if(e.key==='ArrowRight'||e.key==='ArrowDown'){e.preventDefault();setActive(Math.min(touches.length-1,idx+1),true);}
      else if(e.key==='ArrowLeft'||e.key==='ArrowUp'){e.preventDefault();setActive(Math.max(0,idx-1),true);}
    });
  });
  setActive(idx,false);
  return {setActive:function(i){setActive(i,false);}};
}
var horSegApi=initFanSegment($('#horSeg'),function(h){curHor=h;pageState.hor=0;renderHorTodos();});
var _switchView=switchView;
switchView=function(v){_switchView(v);if(v==='todos')requestAnimationFrame(placeHor);};

/* 搜索（粗野主义输入框）：跨 待办/灵感/习惯/阅读/账本 */
var searchInput=$('#searchInput'),searchPanel=$('#searchPanel');
var HORNAME={today:'今日',short:'短期',mid:'中期',long:'长期'},HORIDX={short:0,mid:1,long:2};
function doSearch(q){
  q=(q||'').trim();
  if(!q){searchPanel.classList.remove('on');return;}
  var ql=q.toLowerCase(),res=[];
  S.todos.forEach(function(it){if(((it.t||'')+' '+(it.note||'')).toLowerCase().indexOf(ql)>=0)res.push({v:'todos',tag:HORNAME[it.hor]||'计划',t:it.t,hor:it.hor});});
  (S.journals||[]).forEach(function(it){
    if(((it.text||'')+' '+(it.date||'')).toLowerCase().indexOf(ql)>=0)
      res.push({v:'journal',tag:'日报',t:(it.date||'')+' · '+(it.text||'').replace(/\s+/g,' ').slice(0,60)});
  });
  S.ideas.forEach(function(it){if((it.t||'').toLowerCase().indexOf(ql)>=0)res.push({v:'ideas',tag:'灵感',t:it.t});});
  S.habits.forEach(function(h){if((h.nm||'').toLowerCase().indexOf(ql)>=0)res.push({v:'habits',tag:'习惯',t:(h.ic||'')+' '+h.nm});});
  (S.books||[]).forEach(function(b){
    if((b.nm||'').toLowerCase().indexOf(ql)>=0)res.push({v:'reading',tag:'阅读',t:'《'+b.nm+'》 已读 '+b.cur+'/'+b.total});
  });
  S.ledger.forEach(function(e){if((e.d||'').toLowerCase().indexOf(ql)>=0)res.push({v:'ledger',tag:'账本',t:e.d+' '+(e.a>0?'+':'')+e.a+' 元'});});
  /* 计划/目标历史：命中标题/备注/日期，结果带日期标签，点开直接定位到那天的快照 */
  Object.keys(S.planDays||{}).forEach(function(k){
    var d=S.planDays[k];
    (d.items||[]).forEach(function(it){
      if(((it.t||'')+' '+(it.note||'')+' '+k).toLowerCase().indexOf(ql)>=0)
        res.push({v:'planhist',tag:'历史计划',t:k+' · '+it.t+(it.done?' ✓':''),day:k});
    });
    (d.goals||[]).forEach(function(g){
      if(((g.t||'')+' '+(g.note||'')+' '+k).toLowerCase().indexOf(ql)>=0)
        res.push({v:'goalhist',tag:'历史目标',t:k+' · '+({short:'短期',mid:'中期',long:'长期'}[g.hor]||'短期')+' '+g.t+(g.done?' ✓':''),day:k});
    });
  });
  searchPanel.innerHTML=res.length?res.slice(0,12).map(function(r){
    return '<button class="s-item" data-v="'+r.v+'" data-hor="'+(r.hor||'')+'" data-day="'+(r.day||'')+'"><span class="s-tag">'+r.tag+'</span><span class="s-txt">'+esc(String(r.t))+'</span></button>';
  }).join(''):'<div class="s-empty">没找到「'+esc(q)+'」，再练练？</div>';
  searchPanel.classList.add('on');
}
searchInput.addEventListener('input',function(){doSearch(searchInput.value);});
searchInput.addEventListener('focus',function(){doSearch(searchInput.value);});
searchInput.addEventListener('keydown',function(e){
  if(e.key==='Enter'){var f=searchPanel.querySelector('.s-item');if(f)f.click();}
  else if(e.key==='Escape'){searchPanel.classList.remove('on');searchInput.blur();}
});
searchPanel.addEventListener('click',function(e){
  var b=e.target.closest('.s-item');if(!b)return;
  var v=b.dataset.v,hor=b.dataset.hor;
  if(v==='planhist'){switchView('todos');inlineHistTab='plan';setTaskTab('hist',b.dataset.day||'');}
  else if(v==='goalhist'||v==='goallog'){switchView('todos');inlineHistTab='goals';setTaskTab('hist',b.dataset.day||'');}
  else{
    switchView(v);
    if(v==='todos'){
      if(HORIDX[hor]!==undefined){setTaskTab('hor');horSegApi.setActive(HORIDX[hor]);curHor=hor;pageState.hor=0;renderHorTodos();}
      else{setTaskTab('today');pageState.today=0;renderTodos();}
    }
  }
  searchPanel.classList.remove('on');
});
document.addEventListener('click',function(e){
  if(!e.target.closest('.input-container'))searchPanel.classList.remove('on');
});

/* 本子设置 · 左栏 Phantom 按钮 */
var settingsBg=$('#settingsBg'),setMotionBtn=$('#setMotion');
$('#phantomSet').addEventListener('click',function(){settingsBg.classList.add('on');$('#setClose').focus();});
$('#setClose').addEventListener('click',function(){settingsBg.classList.remove('on');});
settingsBg.addEventListener('click',function(e){if(e.target===this)settingsBg.classList.remove('on');});
/* 页面动效开关：落盘到 S.settings.motion */
var motionOn=S.settings.motion!==false;
function applyMotion(){
  document.body.classList.toggle('no-motion',!motionOn);
  setMotionBtn.textContent=motionOn?'开':'关';
  setMotionBtn.classList.toggle('on',motionOn);
  setMotionBtn.classList.toggle('ghost',!motionOn);
}
setMotionBtn.addEventListener('click',function(){
  motionOn=!motionOn;S.settings.motion=motionOn;
  applyMotion();save();toast(motionOn?'动效已开启 ✨':'动效已关闭');
});

/* 设置：开机自启 / 关窗后台 —— 状态以 S.settings 为准，主进程负责真正生效 */
function syncSettingsUI(){
  var sv=$('#setVer');if(sv)sv.textContent=(api&&api.appVersion)?api.appVersion:'3.0.0';
  var a=$('#setAutoStart'),k=$('#setKeepRun');
  if(a){a.textContent=S.settings.autoStart?'开':'关';a.classList.toggle('on',S.settings.autoStart);a.classList.toggle('ghost',!S.settings.autoStart);}
  if(k){k.textContent=S.settings.keepRunning?'开':'关';k.classList.toggle('on',S.settings.keepRunning);k.classList.toggle('ghost',!S.settings.keepRunning);}
  applyMotion();
  paintStandup();
}
var autoBtn=$('#setAutoStart');
if(autoBtn)autoBtn.addEventListener('click',function(){
  var on=!S.settings.autoStart;S.settings.autoStart=on;save();syncSettingsUI();
  if(api&&api.setAutoStart)api.setAutoStart(on);
  toast(on?'下次开机自动在后台等着你':'已关掉开机自启');
});
var keepBtn=$('#setKeepRun');
if(keepBtn)keepBtn.addEventListener('click',function(){
  var on=!S.settings.keepRunning;S.settings.keepRunning=on;save();syncSettingsUI();
  toast(on?'点叉只是收进托盘，不会退出':'点叉就真的退出');
});

/* ═══ 久坐提醒（起身活动）════════════════════════════════
   计时在主进程（点叉收托盘也照跑），这里只管三件事：
   ① 设置页两行（开关 / 间隔）② 到点的提醒卡 ③ 卡片里的休息音乐。
   倒计时每秒自己走一格，主进程推状态时再对齐 —— 否则那行数字会一直停在打开时的值。 */
var suBg=$('#standupBg'),suAudio=$('#suAudio'),suPlayBtn=$('#suPlay'),suRail=$('#suRail');
var suShownIdx=-1;   /* 上一次画出来的曲目序号：换歌才触发曲名动效 */
var suSwitch=$('#suSwitch'),suInt=$('#suInt');
var suLive={enabled:false,intervalMin:45,remainMs:0,pending:false};

function suCfg(){
  if(!S.settings.standup||typeof S.settings.standup!=='object')S.settings.standup={enabled:false,intervalMin:45};
  return S.settings.standup;
}
function suFmt(ms){
  var s=Math.max(0,Math.ceil(ms/1000)),m=Math.floor(s/60),ss=s%60;
  if(m<=0)return ss+' 秒';
  return m+' 分 '+(ss<10?'0':'')+ss+' 秒';
}
function suFmtTime(sec){
  sec=Math.max(0,Math.floor(sec||0));
  var m=Math.floor(sec/60),s=sec%60;
  return m+':'+(s<10?'0':'')+s;
}
function paintStandup(st){
  if(st)suLive=st;
  var c=suCfg(),on=c.enabled===true;
  if(!suRail)return;
  var eta=$('#suRailEta'),tag=$('#suRailTag'),note=$('#suRailNote'),fg=$('#suRailFg');
  if(suSwitch){
    suSwitch.checked=on;
    suSwitch.classList.toggle('on',on);
    suSwitch.setAttribute('aria-checked',on?'true':'false');
  }
  if(suInt)suInt.textContent=c.intervalMin+' 分钟';
  suRail.classList.toggle('off',!on);
  suRail.classList.toggle('pending',!!(on&&suLive.pending));
  if(!on){
    /* 关闭态不再摆一个「—」+ 小字（读起来像数据没加载出来）：
       大字位改成一句手写话，小字位留空，进度条改成斜纹空槽 —— 三处一起说「歇着」。 */
    if(eta)eta.textContent='还没开练';
    if(tag)tag.textContent='';
    if(note)note.textContent='开了就到点喊你打球';
    if(fg)fg.style.width='0%';
  }else if(suLive.pending){
    if(eta)eta.textContent='快起来';
    if(tag)tag.textContent='就差你';
    if(note)note.textContent='起来打球去';
    if(fg)fg.style.width='100%';
  }else{
    var total=c.intervalMin*60000,left=Math.max(0,suLive.remainMs||0);
    var mm=Math.floor(left/60000),ss=Math.floor((left%60000)/1000);
    if(eta)eta.textContent=(mm<10?'0':'')+mm+':'+(ss<10?'0':'')+ss;
    if(tag)tag.textContent='练习中';
    if(note)note.textContent='到点喊你打篮球';
    if(fg)fg.style.width=(total>0?(1-left/total)*100:0).toFixed(1)+'%';
  }
}
/* 每秒把剩余时间往下推一格，顺手把右栏也刷了（两处显示的是同一个事实） */
setInterval(function(){
  if(!suLive.enabled)return;
  if(!suLive.pending)suLive.remainMs=Math.max(0,suLive.remainMs-1000);
  paintStandup();
},1000);

if(suSwitch)suSwitch.addEventListener('click',function(){
  var c=suCfg();c.enabled=!c.enabled;
  if(!c.enabled)closeStandup();
  save();paintStandup();
  if(api&&api.standupGet)api.standupGet().then(paintStandup);
  toast(c.enabled?'久坐提醒已开 · 每 '+c.intervalMin+' 分钟喊你打球':'久坐提醒已关 · 先歇着');
});
/* 间隔不再只给固定几档：点右栏那颗胶囊打开输入框，自己填任意分钟。
   范围与主进程、数据层保持一致（5~240），三处写死同一个区间。 */
var siBg=$('#suIntBg'),siNum=$('#siNum'),siPresets=$('#siPresets'),
    siMinus=$('#siMinus'),siPlus=$('#siPlus');
var SU_LO=5,SU_HI=240,SU_STEP=5;
function siClamp(v){
  v=Math.round(Number(v));
  if(!isFinite(v))return SU_LO;
  return Math.min(SU_HI,Math.max(SU_LO,v));
}
/* force=true：由步进/快捷档触发的写入，必须落进输入框。
   不给 force 时如果输入框正在被编辑就不覆盖 —— 否则用户敲到一半会被夹紧的值冲掉。 */
function siPaint(v,force){
  var n=siClamp(v);
  if(siNum&&(force||document.activeElement!==siNum))siNum.value=n;
  if(siMinus)siMinus.disabled=n<=SU_LO;
  if(siPlus)siPlus.disabled=n>=SU_HI;
  if(siPresets){
    var bs=siPresets.querySelectorAll('button');
    for(var i=0;i<bs.length;i++)bs[i].classList.toggle('on',Number(bs[i].dataset.m)===n);
  }
}
function siRead(){
  /* 输入框可能是空的或写着 “-” 这类中间态，取不到数就退回当前配置 */
  var v=parseInt(siNum&&siNum.value,10);
  return isFinite(v)?siClamp(v):suCfg().intervalMin;
}
function openSuInt(){
  if(!siBg)return;
  siPaint(suCfg().intervalMin);
  siBg.classList.add('on');
  if(siNum)setTimeout(function(){siNum.focus();siNum.select();},60);
}
function closeSuInt(){if(siBg)siBg.classList.remove('on');}
function applySuInt(){
  var v=siRead(),c=suCfg();
  closeSuInt();
  if(v===c.intervalMin){toast('还是每 '+v+' 分钟');return;}
  c.intervalMin=v;
  save();paintStandup();
  if(api&&api.standupGet)api.standupGet().then(paintStandup);
  toast('改成每 '+v+' 分钟提醒一次');
}
if(suInt)suInt.addEventListener('click',openSuInt);
if(siMinus)siMinus.addEventListener('click',function(){siPaint(siRead()-SU_STEP,true);});
if(siPlus)siPlus.addEventListener('click',function(){siPaint(siRead()+SU_STEP,true);});
if(siPresets)siPresets.addEventListener('click',function(e){
  var b=e.target.closest('button[data-m]');
  if(!b)return;
  siPaint(Number(b.dataset.m),true);
});
if(siNum){
  /* 打字过程中不夹紧 —— 想输 120 时刚敲一个 1 就被抬到 5，越输入越别扭。
     只在离开输入框时归位。 */
  siNum.addEventListener('input',function(){
    var v=parseInt(siNum.value,10);
    if(siPresets){
      var bs=siPresets.querySelectorAll('button');
      for(var i=0;i<bs.length;i++)bs[i].classList.toggle('on',isFinite(v)&&Number(bs[i].dataset.m)===v);
    }
  });
  siNum.addEventListener('blur',function(){siPaint(siRead(),true);});
  siNum.addEventListener('keydown',function(e){
    if(e.key==='Enter'){e.preventDefault();applySuInt();}
    else if(e.key==='ArrowUp'){e.preventDefault();siPaint(siRead()+SU_STEP,true);}
    else if(e.key==='ArrowDown'){e.preventDefault();siPaint(siRead()-SU_STEP,true);}
  });
}
if($('#siSave'))$('#siSave').addEventListener('click',applySuInt);
if($('#siCancel'))$('#siCancel').addEventListener('click',closeSuInt);
if(siBg)siBg.addEventListener('click',function(e){if(e.target===siBg)closeSuInt();});
document.addEventListener('keydown',function(e){
  if(e.key==='Escape'&&siBg&&siBg.classList.contains('on')){e.preventDefault();closeSuInt();}
});

/* 提醒卡 + 休息音乐
   播放列表由主进程扫 audio/ 目录得到：丢 mp3 进去就出现，不用改任何配置。
   曲名按「艺术家 - 曲名」拆；单曲不显示切歌箭头；播完自动下一首，最后一首回到第一首。 */
var suTracks=[],suIdx=0,suErrCount=0;
function suPlayMusic(){
  if(!suAudio||!suAudio.getAttribute('src'))return;
  var p=suAudio.play();
  if(p&&p.catch)p.catch(function(){});  /* 自动播放被拦就静默，用户可以手动点 */
}
function suStopMusic(){
  if(!suAudio)return;
  try{suAudio.pause();suAudio.currentTime=0;}catch(e){}
}
function suPaintTrack(){
  var pl=$('#suPlayer');
  if(!suTracks.length){if(pl)pl.style.display='none';return;}
  if(pl)pl.style.display='';
  var t=suTracks[suIdx]||{};
  var b=$('#suTrack');
  if(b){
    b.innerHTML=esc(t.title||'')+(t.artist?'<i>'+esc(t.artist)+'</i>':'');
    /* 换歌才滑一下：窗口 focus 也会重画这一行，每次都滑就成了抽搐。
       用 rAF 重启动画，不写 void offsetWidth 强制重排。 */
    if(suShownIdx!==-1&&suShownIdx!==suIdx){
      b.classList.remove('swap');
      requestAnimationFrame(function(){b.classList.add('swap');});
    }
  }
  suShownIdx=suIdx;
  var c=$('#suCount');if(c)c.textContent=(suIdx+1)+'/'+suTracks.length;
  var multi=suTracks.length>1;
  ['#suPrev','#suNext'].forEach(function(sel){var n=$(sel);if(n)n.style.display=multi?'grid':'none';});
}
function suLoadTrack(i,play){
  if(!suTracks.length||!suAudio)return;
  suIdx=((i%suTracks.length)+suTracks.length)%suTracks.length;
  suAudio.src=suTracks[suIdx].file;
  suPaintTrack();
  if(play)suPlayMusic();
}
/* 每次弹卡都重新扫一遍 audio/ —— 用户中途丢进去的歌，下一次提醒就能听到，
   不用重启应用。当前这首如果还在列表里就接着它，不打断。 */
function suSameList(a,b){
  if(a.length!==b.length)return false;
  for(var i=0;i<a.length;i++){if(a[i].file!==b[i].file)return false;}
  return true;
}
function suRefreshList(done){
  if(!api||!api.audioList){if(done)done();return;}
  api.audioList().then(function(r){
    var next=(r&&r.tracks)||[];
    /* 列表没变就别动 —— 重设 src 会把正在播的歌打断（窗口一获得焦点就刷，
       不判等的话切回来听歌会被掐一下）。 */
    if(suSameList(next,suTracks)){suPaintTrack();if(done)done();return;}
    if(!next.length){suTracks=[];suIdx=0;suPaintTrack();if(done)done();return;}
    var cur=suTracks[suIdx]?suTracks[suIdx].file:'';
    var wasPlaying=suAudio&&!suAudio.paused;
    suTracks=next;
    var i=-1;
    for(var k=0;k<suTracks.length;k++){if(suTracks[k].file===cur){i=k;break;}}
    suIdx=i>=0?i:0;
    suLoadTrack(suIdx,false);
    if(wasPlaying)suPlayMusic();
    if(done)done();
  }).catch(function(){if(done)done();});
}
function openStandup(payload){
  if(!suBg)return;
  /* 起身提醒优先级最高：先把设置/更新这些还开着的弹窗收掉，
     否则会叠成两层弹窗（用户从设置里改完间隔，很可能立刻就撞上提醒） */
  document.querySelectorAll('.modal-bg.on').forEach(function(n){if(n!==suBg)n.classList.remove('on');});
  if(payload){
    if(payload.title&&$('#suTitle'))$('#suTitle').textContent=payload.title;
    if(payload.message&&$('#suMsg'))$('#suMsg').textContent=payload.message;
  }
  suBg.classList.add('on');
  suRefreshList(function(){suPlayMusic();});
}
function closeStandup(){
  if(suBg)suBg.classList.remove('on');
  suStopMusic();
}
function respondStandup(kind){
  closeStandup();
  if(api&&api.standupRespond)api.standupRespond(kind).then(paintStandup);
  toast(kind==='done'?'起来动动 · 下一轮 '+suCfg().intervalMin+' 分钟后再喊':'行，再坐 10 分钟');
}
/* 进度只写一个变量：.su-fill 的宽度和走针的 left 都在 CSS 里由 --r 算出来，
   这样两处永远同步，也不用每帧摸两个元素的 style。 */
function suSetProgress(r){
  var p=$('#suProg');if(!p)return;
  r=Math.max(0,Math.min(1,r||0));
  p.style.setProperty('--r',r.toFixed(4));
}
function suSetPlaying(on){
  if(suPlayBtn)suPlayBtn.classList.toggle('playing',on);
  var pl=$('#suPlayer');if(pl)pl.classList.toggle('playing',on);
}
if($('#suDone'))$('#suDone').addEventListener('click',function(){respondStandup('done');});
if($('#suLater'))$('#suLater').addEventListener('click',function(){respondStandup('later');});
if(suBg){
  /* 提醒卡不做「点遮罩关闭」：起身提醒必须选一个，不能糊里糊涂点空白划过去 */
  if(suAudio){
    suAudio.addEventListener('loadedmetadata',function(){
      suErrCount=0;
      suSetProgress(0);
      if($('#suTime'))$('#suTime').textContent='0:00 / '+suFmtTime(suAudio.duration);
    });
    suAudio.addEventListener('timeupdate',function(){
      var d=suAudio.duration||0;if(!d)return;
      suSetProgress(suAudio.currentTime/d);
      if($('#suTime'))$('#suTime').textContent=suFmtTime(suAudio.currentTime)+' / '+suFmtTime(d);
    });
    /* 播完自动下一首；只有一首时等于单曲循环，整首放完再从头来 */
    suAudio.addEventListener('ended',function(){suLoadTrack(suIdx+1,true);});
    /* 某首解不了码（比如酷狗加密的 .kgg 改了扩展名）就跳过去；
       全部都不行才把整条播放器收起来 */
    suAudio.addEventListener('error',function(){
      suErrCount++;
      if(suErrCount<=suTracks.length&&suTracks.length>1){suLoadTrack(suIdx+1,false);}
      else{var pl=$('#suPlayer');if(pl)pl.style.display='none';}
    });
    /* 播放态两处一起切：按钮换图标 + 唱片开始转（只动 transform，不碰布局） */
    suAudio.addEventListener('play',function(){suSetPlaying(true);});
    suAudio.addEventListener('pause',function(){suSetPlaying(false);});
    if(suPlayBtn)suPlayBtn.addEventListener('click',function(){
      if(suAudio.paused)suPlayMusic();else suAudio.pause();
    });
    ['#suPrev','#suNext'].forEach(function(sel){
      var n=$(sel);if(!n)return;
      n.addEventListener('click',function(e){
        e.stopPropagation();
        suLoadTrack(suIdx+(sel==='#suPrev'?-1:1),true);
      });
    });
    var suProgEl=$('#suProg');
    if(suProgEl)suProgEl.addEventListener('click',function(e){
      var d=suAudio.duration||0;if(!d)return;
      var r=suProgEl.getBoundingClientRect();
      suAudio.currentTime=Math.max(0,Math.min(1,(e.clientX-r.left)/r.width))*d;
    });
  }
}
/* 播放条右侧两个管理按钮 */
if($('#suAdd'))$('#suAdd').addEventListener('click',function(){
  var btn=this;
  if(!api||!api.musicAdd){toast('这个版本还不支持在应用内加歌');return;}
  btn.disabled=true;
  api.musicAdd().then(function(r){
    btn.disabled=false;
    if(!r||!r.ok){toast('添加失败，可以直接把文件拖进 music 文件夹');return;}
    if(r.canceled)return;
    if(!r.added){toast(r.skipped?'这些不是能播的音频文件':'没选到文件');return;}
    var had=suTracks.length;
    var playing=!suAudio.paused;
    var keep=suTracks[suIdx]?suTracks[suIdx].file:'';
    suTracks=r.tracks||[];
    /* 加完自动切到刚加的这首（用户刚选的，多半就是现在想听的那首） */
    var target=-1,newName=(r.names&&r.names[0])||'';
    for(var k=0;k<suTracks.length;k++){if(suTracks[k].name===newName){target=k;break;}}
    if(target<0)for(var m=0;m<suTracks.length;m++){if(suTracks[m].file===keep){target=m;break;}}
    suIdx=target<0?0:target;
    if(!had){
      suLoadTrack(suIdx,true);          /* 之前一首都没有，加完直接播 */
    }else{
      suAudio.src=suTracks[suIdx].file;
      suPaintTrack();
      if(playing)suPlayMusic();
    }
    toast('已加入 '+r.added+' 首音乐'+(r.skipped?'，跳过 '+r.skipped+' 个非音频':''));
  }).catch(function(){btn.disabled=false;toast('添加失败，可以直接拖进 music 文件夹');});
});
if($('#suFolder'))$('#suFolder').addEventListener('click',function(){
  if(!api||!api.musicOpen){toast('这个版本还不支持');return;}
  api.musicOpen().then(function(r){
    if(r&&!r.ok&&r.error)toast('打不开文件夹：'+r.error);
    else toast('音乐都放在 music 文件夹里，拖进去就行');
  });
});
/* 从文件夹拖完歌切回来：提醒卡还开着就顺手刷新，不用重开 */
window.addEventListener('focus',function(){
  if(suBg&&suBg.classList.contains('on'))suRefreshList();
});

if(api&&api.onStandUpShow)api.onStandUpShow(openStandup);
if(api&&api.onStandUpState)api.onStandUpState(paintStandup);
if(api&&api.standupGet)api.standupGet().then(paintStandup);
suRefreshList();

/* ═══ 头图信息：全部取自真实数据，不再写死 ═══ */
function two(n){return n<10?'0'+n:''+n;}
function cjkToDate(v){
  var m=/^(\d{4})\.(\d{2})\.(\d{2})/.exec(v||'');
  if(!m)return null;
  var d=new Date(+m[1],+m[2]-1,+m[3]);
  return isNaN(d.getTime())?null:d;
}
/* 练习第几天：以最早一条数据为起点，没有数据就算第 1 天 */
function practiceDayNo(){
  var min=null;
  S.journals.forEach(function(j){var d=cjkToDate(j.date);if(d){var t=d.getTime();if(min===null||t<min)min=t;}});
  S.ledger.forEach(function(e){if(e.ts&&(min===null||e.ts<min))min=e.ts;});
  S.moodLog.forEach(function(e){if(e.ts&&(min===null||e.ts<min))min=e.ts;});
  if(min===null)return 1;
  var d0=new Date(min);d0=new Date(d0.getFullYear(),d0.getMonth(),d0.getDate());
  return Math.max(1,Math.round((TODAY().getTime()-d0.getTime())/86400000)+1);
}
function paintHeader(){
  var t=TODAY(),n=practiceDayNo();
  var wd=['周日','周一','周二','周三','周四','周五','周六'][t.getDay()];
  var ds=t.getFullYear()+'.'+two(t.getMonth()+1)+'.'+two(t.getDate());
  var md=$('.mast-date');
  if(md){
    /* 日期下面那句：不放统计，放每日轮换的坤味标语（按日期取模，同一天固定同一句） */
    var TAGS=['鸡你太美，日子也得美','你干嘛～哎哟，又认真了一天','两年半的经验，全都用在今天',
      '小黑子勿扰，本坤专注打卡','食不食油饼？先把待办清了','律动不停，日报不停','今天也要 全·能·输·出'];
    var tag=TAGS[(t.getFullYear()*372+(t.getMonth()+1)*31+t.getDate())%TAGS.length];
    md.innerHTML='<b>'+ds+' '+wd+'</b><br>'+tag;
  }
  var gr=$('#greet');
  if(gr){var hh=new Date().getHours();
    gr.textContent=(hh>=5&&hh<11)?'早安':(hh>=11&&hh<14)?'午安':(hh>=14&&hh<18)?'下午好':(hh>=18&&hh<23)?'晚上好':'夜深了';}
  var pno=$('.poster-head em');if(pno)pno.textContent='NO.'+n;
  var ta=$('#journal');
  if(ta&&!ta.value)ta.placeholder=ds+' '+wd+'\n今天完成了…';
}
/* ═══════════ 新版本首次启动的更新介绍 ═══════════
   文案由用户定稿后再发版。key 必须与 package.json 的 version 完全一致，
   发版前把新版本号补进来即可；没有对应文案的版本不会弹窗。
   首次接入（老数据没有 seenVersion）静默记为已看，不弹，避免老用户被旧版本说明打扰。 */
var RELEASE_NOTES={
  '3.0.1':{
    date:'2026.11.16',
    items:[
      '今日计划和阶段目标两侧的翻页箭头换了新动画：墨黑环淡出、球场橙环扩散，箭头顺着翻页方向滑出去，全程不会消失',
      '计划与目标卡片做成玻璃质感，半透明能看见底下的纸纹',
      '「来一段 / 加一个」换成新样式：浅紫底配墨黑描边，鼠标划过文字隐去、铅笔滑到中间',
      '阶段目标的「短期 / 中期 / 长期」叠成三块小卡片，鼠标扫过扇形展开，位置挪到标题行正中',
      '历史档案入口搬到概览区「历史累计」那一格，点它就能翻旧账',
      '心情日记的列表改成跟工作日报一样的卡片，日期格式和字号都统一了，两个模块的区域分布也对齐',
      '新版本第一次打开会弹一次「这次更新了什么」，看完记下版本，下次不再打扰',
      '检查更新时能看到新版本都改了什么，点「下载并更新」直接下载，全程有进度和转圈提示',
      '顺手瘦身：去掉标题栏的「已完成」数字、卡片上的「点这里看备注」、详情页的返回按钮、心情日记底部的统计栏'
    ]
  }
};
function showWhatsNew(ver,note){
  var bg=$('#wnBg');if(!bg)return;
  $('#wnVer').textContent='v'+ver;
  $('#wnDate').textContent=(note&&note.date)||'';
  $('#wnList').innerHTML=((note&&note.items)||[]).map(function(t){return '<li>'+esc(t)+'</li>';}).join('');
  bg.classList.add('on');
}
function markSeenVersion(ver){
  S.settings=S.settings||{};
  S.settings.seenVersion=ver||'';
  save();
}
function maybeShowWhatsNew(){
  var ver=(window.todoAPI&&window.todoAPI.appVersion)||'';
  if(!ver)return;
  var seen=(S.settings&&S.settings.seenVersion)||'';
  if(!seen){markSeenVersion(ver);return;}   /* 老数据首次接入：只记版本，不弹 */
  if(seen!==ver){
    /* 有文案就弹；没写文案的版本也照样记下，避免下次升级时基准错位 */
    if(RELEASE_NOTES[ver])showWhatsNew(ver,RELEASE_NOTES[ver]);
    markSeenVersion(ver);
  }
}
var wnOkBtn=$('#wnOk');
if(wnOkBtn)wnOkBtn.addEventListener('click',function(){
  markSeenVersion((window.todoAPI&&window.todoAPI.appVersion)||'');
  $('#wnBg').classList.remove('on');
});
function bootRender(){
  renderTodos();renderIdeas();renderHabits();renderBook();renderLedger();renderMood();
  renderJournals();     /* 数据是异步取回的，启动时必须重画一次历史日报 */
  paintHolidayCard();
  paintHeader();
  renderCal();         /* 顶层那次渲染时数据还没回来，这里按归档数据补上日期标记 */
  setTimeout(replayViewAnim,60);
  placeTabSlider();     /* 贴纸滑块定位：按钮宽度随字体加载才定，这里先摆一次 */
  window.addEventListener('resize',placeHor);
  window.addEventListener('resize',function(){placeTabSlider();});
  if(document.fonts&&document.fonts.ready)document.fonts.ready.then(function(){placeHor();placeTabSlider();});
  maybeShowWhatsNew();   /* 新版本首次启动：先把界面画好，再弹更新说明 */
}
/* 启动：先把数据取回来再渲染（文件存储是异步的，不能像 localStorage 那样同步读） */
(function boot(){
  if(!api||!api.loadData){ bootRender(); syncSettingsUI(); return; }
  api.loadData().then(function(res){
    var d=res&&res.data?res.data:res;
    if(d&&typeof d==='object')S=Object.assign(S,d);
    var rolled=rollPlanDay();          /* 跨天：先归档昨天，再渲染今天 */
    /* 新装已从空白开始：不再灌演示数据。
       历史上这里调 seedDemo() 会给新用户造出 12 条假待办、假账本、假打卡，
       导致「新装用户什么都没建，概览却显示 3 条 / 第 31 天练习」。
       seeded 仍要置 1，否则每次启动都会重新判定为新装。老用户 seeded=true，行为不变。 */
    var fresh=!S.seeded;
    if(fresh)S.seeded=1;
    var cleaned=cleanLegacyDemo();     /* 一次性清掉历史版本灌进来的演示数据（只删完全匹配种子的条目） */
    bootRender();syncSettingsUI();
    if(rolled||fresh||cleaned)save();
  }).catch(function(){ bootRender();syncSettingsUI(); });
})();
/* 跨零点不关窗：每分钟检查一次日期，变了立刻归档（不重启也不丢快照），
   同时把日历基准日、归档标记、页眉日期/标语一起刷新。 */
setInterval(function(){
  if(rollPlanDay()){
    CAL_TODAY=TODAY();
    save();renderTodos();paintHolidayCard();renderCal();paintHeader();
  }
},60000);

/* ═══════════════ 3.0.0 产品化：无边框窗口控制 ═══════════════
   拖拽完全交给主进程（它读真实屏幕光标算位移），渲染层只负责
   「是否真的拖动了」的门槛与贴边预览，避免 DPI 缩放下窗口越拖越大。 */
var DRAG_MIN=6,SNAP_EDGE=8,winDrag=null;
var hasWin=!!(api&&api.winControl);
var titlebar=$('.masthead');
function showSnap(side){var el=$('#snap-preview');if(!el)return;el.className=side?'show '+side:'';}
function hideSnap(){var el=$('#snap-preview');if(el)el.className='';}
function detectSnap(x,y,dx,dy){
  var d=winDrag;if(!d||!d.moved)return null;
  var s=window.screen;
  var L=s.availLeft,T=s.availTop,R=L+s.availWidth,B=T+s.availHeight;
  var nL=x<=L+SNAP_EDGE,nR=x>=R-SNAP_EDGE,nT=y<=T+SNAP_EDGE,nB=y>=B-SNAP_EDGE;
  var side=null;
  if(nT&&nL&&dy<0)side='top-left';
  else if(nT&&nR&&dy<0)side='top-right';
  else if(nB&&nL)side='bottom-left';
  else if(nB&&nR)side='bottom-right';
  else if(nL&&dx<0)side='left';
  else if(nR&&dx>0)side='right';
  else if(nT&&dy<-DRAG_MIN)side='top';
  d.snap=side;showSnap(side);return side;
}
function updateMaxBtn(){
  var b=$('#win-max');if(!b||!hasWin)return;
  api.winControl('is-maximized').then(function(r){
    var on=!!(r&&r.ok&&r.value);
    b.classList.toggle('is-max',on);
    b.title=on?'还原':'最大化';
  });
}
['win-min','win-max','win-close'].forEach(function(id){
  var el=$('#'+id);if(!el)return;
  el.addEventListener('click',function(e){
    e.stopPropagation();
    if(!hasWin)return;
    var act=id==='win-min'?'minimize':(id==='win-max'?'toggle-maximize':'close');
    api.winControl(act).then(function(){if(id==='win-max')setTimeout(updateMaxBtn,40);});
  });
});
if(titlebar&&hasWin){
  titlebar.addEventListener('dblclick',function(e){
    if(e.target.closest('.wbtns')||e.target.closest('.input-container'))return;
    api.winControl('toggle-maximize').then(updateMaxBtn);
  });
  var dragPending=false;
  function onMove(e){
    var d=winDrag;if(!d||!d.started)return;
    var dx=e.screenX-d.sx,dy=e.screenY-d.sy;
    if(!d.moved){
      if(Math.abs(dx)<DRAG_MIN&&Math.abs(dy)<DRAG_MIN)return;
      d.moved=true;
    }
    detectSnap(e.screenX,e.screenY,dx,dy);
    if(dragPending)return;
    dragPending=true;
    requestAnimationFrame(function(){
      dragPending=false;
      if(winDrag===d)api.winControl('drag-move');
    });
  }
  function onUp(){
    document.removeEventListener('mousemove',onMove);
    document.removeEventListener('mouseup',onUp);
    window.removeEventListener('blur',onUp);
    var d=winDrag,side=d&&d.moved?d.snap:null;
    hideSnap();winDrag=null;
    if(d)api.winControl('drag-end',{side:side}).then(updateMaxBtn,updateMaxBtn);
  }
  titlebar.addEventListener('mousedown',function(e){
    if(e.button!==0)return;
    if(e.target.closest('.wbtns')||e.target.closest('.input-container')||e.target.closest('.tag'))return;
    var d={sx:e.screenX,sy:e.screenY,snap:null,moved:false,started:false};
    winDrag=d;
    api.winControl('drag-start').then(function(r){
      if(r&&r.ok&&winDrag===d)d.started=true;
    });
    document.addEventListener('mousemove',onMove);
    document.addEventListener('mouseup',onUp);
    window.addEventListener('blur',onUp);
  });
}
if(hasWin)updateMaxBtn();

/* ═══════════════ 检查更新 ═══════════════ */
var upInfo=null;
function fmtMB(n){return (n/1048576).toFixed(1)+' MB';}

/* 更新说明解析：支持 markdown 风格的标题行（## xxx）与列表行（- xxx），
   解析成 [{h:1/0, t:'文字'}]，交给弹窗渲染成圆点列表。 */
function parseNotes(raw){
  var lines=String(raw||'').split(/\r?\n/),out=[];
  for(var i=0;i<lines.length;i++){
    var s=lines[i].trim();
    if(!s)continue;
    if(/^#{1,6}\s*/.test(s)){
      s=s.replace(/^#{1,6}\s*/,'');
      if(s)out.push({h:1,t:s});
      continue;
    }
    out.push({h:0,t:s.replace(/^[-*•·]\s*/,'')});
  }
  return out;
}

/* 按钮忙碌态：转圈 loading + 文案切换，任何失败都要能回到可点状态。
   更新过程中「稍后」也一起锁住 —— 关掉弹窗只会让人看不到进度。 */
function setUpBusy(on,label){
  var btn=$('#upNow'),txt=$('#upNowTxt'),later=$('#upLater'),box=$('.up-box');
  if(!btn)return;
  btn.disabled=!!on;
  if(later)later.disabled=!!on;
  if(box){if(on)box.classList.add('busy');else box.classList.remove('busy');}
  if(on)btn.classList.add('loading');else btn.classList.remove('loading');
  if(txt)txt.textContent=label||(on?'正在更新…':'下载并更新');
}

function openUpdate(info){
  upInfo=info||{};
  var bg=$('#updateBg');
  if(!bg)return;
  $('#upVer').textContent=upInfo.version||'—';
  $('#upDate').textContent=upInfo.publishedAt||'';
  var ul=$('#upNotes');
  ul.innerHTML='';
  var items=parseNotes(upInfo.notes||'');
  if(!items.length)items=[{h:0,t:'这次更新没有写说明。'}];
  for(var i=0;i<items.length;i++){
    var li=document.createElement('li');
    if(items[i].h)li.className='up-h';
    li.textContent=items[i].t;
    ul.appendChild(li);
  }
  $('#upBar').style.width='0%';
  $('#upTip').textContent='';
  setUpBusy(false);
  bg.classList.add('on');
}
function closeUpdate(){var bg=$('#updateBg');if(bg)bg.classList.remove('on');}
function renderUpProgress(p){
  if(!p)return;
  var bar=$('#upBar'),tip=$('#upTip'),pct=0,txt='';
  if(p.phase==='download'){
    pct=p.size?Math.round((p.loaded||0)/p.size*100):0;
    txt='正在下载 '+pct+'%'+(p.size?('（'+fmtMB(p.loaded||0)+' / '+fmtMB(p.size)+'）'):'');
    setUpBusy(true,'更新中 '+pct+'%');
  }else if(p.phase==='unzip'){
    pct=100;txt='正在解压覆盖旧版本…';setUpBusy(true,'解压中…');
  }else if(p.phase==='restart'){
    pct=100;txt='装好了，正在重启…';setUpBusy(true,'重启中…');
  }
  if(tip)tip.textContent=txt;
  if(bar)bar.style.width=pct+'%';
}
var upLater=$('#upLater'),upNow=$('#upNow'),setUpdateBtn=$('#setUpdate');
if(upLater)upLater.addEventListener('click',closeUpdate);
if($('#updateBg'))$('#updateBg').addEventListener('click',function(e){
  if(e.target===this&&!($('#upNow')&&$('#upNow').classList.contains('loading')))closeUpdate();
});
if(upNow)upNow.addEventListener('click',function(){
  if(!api||!api.startUpdate){toast('这个功能只在桌面客户端里可用');return;}
  if(upNow.classList.contains('loading'))return;
  setUpBusy(true,'准备下载…');
  if($('#upBar'))$('#upBar').style.width='0%';
  if($('#upTip'))$('#upTip').textContent='正在连接更新服务器…';
  api.startUpdate().then(function(r){
    if(r&&r.ok===false){
      setUpBusy(false,'重试');
      if($('#upTip'))$('#upTip').textContent='更新失败：'+(r.error||'网络不通，稍后再试');
    }else if($('#upTip')){
      $('#upTip').textContent='装好了，正在重启…';
      setUpBusy(true,'重启中…');
    }
  }).catch(function(){
    setUpBusy(false,'重试');
    if($('#upTip'))$('#upTip').textContent='更新失败，可能是网络问题';
  });
});
if(api&&api.onUpdateProgress)api.onUpdateProgress(renderUpProgress);
if(api&&api.onUpdateAvailable)api.onUpdateAvailable(function(info){openUpdate(info);});
if(setUpdateBtn)setUpdateBtn.addEventListener('click',function(){
  if(!api||!api.checkUpdate){toast('这个功能只在桌面客户端里可用');return;}
  setUpdateBtn.disabled=true;setUpdateBtn.textContent='开团中';
  api.checkUpdate().then(function(r){
    setUpdateBtn.disabled=false;setUpdateBtn.textContent='开团';
    if(!r||r.ok===false){toast('连不上更新服务器，待会儿再试');return;}
    if(r.hasUpdate){openUpdate(r.info||{version:r.latest});}
    else toast('已经是最新的 '+r.current+' 啦 🏀');
  }).catch(function(){
    setUpdateBtn.disabled=false;setUpdateBtn.textContent='开团';
    toast('连不上更新服务器，待会儿再试');
  });
});

/* 弹窗性能：打开时暂停背景常驻循环动效（hero 图标 / 拍球 / 顶栏标签）。
   4 个 overlay（modal/confirm/settings/update）各自开关，用 MutationObserver 统一同步
   body.modal-open，避免在每个 open/close 处重复写同一段逻辑；只监听 class 属性且只处理
   .modal-bg 自身，成本可忽略。 */
(function(){
  function sync(){document.body.classList.toggle('modal-open',!!document.querySelector('.modal-bg.on'));}
  try{
    var mo=new MutationObserver(function(recs){
      for(var i=0;i<recs.length;i++){
        if(recs[i].target.classList&&recs[i].target.classList.contains('modal-bg')){sync();return;}
      }
    });
    mo.observe(document.body,{subtree:true,attributes:true,attributeFilter:['class']});
  }catch(e){}
  sync();
})();
