/* 中国法定节假日 + 调休上班日（离线内置，不联网）
   数据来源：国务院办公厅《关于 20XX 年部分节假日安排的通知》，原文见 gov.cn。
   每年 11 月上旬发布次年安排 —— 届时只需在 DATA 里按同样格式补一组，不必改任何渲染代码。
   未收录的年份不会报错：日历按平时规则只分周末，不显示「休 / 班」标记。

   结构：{ 年份: [ {n:节日名, rest:[起始 'MM-DD', 结束 'MM-DD'], work:['MM-DD', ...]} ] }
   rest 区间含首尾；work 是调休补班的周六/周日（当天要上班）。 */
(function(){
  var DATA = {
    2026: [
      {n:'元旦',   rest:['01-01','01-03'], work:['01-04']},
      {n:'春节',   rest:['02-15','02-23'], work:['02-14','02-28']},
      {n:'清明节', rest:['04-04','04-06']},
      {n:'劳动节', rest:['05-01','05-05'], work:['05-09']},
      {n:'端午节', rest:['06-19','06-21']},
      {n:'中秋节', rest:['09-25','09-27']},
      {n:'国庆节', rest:['10-01','10-07'], work:['09-20','10-10']}
    ],
    2027: [
      {n:'元旦',   rest:['01-01','01-03']},
      {n:'春节',   rest:['02-05','02-13'], work:['01-31','02-14']},
      {n:'清明节', rest:['04-03','04-05']},
      {n:'劳动节', rest:['05-01','05-05'], work:['05-08']},
      {n:'端午节', rest:['06-09','06-09']},
      {n:'中秋节', rest:['09-15','09-15']},
      {n:'国庆节', rest:['10-01','10-07'], work:['09-26','10-09']}
    ]
  };

  function pad(n){return (n<10?'0':'')+n;}
  function key(y,m,d){return y+'.'+pad(m)+'.'+pad(d);}

  /* 把「区间」摊成逐日表：key 跟 dayKey()/planDays 一套写法（2026.09.25），
     value 记住这天是放假还是补班、属于哪个节日（给 title 用）。 */
  var MAP = {};
  Object.keys(DATA).forEach(function(y){
    DATA[y].forEach(function(it){
      var a = it.rest[0].split('-'), b = it.rest[1].split('-');
      var d = new Date(+y, +a[0]-1, +a[1]);
      var end = new Date(+y, +b[0]-1, +b[1]);
      while(d <= end){
        MAP[key(d.getFullYear(), d.getMonth()+1, d.getDate())] = {k:'rest', n:it.n};
        d.setDate(d.getDate()+1);
      }
      (it.work||[]).forEach(function(w){
        var p = w.split('-');
        MAP[key(+y, +p[0], +p[1])] = {k:'work', n:it.n};
      });
    });
  });

  window.CN_HOLI  = {map: MAP, years: Object.keys(DATA), updated: '2026-11-05'};
  window.cnHoliday = function(d){
    if(!d) return null;
    return MAP[key(d.getFullYear(), d.getMonth()+1, d.getDate())] || null;
  };
})();
