/* ============================================================
   轻账 · Ledger — 应用逻辑
   数据：assets/data.js（由 2025/2026 账单.xlsx 抽取并核对）
   图表：本地 echarts 5.5.1，无网络依赖
   存储：localStorage 保存新增 / 修改 / 删除，不改动源文件
   ============================================================ */
(function () {
  'use strict';

  /* ---------------- 常量 ---------------- */
  var SEED = (window.BILL_DATA && Array.isArray(window.BILL_DATA.records)) ? window.BILL_DATA.records : [];
  var STORE_KEY = 'qingzhang.ledger.v1';
  var THEME_KEY = 'qingzhang.theme.v1';
  /* 数据里实际出现过的年份，升序。年度分析、对比图、消费日历都从这三个数里取，
     以后再加账单文件不需要动任何渲染代码 */
  var YEARS = (function () {
    var m = {};
    SEED.forEach(function (r) {
      var y = Number(String(r.date || '').slice(0, 4));
      if (y > 1900) m[y] = true;
    });
    return Object.keys(m).map(Number).sort(function (a, b) { return a - b; });
  })();
  var Y_FIRST = YEARS[0] || 2026;
  var Y_LAST = YEARS[YEARS.length - 1] || 2026;
  var Y_PREV = YEARS.length > 1 ? YEARS[YEARS.length - 2] : Y_LAST - 1;
  var EXPENSE_CATS = ['餐饮', '日常', '交通', '服饰', '娱乐'];
  var INCOME_CATS = ['收入'];
  var ALL_CATS = EXPENSE_CATS.concat(INCOME_CATS);
  /* 旧账里的分类名：居住 → 日常，其它 → 娱乐。归一在 normalize() 里做，
     源账单与 localStorage 里的历史记录都跟着走 */
  var CAT_RENAME = { '居住': '日常', '其它': '娱乐' };
  var WEEKDAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
  var WEEK_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  var MONTH_CN = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'];
  var hasEcharts = (typeof window.echarts !== 'undefined');
  /* 图表重绘模式：'animate' 首次入场有生长动画，'instant' 主题切换时原地换色不重放动画 */
  var RENDER_MODE = 'animate';

  /* 名称归并：同一件事的多种写法收敛到一个词条，
     日历、排行、搜索、聚合全部按归并后的名字走 */
  var NOTE_ALIAS = {
    '晚饭': '晚餐', '夜饭': '晚餐',
    '午饭': '午餐', '中饭': '午餐',
    '早饭': '早餐', '早点': '早餐',
    '宵夜': '夜宵',
    '电话费': '话费', '手机费': '话费', '通信费': '话费',
    '小象超市': '超市', '盒马超市': '超市', '便利店': '超市',
    '市场': '菜市场', '买菜': '菜市场',
    '单车': '共享单车', '骑行卡': '共享单车', '骑车': '共享单车',
    '火车': '火车票', '抢票': '火车票', '高铁票': '火车票', '动车': '火车票',
    '水费': '水电费', '电费': '水电费', '天然气': '燃气',
    '房费': '房租', '租金': '房租',
    '住宿': '酒店', '民宿': '酒店',
    '可口可乐': '可乐',
    '汽水': '饮料', '冰红茶': '饮料', '绿茶': '饮料', '果汁': '饮料', '柠檬水': '饮料',
    '牛筋丸': '丸子', '鱼丸': '丸子', '牛丸': '丸子', '牛肉筋': '丸子',
    '面料包': '料包',
    '短袖退款': '短袖',
    '网盘会员': '会员', '迅雷会员': '会员', 'VPN': '会员', 'TG账号': '会员',
    'icloud': 'iCloud',
    '发红包': '红包', '妈妈生日': '生日',
    '二建教材': '教材', '魔方书籍': '书籍'
  };

  /* 二级分类：一级分类下的语义细分。
     顺序即优先级——先列的子类先抢关键词，所以具体词在上、泛指词在下 */
  var SUBCATS = {
    '餐饮': [
      { name: '三餐', keys: ['早餐', '午餐', '晚餐', '夜宵', '包子', '馅饼', '面条', '热干面', '葱油饼', '炸鸡', '烧鸡', '鸡肉卷', 'KFC', '麦当劳', '饿了么', '美团', '火锅', '汤圆', '饺子', '牛排', '腊肠', '培根', '牛板筋', '豆腐', '玉米', '燕麦', '外卖', '快餐'] },
      { name: '零食', keys: ['零食', '薯片', '锅巴', '辣条', '干脆面', '饼干', '泡芙', '沙琪玛', '华夫饼', '牛角包', '面包', '面饼', '口香糖', '巧克力', '果冻', '坚果', '蟹棒', '鱼豆腐', '素肉', '手撕'] },
      { name: '饮料', keys: ['饮料', '可乐', '汽水', '奶茶', '咖啡', '牛奶', '果汁', '柠檬水', '冰红茶', '绿茶', '乌龙茶', '蜂蜜茶', '柠檬茶', '气泡水', '苏打水', '葡萄糖水', '菠萝啤', '格瓦斯', '奶啤', '啤酒', '酸奶', '西梅饮', '果茶', 'DHA', '水'] },
      { name: '水果', keys: ['水果', '桃子', '苹果', '香蕉', '西瓜', '橙', '葡萄', '梨', '草莓', '蓝莓', '西梅'] },
      { name: '超市', keys: ['超市', '菜市场', '买菜', '购物', '调料', '酱', '蘸料', '香油', '花生油', '核桃油', '白砂糖', '可可粉', '碱水面', '脱水', '底料', '料包', '鸡蛋', '面粉'] },
      { name: '其它', keys: [] }
    ],
    '日常': [
      { name: '房租', keys: ['房租', '物业'] },
      { name: '水电费', keys: ['水电费', '水费', '电费', '燃气', '煤气', '取暖', '采暖', '宽带', '网费', '物业费'] },
      { name: '酒店', keys: ['酒店'] },
      { name: '电子产品', keys: ['手机壳', '数据线', '电池', '鼠标垫', '手写笔', '平板', '显示器', '键盘', '鼠标', '充电', '耳机', '摄像', '补光灯', '镜头', '硬盘', '内存', '主板', '机箱', '电源', '散热', '固态', '钢化膜', '保护壳', '手柄', '连接线'] },
      { name: '家居百货', keys: ['抽纸', '卷纸', '纸巾', '毛巾', '洗衣液', '洗衣粉', '洁厕', '泡沫剂', '百洁布', '垃圾袋', '收纳', '衣架', '锅', '勺', '剪刀', '刀', '老虎钳', '指甲刀', '手套', '雨衣', '伞', '床单', '枕', '被', '床垫', '地毯', '垫', '马桶', '地漏', '填缝剂', '防油贴纸', '墙布', '除湿', '湿巾', '洗手液', '沐浴露', '洗发水', '洗面奶', '素颜霜', '面膜', '香薰', '喷雾', '口罩', '创可贴', '褪黑素', '打气筒', '胶水', '夹子', '瓶子', '盒子', '花盆', '花土', '花籽', '种子', '绿萝', '龟背竹', '君子兰', '文竹', '九里香', '鞋套', '鞋垫', '行李箱', '笔', '尺'] },
      { name: '其它', keys: [] }
    ],
    '交通': [
      { name: '地铁', keys: ['地铁', '公交', '轨道'] },
      { name: '共享单车', keys: ['共享单车'] },
      { name: '火车票', keys: ['火车票'] },
      { name: '其它', keys: [] }
    ],
    '服饰': [
      { name: '衣服', keys: ['短袖', 'T恤', '卫衣', '衬衫', '夹克', '外套', '冲锋衣', '防晒服', '雨披', '内裤', '袜', '帽', '围巾', '腰带', '背包', '吊坠', '挂件'] },
      { name: '裤子', keys: ['裤子', '短裤', '裙'] },
      { name: '鞋', keys: ['鞋', '靴'] },
      { name: '床上用品', keys: ['床单', '枕', '被', '床垫', '毛毯', '毯', '凉席', '四件套'] },
      { name: '其它', keys: [] }
    ],
    '娱乐': [
      { name: '订阅服务', keys: ['iCloud', '会员', '网盘', '迅雷', '订阅'] },
      { name: '话费', keys: ['话费', '短信费', '流量'] },
      { name: '学习', keys: ['教材', '考试报名', '资料费', '书籍', '荧光笔', '涂卡笔', '印台', '网课', '课程'] },
      { name: '比赛', keys: ['比赛', '台球', '扑克', '魔方', '魔表', '五阶', '六七阶', '天马', '威龙', '傲速', '磁铁', '补件', '俄挺', '单杠', '握力器'] },
      { name: '电子产品', keys: ['平板', 'RTX', 'I5', '主板', '内存条', '固态硬盘', '移动硬盘', '机箱', '电源', '散热', '摄像', '手写笔', '数据线', '鼠标垫', '电池', '补光灯', '显示器', '键盘', '手柄', '保护壳', '钢化膜', '连接线', '扎带', '修打印机'] },
      { name: '人情往来', keys: ['随礼', '红包', '生日', '妇女节', '母亲节', '一日捐', '人情'] },
      { name: '其它', keys: [] }
    ],
    '收入': [
      { name: '工资', keys: ['工资'] },
      { name: '津贴', keys: ['津贴', '补贴', '高温费', '过节费', '过节'] },
      { name: '绩效', keys: ['绩效', '奖金', '年终奖', '加班费', '裁判费'] },
      { name: '其它', keys: [] }
    ]
  };
  /* 子类展示顺序照他给的清单来；自动识别的优先级走 SUBCATS 的排列，两者各管一段 */
  var SUB_ORDER = {
    '日常': ['房租', '水电费', '家居百货', '酒店', '电子产品', '其它'],
    '娱乐': ['比赛', '电子产品', '订阅服务', '话费', '人情往来', '学习', '其它']
  };
  function subCatNames(cat) {
    var list = (SUBCATS[cat] || []).map(function (s) { return s.name; });
    var ord = SUB_ORDER[cat];
    if (!ord) return list;
    var out = ord.filter(function (n) { return list.indexOf(n) !== -1; });
    list.forEach(function (n) { if (out.indexOf(n) === -1) out.push(n); });
    return out;
  }
  function countSubCats() {
    var n = 0;
    ALL_CATS.forEach(function (c) { n += subCatNames(c).length; });
    return n;
  }

  /* ---------------- 状态 ---------------- */
  var state = {
    view: 'overview',
    year: 'all',
    theme: 'light',
    scale: 'month',
    calMonth: { year: 2026, month: 11 },
    anchorDate: '',
    focusDate: '',
    trendScope: 'both',
    compareMetric: 'expense',
    calendarYear: Y_LAST,
    annualScope: 'both',
    filters: { q: '', type: 'all', category: 'all', sub: 'all', weekday: 'all' },
    editingId: null,
    entryType: 'expense',
    pendingDeleteId: null,
    themeAnimating: false,
    store: { added: [], edited: {}, deleted: [] }
  };

  var charts = {};
  /* 状态每次落盘后的回调，云同步层（assets/sync.js）靠它知道"本地改了" */
  var STORE_HOOKS = [];
  var lastFocused = null;
  var lastTrendRows = [], lastBalanceRows = [], lastStackRows = [], lastTopRows = [], lastSideTrendRows = [];
  var VIEW_META = {
    overview: ['总览', '把每一笔收支，摊开来看。点击摘要卡或图表任意项可跳到日历。'],
    calendar: ['日历', '一个月的所有流水，尽在一页日历。点条目改，点空格记。'],
    analysis: ['分析', '年度总账与逐月对照，三年叠在一起看。点击图表任意项可跳到日历。']
  };

  /* ---------------- 工具 ---------------- */
  function $(id) { return document.getElementById(id); }
  function round(n) { return Math.round((Number(n) || 0) * 100) / 100; }
  function pad2(n) { return n < 10 ? '0' + n : String(n); }
  function esc(s) {
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmtYuan(n) {
    return '¥' + (Number(n) || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function fmtBig(n) { return '¥' + Math.round(Number(n) || 0).toLocaleString('zh-CN'); }
  /* 占比文案：小于 10% 留一位小数，其余取整，避免 40.04% 这种噪音 */
  function pctText(v) {
    var x = Number(v) || 0;
    return (x < 10 ? x.toFixed(1) : String(Math.round(x))) + '%';
  }
  /* 日历格子里的金额：整数不带小数，其余保留两位，尽量省横向空间 */
  function fmtChip(n) {
    var v = Number(n) || 0;
    return Number.isInteger(v) ? String(v) : v.toFixed(2);
  }
  function fmtAxis(v) {
    var a = Math.abs(v);
    if (a >= 10000) return (v / 10000).toFixed(1) + '万';
    if (a >= 1000) return (v / 1000).toFixed(1) + 'k';
    return String(Math.round(v));
  }
  function weekLabel(s) {
    var d = new Date(String(s) + 'T00:00:00');
    return isNaN(d.getTime()) ? '' : WEEK_CN[d.getDay()];
  }
  function hex2rgb(c) {
    var h = String(c || '').trim();
    if (h.charAt(0) !== '#') return null;
    h = h.slice(1);
    if (h.length === 3) h = h.split('').map(function (x) { return x + x; }).join('');
    var n = parseInt(h.slice(0, 6), 16);
    if (isNaN(n)) return null;
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  /* 同时吃 #rrggbb 与 rgb()/rgba()：分类色板里浅色以 rgb() 形式定义 */
  function parseColor(c) {
    var h = hex2rgb(c);
    if (h) return h;
    var m = /rgba?\(([^)]+)\)/.exec(String(c || ''));
    if (!m) return null;
    var p = m[1].split(',').map(function (x) { return parseFloat(x); });
    return [p[0] | 0, p[1] | 0, p[2] | 0];
  }
  function withAlpha(color, a) {
    var rgb = parseColor(color);
    return rgb ? 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',' + a + ')' : color;
  }
  function mixColor(a, b, t) {
    var A = parseColor(a), B = parseColor(b);
    if (!A || !B) return a;
    var f = Math.max(0, Math.min(1, t));
    return 'rgb(' + Math.round(A[0] + (B[0] - A[0]) * f) + ',' + Math.round(A[1] + (B[1] - A[1]) * f) + ',' + Math.round(A[2] + (B[2] - A[2]) * f) + ')';
  }
  function lum(c) {
    var r = parseColor(c) || [255, 255, 255];
    return (r[0] * .299 + r[1] * .587 + r[2] * .114) / 255;
  }
  function gradV(top, bottom) {
    return new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: top }, { offset: 1, color: bottom }]);
  }
  function gradH(left, right) {
    return new echarts.graphic.LinearGradient(0, 0, 1, 0, [{ offset: 0, color: left }, { offset: 1, color: right }]);
  }
  function debounce(fn, ms) {
    var t = null;
    return function () {
      var args = arguments, self = this;
      if (t) clearTimeout(t);
      t = setTimeout(function () { fn.apply(self, args); }, ms);
    };
  }

  /* ---------------- 主题色板（读取 CSS 变量，跟随主题） ---------------- */
  function palette() {
    var cs = getComputedStyle(document.documentElement);
    function v(n, fb) { return (cs.getPropertyValue(n) || '').trim() || fb; }
    return {
      primary: v('--primary', '#4a6cf7'),
      primary2: v('--primary-2', '#6d8bff'),
      income: v('--income', '#e04a4a'),
      expense: v('--expense', '#10a06a'),
      danger: v('--danger', '#e5484d'),
      amber: v('--amber', '#f0a52a'),
      violet: v('--violet', '#8b5cf6'),
      sky: v('--sky', '#38a9e8'),
      catFood: v('--cat-food', 'rgb(255, 213, 213)'),
      catDaily: v('--cat-daily', 'rgb(155, 194, 230)'),
      catTravel: v('--cat-travel', '#f0a52a'),
      catWear: v('--cat-wear', '#8b5cf6'),
      catFun: v('--cat-fun', 'rgb(255, 230, 153)'),
      text: v('--text', '#1a2433'),
      text2: v('--text-2', '#4b586c'),
      muted: v('--muted', '#8b97a9'),
      border: v('--border', '#e6ebf2'),
      borderStrong: v('--border-strong', '#d7dfea'),
      surface: v('--surface', '#ffffff'),
      surface2: v('--surface-2', '#f8fafd'),
      surface3: v('--surface-3', '#eef2f8'),
      font: v('--font', 'sans-serif')
    };
  }
  function catColors(p) {
    return [p.catFood, p.catDaily, p.catTravel, p.catWear, p.catFun];
  }
  function catColor(p, c) {
    if (c === '收入') return p.income;
    var i = EXPENSE_CATS.indexOf(c);
    return i >= 0 ? catColors(p)[i] : p.primary;
  }
  /* 浅色分类（餐饮食物的粉、娱乐的黄）当文字色会糊，
     派生一个同色相的深色用于金额、标题与描边 */
  /* 图表填充：粉 / 黄这类浅色直接铺在白色画布上几乎看不见，
     混一档同色相深色进去，色相不变、面积感回来 */
  function catFill(p, c) {
    return lum(c) > .78 ? mixColor(c, catInk(p, c), .38) : c;
  }
  function catInk(p, c) {
    var t = document.documentElement.getAttribute('data-theme') === 'dark';
    return t ? mixColor(c, '#ffffff', .58) : mixColor(c, p.text, .56);
  }

  /* ---------------- 数据层 ---------------- */
  function loadStore() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (!raw) return { added: [], edited: {}, deleted: [] };
      var o = JSON.parse(raw);
      return {
        added: Array.isArray(o.added) ? o.added : [],
        edited: (o.edited && typeof o.edited === 'object' && !Array.isArray(o.edited)) ? o.edited : {},
        deleted: Array.isArray(o.deleted) ? o.deleted : []
      };
    } catch (e) { return { added: [], edited: {}, deleted: [] }; }
  }
  function saveStore() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state.store)); } catch (e) { /* 隐私模式下静默 */ }
    for (var i = 0; i < STORE_HOOKS.length; i++) {
      try { STORE_HOOKS[i](); } catch (e) { /* 通知失败不能拖垮记账 */ }
    }
  }
  function canonNote(n) {
    var s = String(n || '').trim();
    if (!s) return s;
    return NOTE_ALIAS[s] || s;
  }
  /* 关键词归属：命中第一个子类的关键词即归入该子类，全不中则落「其它」 */
  function guessSub(cat, note) {
    var list = SUBCATS[cat] || [];
    var s = String(note || '');
    for (var i = 0; i < list.length; i++) {
      var item = list[i];
      if (!item.keys.length) continue;
      for (var k = 0; k < item.keys.length; k++) {
        if (s.indexOf(item.keys[k]) !== -1) return item.name;
      }
    }
    return list.length ? list[list.length - 1].name : '其它';
  }
  function subcatOf(r) { return r.sub || guessSub(r.category, r.note); }
  function normalize(r) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(r.date || ''));
    var o = {};
    for (var k in r) if (Object.prototype.hasOwnProperty.call(r, k)) o[k] = r[k];
    o.amount = round(r.amount);
    if (m) { o.year = Number(m[1]); o.month = Number(m[2]); }
    else { o.year = Number(r.year) || 0; o.month = Number(r.month) || 0; }
    o.type = r.type === 'income' ? 'income' : 'expense';
    var rawCat = String(r.category || '娱乐');
    o.category = CAT_RENAME[rawCat] || rawCat;
    o.note = canonNote(r.note) || (o.type === 'income' ? '收入' : o.category);
    /* 手选了子类就用手选的，否则按名字自动识别——旧账没有 sub 字段，自动走识别 */
    o.subExplicit = !!(r.sub && subCatNames(o.category).indexOf(r.sub) !== -1);
    o.sub = o.subExplicit ? r.sub : guessSub(o.category, o.note);
    return o;
  }
  function allRecords() {
    var del = {};
    state.store.deleted.forEach(function (id) { del[id] = true; });
    var ed = state.store.edited;
    var out = [];
    SEED.forEach(function (r) { if (!del[r.id]) out.push(normalize(ed[r.id] || r)); });
    state.store.added.forEach(function (r) { if (!del[r.id]) out.push(normalize(ed[r.id] || r)); });
    return out;
  }
  function scopeRecords() {
    if (state.year === 'all') return allRecords();
    var y = Number(state.year);
    return allRecords().filter(function (r) { return r.year === y; });
  }
  function sortedDesc(records) {
    return records.slice().sort(function (a, b) {
      if (a.date !== b.date) return a.date < b.date ? 1 : -1;
      return a.id < b.id ? 1 : -1;
    });
  }

  /* ---------------- 聚合 ---------------- */
  function buildMonthKeys(records) {
    if (!records.length) return [];
    var min = Infinity, max = -Infinity;
    records.forEach(function (r) {
      var k = r.year * 12 + r.month;
      if (k < min) min = k;
      if (k > max) max = k;
    });
    if (max - min > 120) min = max - 120;
    var keys = [];
    for (var k = min; k <= max; k++) {
      var y = Math.floor((k - 1) / 12), m = ((k - 1) % 12) + 1;
      keys.push({ key: k, year: y, month: m, label: String(y).slice(2) + '/' + pad2(m) });
    }
    return keys;
  }
  function monthlyAgg(records) {
    var map = {};
    records.forEach(function (r) {
      var k = r.year * 12 + r.month;
      if (!map[k]) map[k] = { income: 0, expense: 0, byCat: {} };
      var e = map[k];
      if (r.type === 'income') e.income += r.amount; else e.expense += r.amount;
      e.byCat[r.category] = (e.byCat[r.category] || 0) + r.amount;
    });
    return buildMonthKeys(records).map(function (k) {
      var e = map[k.key] || { income: 0, expense: 0, byCat: {} };
      return {
        key: k.key, year: k.year, month: k.month, label: k.label,
        income: round(e.income), expense: round(e.expense),
        balance: round(e.income - e.expense), byCat: e.byCat
      };
    });
  }
  function cumulative(rows) {
    var acc = 0;
    return rows.map(function (r) { acc += r.balance; return round(acc); });
  }
  function catTotals(records) {
    var map = {};
    EXPENSE_CATS.forEach(function (c) { map[c] = 0; });
    records.forEach(function (r) {
      if (r.type !== 'expense') return;
      map[r.category] = (map[r.category] || 0) + r.amount;
    });
    return EXPENSE_CATS.map(function (c) { return { name: c, value: round(map[c] || 0) }; });
  }
  function subTotals(records, cat) {
    var names = subCatNames(cat);
    var map = {};
    names.forEach(function (n) { map[n] = 0; });
    records.forEach(function (r) {
      if (r.category !== cat) return;
      map[r.sub] = (map[r.sub] || 0) + r.amount;
    });
    return names.map(function (n) { return { name: n, value: round(map[n] || 0) }; })
      .filter(function (d) { return d.value > 0; })
      .sort(function (a, b) { return b.value - a.value; });
  }
  function weekdayTotals(records) {
    var arr = [0, 0, 0, 0, 0, 0, 0];
    records.forEach(function (r) {
      if (r.type !== 'expense') return;
      var d = new Date(r.date + 'T00:00:00');
      if (isNaN(d.getTime())) return;
      arr[(d.getDay() + 6) % 7] += r.amount;
    });
    return WEEKDAYS.map(function (n, i) { return { name: n, value: round(arr[i]) }; });
  }
  function topItems(records, n) {
    var map = {}, cats = {};
    records.forEach(function (r) {
      if (r.type !== 'expense') return;
      var k = r.note || r.category;
      map[k] = (map[k] || 0) + r.amount;
      if (!cats[k]) cats[k] = r.category;
    });
    return Object.keys(map).map(function (name) { return { name: name, value: round(map[name]), category: cats[name] }; })
      .sort(function (a, b) { return b.value - a.value; }).slice(0, n);
  }
  function calendarData(year) {
    var map = {}, cnt = {};
    allRecords().forEach(function (r) {
      if (r.type !== 'expense' || r.year !== year) return;
      map[r.date] = (map[r.date] || 0) + r.amount;
      cnt[r.date] = (cnt[r.date] || 0) + 1;
    });
    return Object.keys(map).map(function (d) { return [d, round(map[d]), cnt[d] || 0]; });
  }
  function compareData(metric) {
    var a = Y_PREV, b = Y_LAST;
    var rows = [];
    for (var m = 1; m <= 12; m++) rows.push({ month: m, a: 0, b: 0 });
    allRecords().forEach(function (r) {
      if (r.year !== a && r.year !== b) return;
      if (metric === 'expense' && r.type !== 'expense') return;
      if (metric === 'income' && r.type !== 'income') return;
      var v = metric === 'balance' ? (r.type === 'income' ? r.amount : -r.amount) : r.amount;
      if (r.year === a) rows[r.month - 1].a += v; else rows[r.month - 1].b += v;
    });
    return rows.map(function (o) { return { month: o.month, a: round(o.a), b: round(o.b) }; });
  }
  function yearStats(y) {
    var recs = allRecords().filter(function (r) { return r.year === y; });
    var inc = 0, exp = 0, months = {};
    recs.forEach(function (r) {
      months[r.month] = true;
      if (r.type === 'income') inc += r.amount; else exp += r.amount;
    });
    inc = round(inc); exp = round(exp);
    var nMonths = Object.keys(months).length || 1;
    return {
      year: y, count: recs.length, months: nMonths,
      income: inc, expense: exp, balance: round(inc - exp),
      rate: inc > 0 ? (inc - exp) / inc * 100 : 0
    };
  }

  /* ---------------- 日历作用域：月 / 周 / 天 / 年 ---------------- */
  function startOfWeek(d) {
    var x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
    return x;
  }
  function anchorDate() {
    var s = state.anchorDate;
    if (s) {
      var d = new Date(s + 'T00:00:00');
      if (!isNaN(d.getTime())) return d;
    }
    return new Date(state.calMonth.year, state.calMonth.month - 1, 1);
  }
  function setAnchor(d) {
    state.anchorDate = dateKey(d);
    state.calMonth = { year: d.getFullYear(), month: d.getMonth() + 1 };
  }
  function rangeBounds() {
    var d = anchorDate();
    if (state.scale === 'day') return { from: d, to: d };
    if (state.scale === 'week') {
      var s = startOfWeek(d), e = new Date(s);
      e.setDate(e.getDate() + 6);
      return { from: s, to: e };
    }
    if (state.scale === 'year') {
      var y = state.calMonth.year;
      return { from: new Date(y, 0, 1), to: new Date(y, 11, 31) };
    }
    var cy = state.calMonth.year, cm = state.calMonth.month;
    return { from: new Date(cy, cm - 1, 1), to: new Date(cy, cm, 0) };
  }
  function rangeRecords() {
    var b = rangeBounds(), f = dateKey(b.from), t = dateKey(b.to);
    return allRecords().filter(function (r) { return r.date >= f && r.date <= t; });
  }
  /* 整月全量：月份条统计与子类笔数用 */
  function monthRecords() {
    var y = state.calMonth.year, m = state.calMonth.month;
    return allRecords().filter(function (r) { return r.year === y && r.month === m; });
  }
  function matchFilters(r) {
    var q = state.filters.q.trim().toLowerCase();
    var wd = state.filters.weekday;
    var wdNum = (wd === 'all' || wd === '') ? -1 : Number(wd);
    if (state.filters.type !== 'all' && r.type !== state.filters.type) return false;
    if (state.filters.category !== 'all' && r.category !== state.filters.category) return false;
    if (state.filters.sub !== 'all' && r.sub !== state.filters.sub) return false;
    if (wdNum >= 0) {
      var d = new Date(r.date + 'T00:00:00');
      if (isNaN(d.getTime()) || (d.getDay() + 6) % 7 !== wdNum) return false;
    }
    if (q && (r.note + ' ' + r.sub + ' ' + r.category + ' ' + r.date).toLowerCase().indexOf(q) === -1) return false;
    return true;
  }
  function boardRecords() {
    return sortedDesc(rangeRecords().filter(matchFilters));
  }
  function filtersActive() {
    var f = state.filters;
    return f.category !== 'all' || f.sub !== 'all' || f.type !== 'all' || (f.weekday !== 'all' && f.weekday !== '') || !!f.q.trim();
  }
  /* 当前筛选下命中最多（并列取最近）的年月，用于点击图表跳转后落在有数据的月份 */
  function bestMonthForFilters() {
    var counts = {}, best = null, bestN = 0;
    scopeRecords().forEach(function (r) {
      if (!matchFilters(r)) return;
      var key = r.year * 100 + r.month;
      counts[key] = (counts[key] || 0) + 1;
      var n = counts[key];
      if (n > bestN || (n === bestN && best && key > best.key)) {
        bestN = n; best = { year: r.year, month: r.month, key: key };
      }
    });
    return best;
  }
  function bestMonthOfYear(y) {
    var counts = {}, best = 12, bestN = -1;
    allRecords().forEach(function (r) {
      if (r.year !== y) return;
      counts[r.month] = (counts[r.month] || 0) + 1;
    });
    Object.keys(counts).forEach(function (m) {
      if (counts[m] > bestN) { bestN = counts[m]; best = Number(m); }
    });
    return best;
  }

  /* ---------------- ECharts 公共配置 ---------------- */
  function tooltipCommon(p, extra) {
    return Object.assign({
      backgroundColor: p.surface,
      borderColor: p.border,
      borderWidth: 1,
      padding: [10, 13],
      textStyle: { color: p.text, fontSize: 12, fontFamily: p.font },
      extraCssText: 'border-radius:10px;box-shadow:0 14px 38px -14px rgba(20,32,62,.4);'
    }, extra || {});
  }
  function catAxis(p, data, extra) {
    return Object.assign({
      type: 'category', data: data, boundaryGap: true,
      axisLine: { lineStyle: { color: p.border } }, axisTick: { show: false },
      axisLabel: { color: p.muted, fontSize: 10.5, fontFamily: p.font },
      splitLine: { show: false }
    }, extra || {});
  }
  function valAxis(p, extra) {
    return Object.assign({
      type: 'value',
      axisLine: { show: false }, axisTick: { show: false },
      axisLabel: { color: p.muted, fontSize: 10.5, fontFamily: p.font, formatter: fmtAxis },
      splitLine: { lineStyle: { color: p.border, type: 'dashed' } }
    }, extra || {});
  }
  function baseOption(p) {
    /* instant 模式下把动画时长压到 0：主题切换时原地换色，
       不会重放"虚线生长 / 柱子从零长起"那套入场动画，
       也就不会配合圆形转场出现闪烁 */
    var anim = RENDER_MODE !== 'instant';
    return {
      backgroundColor: 'transparent',
      animation: anim,
      animationDuration: anim ? 900 : 0,
      animationDurationUpdate: anim ? 560 : 0,
      animationEasing: 'cubicOut',
      animationEasingUpdate: 'cubicOut',
      textStyle: { fontFamily: p.font }
    };
  }
  function labelInterval(id, count, pxPerLabel) {
    var el = $(id);
    var w = (el && el.offsetWidth) || 900;
    var maxLabels = Math.max(3, Math.floor(w / pxPerLabel));
    return Math.max(0, Math.ceil(count / maxLabels) - 1);
  }
  function getChart(id) {
    var el = $(id);
    if (!el) return null;
    if (charts[id]) return charts[id];
    if (el.offsetWidth === 0 || el.offsetHeight === 0) return null;
    charts[id] = echarts.init(el, null, { renderer: 'canvas' });
    return charts[id];
  }
  function setOpt(id, option) {
    if (!hasEcharts) return;
    var c = getChart(id);
    if (!c) return;
    c.setOption(option, true);
    /* instant 重绘后同步刷新画布：View Transition 截「新快照」时
       canvas 位图必须已经是新配色，否则转场末尾会整片跳色 */
    if (RENDER_MODE === 'instant') {
      var zr = c.getZr && c.getZr();
      if (zr && typeof zr.refreshImmediately === 'function') zr.refreshImmediately();
    }
  }
  function resizeAll() {
    Object.keys(charts).forEach(function (id) { if (charts[id]) charts[id].resize(); });
  }
  function bindClick(id, handler) {
    if (!hasEcharts) return;
    var c = charts[id];
    if (!c) return;
    c.off('click');
    c.on('click', handler);
  }
  /* 笛卡尔类图表（含面积/堆叠，echarts 自身命中会被面积层吞掉）：
     在容器层按点击 x 像素映射到类目下标，稳定可靠。 */
  function bindAxisClick(id, onIndex) {
    var el = $(id);
    if (!el || !hasEcharts) return;
    if (el.__axisBound) return;
    el.__axisBound = true;
    el.addEventListener('click', function (e) {
      var c = charts[id];
      if (!c) return;
      var rect = el.getBoundingClientRect();
      var x = e.clientX - rect.left, y = e.clientY - rect.top;
      if (c.containPixel && !c.containPixel({ gridIndex: 0 }, [x, y])) return;
      var v = c.convertFromPixel({ xAxisIndex: 0 }, x);
      if (typeof v !== 'number' || isNaN(v)) return;
      var idx = Math.round(v);
      if (idx < 0) return;
      onIndex(idx);
    });
  }

  /* ---------------- 图表 → 日历 跳转 ---------------- */
  function syncWeekdayChip() {
    var el = $('weekdayChip');
    if (!el) return;
    var wd = state.filters.weekday;
    if (wd === 'all' || wd === '') { el.hidden = true; return; }
    el.hidden = false;
    el.innerHTML = WEEKDAYS[Number(wd)] + ' <b>×</b>';
  }
  function syncSubChip() {
    var el = $('subChip');
    if (!el) return;
    var s = state.filters.sub;
    if (s === 'all') { el.hidden = true; return; }
    el.hidden = false;
    el.innerHTML = s + ' <b>×</b>';
  }
  function syncFilterUI() {
    if ($('searchInput')) $('searchInput').value = state.filters.q;
    setSegActive($('typeSeg'), 'data-type', state.filters.type);
    syncChips();
    syncWeekdayChip();
    syncSubChip();
    syncCalLegend();
  }
  function setCalMonth(y, m) {
    state.calMonth = { year: Number(y), month: Number(m) };
    state.anchorDate = '';
    state.focusDate = '';
    renderBoard();
    renderCharts(state.view);
  }
  /* 月份条上的左右箭头：按当前粒度走一步（月 / 周 / 天 / 年） */
  function shiftCalStep(dir) {
    if (state.scale === 'year') {
      state.calMonth = { year: state.calMonth.year + dir, month: state.calMonth.month };
      state.anchorDate = '';
    } else if (state.scale === 'week' || state.scale === 'day') {
      var d = anchorDate();
      d.setDate(d.getDate() + (state.scale === 'week' ? 7 : 1) * dir);
      setAnchor(d);
    } else {
      var y = state.calMonth.year, m = state.calMonth.month + dir;
      if (m < 1) { m = 12; y -= 1; }
      else if (m > 12) { m = 1; y += 1; }
      state.calMonth = { year: y, month: m };
      state.anchorDate = '';
    }
    state.focusDate = '';
    renderBoard();
    renderCharts('calendar');
  }
  function jumpToDetail(opts) {
    opts = opts || {};
    if (opts.reset) state.filters = { q: '', type: 'all', category: 'all', sub: 'all', weekday: 'all' };
    if (opts.category !== undefined) state.filters.category = opts.category;
    if (opts.sub !== undefined) state.filters.sub = opts.sub;
    if (opts.type !== undefined) state.filters.type = opts.type;
    if (opts.weekday !== undefined) state.filters.weekday = opts.weekday;
    if (opts.q !== undefined) state.filters.q = opts.q;
    /* 图表点进来默认看月：跳转要一眼看到整段时间，细粒度留给用户自己切 */
    state.scale = opts.scale || 'month';
    if (opts.year !== undefined && opts.month !== undefined) {
      state.calMonth = { year: Number(opts.year), month: Number(opts.month) };
      state.anchorDate = '';
    }
    state.focusDate = opts.date || '';
    if (opts.date) {
      var m = /^(\d{4})-(\d{2})-\d{2}$/.exec(opts.date);
      if (m) {
        state.calMonth = { year: Number(m[1]), month: Number(m[2]) };
        state.anchorDate = opts.date;
      }
    }
    // 仅按分类/关键词/周几跳转时，落到命中最多（并列取最近）的月份，
    // 避免当前月没有该类数据导致日历一片空白
    var explicitTime = (opts.year !== undefined && opts.month !== undefined) || !!opts.date;
    if (!explicitTime && filtersActive()) {
      var curHas = monthRecords().some(matchFilters);
      if (!curHas) {
        var bm = bestMonthForFilters();
        if (bm) { state.calMonth = { year: bm.year, month: bm.month }; state.anchorDate = ''; }
      }
    }
    syncFilterUI();
    setSegActive($('scaleSeg'), 'data-scale', state.scale);
    if (state.view !== 'calendar') setView('calendar');
    renderBoard();
    renderCharts('calendar');
    var label = opts.label || (opts.sub && opts.sub !== 'all' ? '已筛选：' + opts.sub :
      opts.category && opts.category !== 'all' ? '已筛选：' + opts.category :
        opts.q ? '已搜索：' + opts.q :
          opts.date ? '已定位：' + opts.date :
            (opts.year !== undefined ? '已跳转：' + opts.year + '年' + opts.month + '月' : '已跳转日历'));
    toast(label, 'info');
  }
  /* 单日直达：分析页热力图 / 月视图「还有 N 笔」都走这里 */
  function jumpToDay(key) {
    var m = /^(\d{4})-(\d{2})/.exec(key);
    if (!m) return;
    state.scale = 'day';
    state.calMonth = { year: Number(m[1]), month: Number(m[2]) };
    state.anchorDate = key;
    state.focusDate = key;
    setSegActive($('scaleSeg'), 'data-scale', 'day');
    if (state.view !== 'calendar') setView('calendar');
    renderBoard();
    renderCharts('calendar');
    toast('已定位：' + key, 'info');
  }
  function gotoMonth(y, m) {
    state.scale = 'month';
    state.calMonth = { year: Number(y), month: Number(m) };
    state.anchorDate = '';
    state.focusDate = '';
    setSegActive($('scaleSeg'), 'data-scale', 'month');
    renderBoard();
    renderCharts('calendar');
  }
  /* 「记一笔」默认日期：跟着当前粒度走，天→当天、周→本周内、月/年→本月内 */
  function defaultAddDate() {
    var t = new Date();
    if (state.scale === 'day') return dateKey(anchorDate());
    if (state.scale === 'week') {
      var b = rangeBounds();
      return (t >= b.from && t <= b.to) ? dateKey(t) : dateKey(b.from);
    }
    var same = t.getFullYear() === state.calMonth.year && t.getMonth() + 1 === state.calMonth.month;
    return same ? dateKey(t) : dateKey(new Date(state.calMonth.year, state.calMonth.month - 1, 1));
  }
  function setScale(s) {
    state.scale = s;
    if (s === 'day' || s === 'week') {
      if (!state.anchorDate) {
        var t = new Date();
        var sameMonth = t.getFullYear() === state.calMonth.year && t.getMonth() + 1 === state.calMonth.month;
        setAnchor(sameMonth ? t : new Date(state.calMonth.year, state.calMonth.month - 1, 1));
      }
    } else {
      var d = anchorDate();
      state.calMonth = { year: d.getFullYear(), month: d.getMonth() + 1 };
    }
    state.focusDate = '';
    setSegActive($('scaleSeg'), 'data-scale', s);
    renderBoard();
    renderCharts('calendar');
  }
  function jumpMonthFromRow(row) {
    if (row) jumpToDetail({ reset: true, year: row.year, month: row.month });
  }

  /* ---------------- 图表：总览 ---------------- */
  function renderTrend(p) {
    var rows = monthlyAgg(scopeRecords());
    var labels = rows.map(function (r) { return r.label; });
    var series = [];
    if (state.trendScope !== 'income') {
      series.push({
        name: '支出', type: 'bar', barMaxWidth: 20, z: 2,
        data: rows.map(function (r) { return r.expense; }),
        itemStyle: { borderRadius: [5, 5, 0, 0], color: gradV(withAlpha(p.expense, .88), withAlpha(p.expense, .14)) },
        emphasis: { itemStyle: { color: p.expense } },
        animationDelay: function (i) { return i * 20; }
      });
    }
    if (state.trendScope !== 'expense') {
      series.push({
        name: '收入', type: 'line', smooth: .34, symbol: 'circle', symbolSize: 6,
        showSymbol: rows.length <= 14, z: 3,
        data: rows.map(function (r) { return r.income; }),
        lineStyle: { width: 2.6, color: p.income },
        itemStyle: { color: p.income, borderColor: p.surface, borderWidth: 2 },
        areaStyle: { color: gradV(withAlpha(p.income, .26), withAlpha(p.income, 0)) },
        emphasis: { focus: 'series' }
      });
    }
    var o = baseOption(p);
    o.color = [p.expense, p.income];
    o.grid = { left: 6, right: 12, top: 40, bottom: 6, containLabel: true };
    o.legend = { top: 2, right: 2, itemWidth: 10, itemHeight: 10, itemGap: 16, icon: 'roundRect', textStyle: { color: p.text2, fontSize: 11.5, fontFamily: p.font } };
    o.tooltip = tooltipCommon(p, {
      trigger: 'axis',
      axisPointer: { type: 'shadow', shadowStyle: { color: withAlpha(p.muted, .09) } },
      valueFormatter: function (v) { return fmtYuan(v); }
    });
    o.xAxis = catAxis(p, labels, {
      boundaryGap: state.trendScope !== 'income',
      axisLabel: { color: p.muted, fontSize: 10.5, fontFamily: p.font, interval: labelInterval('chartTrend', labels.length, 70) }
    });
    o.yAxis = valAxis(p);
    o.dataZoom = rows.length > 14 ? [{ type: 'inside', zoomOnMouseWheel: 'ctrl', moveOnMouseMove: true, moveOnMouseWheel: false }] : [];
    o.series = series;
    setOpt('chartTrend', o);
    lastTrendRows = rows;
    bindAxisClick('chartTrend', function (idx) { jumpMonthFromRow(lastTrendRows[idx]); });
  }

  /* 支出构成：图例上墙，用引线连到扇区，不再另起一段下方图例 */
  function renderDonut(p) {
    var data = catTotals(scopeRecords()).filter(function (d) { return d.value > 0; });
    var total = data.reduce(function (s, d) { return s + d.value; }, 0);
    var colors = catColors(p);
    var nameIndex = {};
    EXPENSE_CATS.forEach(function (c, i) { nameIndex[c] = i; });
    var o = baseOption(p);
    o.color = colors;
    o.tooltip = tooltipCommon(p, {
      trigger: 'item',
      formatter: function (d) { return d.marker + d.name + '<br/><b>' + fmtYuan(d.value) + '</b> · ' + d.percent + '%'; }
    });
    o.graphic = [
      { type: 'text', left: 'center', top: '46%', style: { text: fmtBig(total), fill: p.text, font: '700 21px ' + p.font, textAlign: 'center' } },
      { type: 'text', left: 'center', top: '59%', style: { text: '总支出', fill: p.muted, font: '500 11px ' + p.font, textAlign: 'center' } }
    ];
    o.series = [{
      type: 'pie', radius: ['46%', '68%'], center: ['50%', '52%'],
      avoidLabelOverlap: true, minAngle: 4,
      itemStyle: { borderColor: p.surface, borderWidth: 3, borderRadius: 6 },
      label: {
        show: true, position: 'outside',
        formatter: function (d) { return d.name + '  {p|' + pctText(d.percent) + '}'; },
        color: p.text2, fontSize: 11.5, fontFamily: p.font, fontWeight: 600,
        rich: { p: { color: p.muted, fontSize: 10.5, fontWeight: 500 } }
      },
      labelLine: { show: true, length: 11, length2: 14, smooth: true, lineStyle: { color: p.borderStrong, width: 1 } },
      labelLayout: { hideOverlap: true },
      emphasis: {
        scale: true, scaleSize: 6,
        itemStyle: { shadowBlur: 20, shadowColor: withAlpha(p.primary, .3) },
        label: { fontWeight: 700, color: p.text }
      },
      data: data.map(function (d) { return { name: d.name, value: d.value, itemStyle: { color: colors[nameIndex[d.name]] || p.primary } }; })
    }];
    setOpt('chartDonut', o);
    bindClick('chartDonut', function (params) { if (params.name) jumpToDetail({ reset: true, category: params.name }); });
  }

  /* 分类排行：从总览搬到分析页，作为年度结论的一部分 */
  function renderRank(p) {
    var data = catTotals(scopeRecords()).sort(function (a, b) { return b.value - a.value; });
    var colors = catColors(p);
    var nameIndex = {};
    EXPENSE_CATS.forEach(function (c, i) { nameIndex[c] = i; });
    var o = baseOption(p);
    o.grid = { left: 6, right: 70, top: 10, bottom: 6, containLabel: true };
    o.tooltip = tooltipCommon(p, { trigger: 'item', formatter: function (d) { return d.name + ' · <b>' + fmtYuan(d.value) + '</b>'; } });
    o.xAxis = valAxis(p, { axisLabel: { show: false }, splitLine: { show: false } });
    o.yAxis = catAxis(p, data.map(function (d) { return d.name; }), {
      inverse: true, axisLine: { show: false },
      axisLabel: { color: p.text2, fontSize: 12, fontWeight: 600, fontFamily: p.font }
    });
    o.series = [{
      type: 'bar', barWidth: 15,
      data: data.map(function (d) {
        var c = catFill(p, colors[nameIndex[d.name]] || p.primary);
        return { value: d.value, itemStyle: { color: gradH(withAlpha(c, .42), c), borderRadius: [0, 6, 6, 0] } };
      }),
      label: { show: true, position: 'right', distance: 8, formatter: function (d) { return fmtYuan(d.value); }, color: p.text2, fontSize: 11, fontFamily: p.font },
      emphasis: { itemStyle: { shadowBlur: 12, shadowColor: withAlpha(p.primary, .25) } }
    }];
    setOpt('chartRank', o);
    bindClick('chartRank', function (params) { if (params.name) jumpToDetail({ reset: true, category: params.name }); });
  }

  /* 结余变化：月度净额柱 + 累计结余曲线（双轴），一图看流速与存量 */
  function renderBalance(p) {
    var rows = monthlyAgg(scopeRecords());
    var cum = cumulative(rows);
    var labels = rows.map(function (r) { return r.label; });
    var o = baseOption(p);
    o.color = [p.primary, p.income];
    o.grid = { left: 6, right: 52, top: 42, bottom: 6, containLabel: true };
    o.legend = {
      top: 2, right: 2, itemWidth: 10, itemHeight: 10, itemGap: 16, icon: 'roundRect',
      textStyle: { color: p.text2, fontSize: 11.5, fontFamily: p.font },
      data: [
        { name: '月度净额', itemStyle: { color: p.income } },
        { name: '累计结余', itemStyle: { color: p.primary } }
      ]
    };
    o.tooltip = tooltipCommon(p, {
      trigger: 'axis',
      axisPointer: { type: 'shadow', shadowStyle: { color: withAlpha(p.muted, .09) } },
      valueFormatter: function (v) { return fmtYuan(v); }
    });
    o.xAxis = catAxis(p, labels, { axisLabel: { color: p.muted, fontSize: 10.5, fontFamily: p.font, interval: labelInterval('chartBalance', labels.length, 62) } });
    o.yAxis = [
      valAxis(p),
      valAxis(p, { splitLine: { show: false }, axisLabel: { show: false }, axisLine: { show: false } })
    ];
    o.series = [
      {
        name: '月度净额', type: 'bar', barMaxWidth: 16, yAxisIndex: 0,
        data: rows.map(function (r) {
          var pos = r.balance >= 0;
          return {
            value: r.balance,
            itemStyle: {
              color: pos ? gradV(withAlpha(p.income, .9), withAlpha(p.income, .18)) : gradV(withAlpha(p.expense, .9), withAlpha(p.expense, .18)),
              borderRadius: pos ? [4, 4, 0, 0] : [0, 0, 4, 4]
            }
          };
        }),
        emphasis: { itemStyle: { shadowBlur: 10, shadowColor: withAlpha(p.primary, .28) } }
      },
      {
        name: '累计结余', type: 'line', smooth: .38, symbol: 'circle', symbolSize: 5,
        showSymbol: rows.length <= 14, yAxisIndex: 1, z: 5,
        data: cum,
        lineStyle: { width: 2.8, color: p.primary, shadowBlur: 14, shadowColor: withAlpha(p.primary, .38), shadowOffsetY: 6 },
        itemStyle: { color: p.primary, borderColor: p.surface, borderWidth: 2 },
        areaStyle: { color: gradV(withAlpha(p.primary, .22), withAlpha(p.primary, 0)) },
        markLine: {
          silent: true, symbol: 'none',
          lineStyle: { color: p.borderStrong, type: 'dashed', width: 1 },
          label: { show: false }, data: [{ yAxis: 0 }]
        },
        endLabel: {
          show: true, distance: 6,
          formatter: function (d) { return fmtBig(d.value); },
          color: p.primary, fontSize: 10.5, fontWeight: 700, fontFamily: p.font
        }
      }
    ];
    setOpt('chartBalance', o);
    lastBalanceRows = rows;
    bindAxisClick('chartBalance', function (idx) { jumpMonthFromRow(lastBalanceRows[idx]); });
  }

  /* ---------------- 图表：分析 ---------------- */
  function renderCompare(p) {
    var d = compareData(state.compareMetric);
    var labels = d.map(function (x) { return x.month + '月'; });
    var o = baseOption(p);
    o.color = [p.primary, p.amber];
    o.grid = { left: 6, right: 12, top: 40, bottom: 6, containLabel: true };
    o.legend = { top: 2, right: 2, itemWidth: 10, itemHeight: 10, itemGap: 16, icon: 'roundRect', textStyle: { color: p.text2, fontSize: 11.5, fontFamily: p.font } };
    o.tooltip = tooltipCommon(p, { trigger: 'axis', axisPointer: { type: 'shadow', shadowStyle: { color: withAlpha(p.muted, .09) } }, valueFormatter: function (v) { return fmtYuan(v); } });
    o.xAxis = catAxis(p, labels);
    o.yAxis = valAxis(p);
    o.series = [
      { name: String(Y_PREV), type: 'bar', barMaxWidth: 15, data: d.map(function (x) { return x.a; }), itemStyle: { borderRadius: [4, 4, 0, 0], color: gradV(withAlpha(p.primary, .9), withAlpha(p.primary, .22)) }, emphasis: { itemStyle: { color: p.primary } } },
      { name: String(Y_LAST), type: 'bar', barMaxWidth: 15, data: d.map(function (x) { return x.b; }), itemStyle: { borderRadius: [4, 4, 0, 0], color: gradV(withAlpha(p.amber, .9), withAlpha(p.amber, .22)) }, emphasis: { itemStyle: { color: p.amber } } }
    ];
    setOpt('chartCompare', o);
    bindAxisClick('chartCompare', function (idx) {
      var y = state.year === 'all' ? Y_LAST : Number(state.year);
      jumpToDetail({ reset: true, year: y, month: idx + 1 });
    });
    var sub = $('compareSub');
    if (sub) sub.textContent = Y_PREV + ' 与 ' + Y_LAST + ' 逐月对照 · ' + ({ expense: '支出', income: '收入', balance: '结余' })[state.compareMetric];
  }

  /* 消费日历 = 日历热力图（calendar 坐标系 + heatmap 系列）。
     优化点：按分位数定色阶（大额不冲淡整图）、空白日给淡底让格网成形、
     四档渐变、提示气泡带笔数、点击直达当日。 */
  function renderCalendar(p) {
    var y = state.calendarYear;
    var data = calendarData(y);
    var vals = data.map(function (d) { return d[1]; }).sort(function (a, b) { return a - b; });
    /* 线性色阶在这份数据上会失效：日均几十、峰值上千，绝大多数格子挤在最低档。
       改成按分位排名着色——颜色的深浅表达"在这年里有多贵"，绝对值交给气泡。 */
    function rankPct(v) {
      if (!vals.length) return 100;
      var lo = 0, hi = vals.length - 1;
      while (lo < hi) {
        var mid = (lo + hi) >> 1;
        if (vals[mid] < v) lo = mid + 1; else hi = mid;
      }
      return vals.length > 1 ? Math.max(8, lo / (vals.length - 1) * 100) : 100;
    }
    var ranked = data.map(function (d) { return [d[0], rankPct(d[1]), d[1], d[2]]; });
    var total = data.reduce(function (s, d) { return s + d[1]; }, 0);
    var peak = data.reduce(function (m, d) { return d[1] > m[1] ? d : m; }, ['—', 0]);

    var o = baseOption(p);
    o.tooltip = tooltipCommon(p, {
      trigger: 'item',
      formatter: function (d) {
        if (!d.data) return '';
        var cnt = d.data[3] || 0;
        return '<b>' + d.data[0] + '</b><br/>支出 <b>' + fmtYuan(d.data[2]) + '</b>' + (cnt ? ' · ' + cnt + ' 笔' : '');
      }
    });
    o.visualMap = {
      /* dimension: 1 = 取 [日期, 排名] 里的排名维度。
         不写的话 ECharts 默认取末维（笔数），整张图会被笔数染色 */
      dimension: 1,
      min: 0, max: 100, calculable: false, orient: 'horizontal',
      left: 'center', bottom: 0, itemWidth: 11, itemHeight: 130,
      text: ['贵', '省'], textGap: 8,
      textStyle: { color: p.muted, fontSize: 10, fontFamily: p.font },
      inRange: {
        color: [
          mixColor(p.surface3, p.surface, .3),
          mixColor(p.expense, p.surface, .74),
          mixColor(p.expense, p.surface, .44),
          p.expense
        ]
      }
    };
    o.calendar = {
      top: 38, left: 46, right: 24, bottom: 34, cellSize: ['auto', 13], range: String(y),
      itemStyle: { color: mixColor(p.surface, p.border, .55), borderColor: p.surface, borderWidth: 1.5, borderRadius: 3 },
      yearLabel: { show: false },
      monthLabel: { color: p.text2, fontSize: 10.5, fontWeight: 600, fontFamily: p.font, nameMap: 'cn', margin: 8 },
      dayLabel: { color: p.muted, fontSize: 9.5, fontFamily: p.font, firstDay: 1, nameMap: ['日', '一', '二', '三', '四', '五', '六'] },
      splitLine: { show: false }
    };
    o.series = [{
      type: 'heatmap', coordinateSystem: 'calendar', data: ranked,
      itemStyle: { borderColor: p.surface, borderWidth: 1.5, borderRadius: 3 },
      emphasis: { itemStyle: { borderColor: p.text, borderWidth: 1.5, shadowBlur: 12, shadowColor: withAlpha(p.expense, .45) } }
    }];
    setOpt('chartCalendar', o);
    bindClick('chartCalendar', function (params) {
      if (params.data && params.data[0]) jumpToDay(params.data[0]);
    });
    var sub = $('calendarSub');
    if (sub) {
      sub.textContent = y + ' 年 · 合计 ' + fmtBig(total) + ' · 最高单日 ' + fmtBig(peak[1]) +
        (peak[0] !== '—' ? '（' + peak[0].slice(5).replace('-', '.') + '）' : '') + ' · 点任意一天看明细';
    }
  }

  function renderStack(p) {
    var rows = monthlyAgg(scopeRecords());
    var labels = rows.map(function (r) { return r.label; });
    var colors = catColors(p);
    var o = baseOption(p);
    o.color = colors;
    o.grid = { left: 6, right: 12, top: 38, bottom: 6, containLabel: true };
    o.legend = { top: 2, left: 0, itemWidth: 9, itemHeight: 9, itemGap: 11, icon: 'roundRect', textStyle: { color: p.text2, fontSize: 10.5, fontFamily: p.font } };
    o.tooltip = tooltipCommon(p, { trigger: 'axis', axisPointer: { type: 'line', lineStyle: { color: p.border, type: 'dashed' } }, valueFormatter: function (v) { return fmtYuan(v); } });
    o.xAxis = catAxis(p, labels, { boundaryGap: false, axisLabel: { color: p.muted, fontSize: 10, fontFamily: p.font, interval: labelInterval('chartStack', labels.length, 62) } });
    o.yAxis = valAxis(p);
    /* 深色底下半透明面积会糊成橄榄色，提高不透明度保住色相 */
    var areaAlpha = document.documentElement.getAttribute('data-theme') === 'dark' ? .82 : .58;
    o.series = EXPENSE_CATS.map(function (c, i) {
      var fill = catFill(p, colors[i]);
      return {
        name: c, type: 'line', stack: 'total', smooth: .3, symbol: 'none',
        lineStyle: { width: 1.4, color: fill },
        areaStyle: { color: withAlpha(fill, areaAlpha) },
        emphasis: { focus: 'series' },
        data: rows.map(function (r) { return round(r.byCat[c] || 0); })
      };
    });
    setOpt('chartStack', o);
    lastStackRows = rows;
    bindAxisClick('chartStack', function (idx) {
      var row = lastStackRows[idx];
      if (row) jumpToDetail({ reset: true, year: row.year, month: row.month });
    });
  }

  function renderWeekday(p) {
    var data = weekdayTotals(scopeRecords());
    var colors = [p.primary, p.income, p.amber, p.violet, p.sky, p.expense, mixColor(p.primary, p.income, .5)];
    var o = baseOption(p);
    o.color = colors;
    o.tooltip = tooltipCommon(p, { trigger: 'item', formatter: function (d) { return d.marker + d.name + '<br/><b>' + fmtYuan(d.value) + '</b> · ' + d.percent + '%'; } });
    o.series = [{
      type: 'pie', roseType: 'radius', radius: ['20%', '72%'], center: ['50%', '50%'],
      minAngle: 8,
      itemStyle: { borderColor: p.surface, borderWidth: 2, borderRadius: 6 },
      label: { show: true, formatter: '{b}', color: p.text2, fontSize: 10.5, fontFamily: p.font },
      labelLine: { length: 5, length2: 6, lineStyle: { color: p.border } },
      emphasis: { scale: true, scaleSize: 6, itemStyle: { shadowBlur: 16, shadowColor: withAlpha(p.primary, .28) } },
      data: data.map(function (d, i) { return { name: d.name, value: d.value, itemStyle: { color: colors[i] } }; })
    }];
    setOpt('chartWeekday', o);
    bindClick('chartWeekday', function (params) {
      var i = params.dataIndex;
      jumpToDetail({ reset: true, weekday: i, label: '已筛选：' + WEEKDAYS[i] });
    });
  }

  function renderTop(p) {
    var data = topItems(scopeRecords(), 10).reverse();
    var o = baseOption(p);
    o.grid = { left: 6, right: 84, top: 8, bottom: 6, containLabel: true };
    o.tooltip = tooltipCommon(p, { trigger: 'item', formatter: function (d) { return esc(d.name) + ' · <b>' + fmtYuan(d.value) + '</b>'; } });
    o.xAxis = valAxis(p);
    o.yAxis = catAxis(p, data.map(function (d) { return d.name; }), {
      axisLine: { show: false },
      axisLabel: { color: p.text2, fontSize: 11.5, fontFamily: p.font, width: 108, overflow: 'truncate' }
    });
    o.series = [{
      type: 'bar', barWidth: 12,
      data: data.map(function (d) { return { value: d.value, itemStyle: { color: gradH(withAlpha(p.primary, .32), p.primary), borderRadius: [0, 6, 6, 0] } }; }),
      label: { show: true, position: 'right', distance: 8, formatter: function (d) { return fmtYuan(d.value); }, color: p.text2, fontSize: 11, fontFamily: p.font },
      emphasis: { itemStyle: { shadowBlur: 12, shadowColor: withAlpha(p.primary, .28) } }
    }];
    setOpt('chartTop', o);
    bindClick('chartTop', function (params) {
      if (params.name) jumpToDetail({ reset: true, q: params.name, label: '已搜索：' + params.name });
    });
  }

  /* ---------------- 分析页：年度总账 ---------------- */
  function renderAnnual(p) {
    var box = $('annualGrid');
    if (!box) return;
    /* 每一年的总账都算出来，同比就取数组里的前一年——多一年数据只是多一张卡 */
    var stats = YEARS.map(function (y) { return yearStats(y); });
    var mode = state.annualScope;
    var years = mode === 'both' ? stats : stats.filter(function (s) { return String(s.year) === mode; });
    if (!years.length) years = stats.slice(-1);

    /* 有一边不是整年（2024 只有 7—12 月）就按月均比，标签也写明 */
    function delta(cur, prev, invert, months, prevMonths) {
      if (!prev) return '<i class="ay-yoy flat">月均 ' + fmtBig(cur / Math.max(1, months)) + '</i>';
      var partial = months < 12 || prevMonths < 12;
      var d = yoyPct(cur, partial ? months : 0, prev, partial ? prevMonths : 0);
      if (d === null) return '<i class="ay-yoy flat">月均 ' + fmtBig(cur / Math.max(1, months)) + '</i>';
      var up = d >= 0;
      var good = invert ? !up : up;
      var sign = up ? '+' : '';
      return '<i class="ay-yoy ' + (good ? 'up' : 'down') + '">' + (up ? '↑' : '↓') + ' ' + sign + d.toFixed(1) + '% ' + (partial ? '月均' : '同比') + '</i>';
    }
    box.className = 'annual-grid' + (years.length === 1 ? ' is-single' : '');
    box.innerHTML = years.map(function (s) {
      var prev = stats[stats.indexOf(s) - 1] || null;
      return '<button type="button" class="annual-year" data-jump-year="' + s.year + '">' +
        '<div class="ay-head"><b>' + s.year + '</b><span>' + s.months + ' 个月 · ' + s.count + ' 笔</span></div>' +
        '<div class="ay-hero"><span>净结余</span><em class="' + (s.balance >= 0 ? 'pos' : 'neg') + '">' + fmtBig(s.balance) + '</em></div>' +
        '<div class="ay-cells">' +
        '<div class="ay-cell"><span>收入</span><b class="c-income">' + fmtBig(s.income) + '</b>' + delta(s.income, prev && prev.income, false, s.months, prev && prev.months) + '</div>' +
        '<div class="ay-cell"><span>支出</span><b class="c-expense">' + fmtBig(s.expense) + '</b>' + delta(s.expense, prev && prev.expense, true, s.months, prev && prev.months) + '</div>' +
        '<div class="ay-cell"><span>储蓄率</span><b>' + s.rate.toFixed(1) + '%</b>' + (prev ? '<i class="ay-yoy flat">' + (s.rate - prev.rate >= 0 ? '+' : '') + (s.rate - prev.rate).toFixed(1) + ' pt</i>' : '<i class="ay-yoy flat">基准年</i>') + '</div>' +
        '</div>' +
        '<div class="ay-foot"><span>月均支出 ' + fmtBig(s.expense / s.months) + '</span><span class="ay-go">查看日历 →</span></div>' +
        '</button>';
    }).join('');

    var sub = $('annualSub');
    if (sub) {
      var total = stats.reduce(function (n, s) { return n + s.count; }, 0);
      if (mode === 'both') {
        sub.textContent = Y_FIRST + ' — ' + Y_LAST + ' 全年收支总览 · 三年里记下的 ' + total + ' 笔';
      } else {
        var one = years[0];
        sub.textContent = one.year + ' 年全年收支总览 · ' + one.months + ' 个月记下的 ' + one.count + ' 笔 · 占全部 ' +
          (total ? Math.round(one.count / total * 100) : 0) + '%';
      }
    }
  }


  function renderCharts(view, mode) {
    if (!hasEcharts) return;
    var prevMode = RENDER_MODE;
    if (mode) RENDER_MODE = mode;
    var p = palette();
    if (view === 'overview') {
      renderTrend(p); renderDonut(p); renderBalance(p);
    } else if (view === 'analysis') {
      renderAnnual(p); renderCompare(p); renderRank(p); renderWeekday(p); renderCalendar(p); renderStack(p); renderTop(p);
    }
    RENDER_MODE = prevMode;
  }

  /* ---------------- 数字动效 ---------------- */
  function animateValue(el, target, formatter) {
    if (!el) return;
    var prev = Number(el.dataset.value || 0);
    el.dataset.value = String(target);
    if (Math.abs(prev - target) < .005) { el.textContent = formatter(target); return; }
    var start = performance.now(), dur = 900;
    function step(now) {
      var t = Math.min(1, (now - start) / dur);
      var e = 1 - Math.pow(1 - t, 3);
      el.textContent = formatter(prev + (target - prev) * e);
      if (t < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }
  function sparkline(svg, values, color, w, h) {
    if (!svg) return;
    if (!values.length) { svg.innerHTML = ''; return; }
    w = w || 120; h = h || 34;
    var pad = 2;
    var min = Math.min.apply(null, values.concat([0]));
    var max = Math.max.apply(null, values.concat([1]));
    var range = (max - min) || 1;
    var pts = values.map(function (v, i) {
      return [pad + (i / Math.max(1, values.length - 1)) * (w - 2 * pad), h - pad - ((v - min) / range) * (h - 2 * pad)];
    });
    var d = pts.map(function (pt, i) { return (i ? 'L' : 'M') + pt[0].toFixed(1) + ',' + pt[1].toFixed(1); }).join(' ');
    var area = d + ' L' + (w - pad) + ',' + h + ' L' + pad + ',' + h + ' Z';
    svg.innerHTML = '<path class="area" d="' + area + '" fill="' + color + '"/><path class="line" d="' + d + '" stroke="' + color + '"/>';
  }

  /* ---------------- 概览条 ---------------- */
  function totalsOf(list) {
    var i = 0, e = 0, ni = 0, ne = 0;
    list.forEach(function (r) {
      if (r.type === 'income') { i += r.amount; ni++; } else { e += r.amount; ne++; }
    });
    return { income: round(i), expense: round(e), balance: round(i - e), nIncome: ni, nExpense: ne };
  }
  /* 上一年同期总账：只有"单年"视图才有对照，混合视图返回 null。
     2024 没有 2023 的数据，自然落到"无同期"。
     带出月份数——上半年/下半年才有的年份要按月均比，不能拿总数跟整年比 */
  function prevYearTotals() {
    if (state.year === 'all') return null;
    var y = String(Number(state.year) - 1);
    var list = allRecords().filter(function (r) { return String(r.date).slice(0, 4) === y; });
    if (!list.length) return null;
    var t = totalsOf(list);
    var mm = {};
    list.forEach(function (r) { mm[r.month] = true; });
    t.months = Object.keys(mm).length;
    return t;
  }
  /* 同比百分比。两边月份数不齐（比如 2024 只有下半年）就换成月均比，
     否则"2025 全年 vs 2024 半年"会算出 +160% 这种假增速 */
  function yoyPct(cur, curMonths, prev, prevMonths) {
    if (prev === null || prev === undefined || !isFinite(prev)) return null;
    var uneven = curMonths && prevMonths && (curMonths < 12 || prevMonths < 12);
    var c = uneven ? cur / Math.max(1, curMonths) : cur;
    var p = uneven ? prev / Math.max(1, prevMonths) : prev;
    if (!p) return null;
    return (c - p) / Math.abs(p) * 100;
  }
  function setDelta(el, pct, unit) {
    if (!el) return;
    if (pct === null || pct === undefined || !isFinite(pct)) {
      el.classList.remove('up');
      el.classList.remove('down');
      el.textContent = state.year === 'all' ? '多年合看' : '无同期';
      el.hidden = false;
      el.title = '当前视图没有可比的同期数据';
      return;
    }
    el.hidden = false;
    el.textContent = (pct > 0 ? '▲ ' : pct < 0 ? '▼ ' : '＝ ') + Math.abs(pct).toFixed(1) + (unit || '%');
    el.title = '同比' + (pct > 0 ? '上升' : pct < 0 ? '下降' : '持平') + Math.abs(pct).toFixed(1) + '%';
  }
  function renderKpis() {
    var records = scopeRecords();
    var rows = monthlyAgg(records);
    var t = totalsOf(records);
    var income = t.income, expense = t.expense, balance = t.balance;
    var months = rows.length || 1;
    var rate = income > 0 ? (balance / income * 100) : 0;
    var p = palette();
    var prev = prevYearTotals();
    var dates = records.map(function (r) { return r.date; }).sort();
    var spanD = dates.length
      ? Math.max(1, Math.round((new Date(dates[dates.length - 1] + 'T00:00:00') - new Date(dates[0] + 'T00:00:00')) / 864e5) + 1)
      : 1;

    animateValue($('kpiIncome'), income, fmtBig);
    animateValue($('kpiExpense'), expense, fmtBig);
    animateValue($('kpiBalance'), balance, fmtBig);
    animateValue($('kpiRate'), rate, function (v) { return v.toFixed(1) + '%'; });

    var balEl = $('kpiBalance');
    if (balEl) { balEl.classList.toggle('pos', balance > 0); balEl.classList.toggle('neg', balance < 0); }

    /* 每格第二行：能算同比就给同比，混合视图就退回月均 / 日均 / 笔数 */
    var pm = prev && prev.months;
    setDelta($('deltaIncome'), prev ? yoyPct(income, months, prev.income, pm) : null);
    setDelta($('deltaExpense'), prev ? yoyPct(expense, months, prev.expense, pm) : null);
    setDelta($('deltaBalance'), prev ? yoyPct(balance, months, prev.balance, pm) : null);
    var prevRate = prev && prev.income > 0 ? (prev.balance / prev.income * 100) : null;
    setDelta($('deltaRate'), prev && prevRate !== null ? rate - prevRate : null, ' pt');

    /* 每格两条脚注：左边口径，右边规模 / 占比 —— 填满原来空着的右半边 */
    setText('kpiIncomeSub', '月均 ' + fmtBig(income / months));
    setText('kpiIncomeSub2', t.nIncome + ' 笔');
    setText('kpiExpenseSub', '日均 ' + fmtBig(expense / spanD));
    setText('kpiExpenseSub2', t.nExpense + ' 笔');
    setText('kpiBalanceSub', '月均 ' + fmtBig(balance / months));
    setText('kpiBalanceSub2', '占收入 ' + (income > 0 ? (balance / income * 100).toFixed(0) : 0) + '%');
    setText('kpiRateSub', balance >= 0 ? '结余 ' + fmtBig(balance) : '超支 ' + fmtBig(-balance));
    setText('kpiRateSub2', prevRate === null ? '近 ' + months + ' 个月' : '去年 ' + prevRate.toFixed(1) + '%');

    var fill = $('rateFill');
    if (fill) fill.style.width = Math.max(0, Math.min(100, rate)).toFixed(1) + '%';

    sparkline($('sparkIncome'), rows.map(function (r) { return r.income; }), p.income, 100, 26);
    sparkline($('sparkExpense'), rows.map(function (r) { return r.expense; }), p.expense, 100, 26);
    sparkline($('sparkBalance'), rows.map(function (r) { return r.balance; }), p.primary, 100, 26);

    renderMonthMini();
  }

  function setText(id, v) {
    var el = $(id);
    if (el) el.textContent = v;
  }

  /* 本月速览：口径锁在"有数据的最后一个月"，与顶部年度筛选解耦。
     支出 / 结余 / 日均 / 单笔四个口径全部按单月算，四格两行都是真数字。 */
  function renderMonthMini() {
    var all = allRecords();
    if (!all.length) return;
    var maxDate = '';
    all.forEach(function (r) { if (r.date > maxDate) maxDate = r.date; });
    if (!maxDate) return;
    var yrs = Number(maxDate.slice(0, 4)), mos = Number(maxDate.slice(5, 7));
    var curKey = maxDate.slice(0, 7);
    var pv0 = new Date(yrs, mos - 2, 1);
    var prevKey = pv0.getFullYear() + '-' + pad2(pv0.getMonth() + 1);
    var dim = new Date(yrs, mos, 0).getDate();

    function bucket(key) {
      var e = 0, i = 0, ne = 0, daySet = {};
      all.forEach(function (r) {
        if (String(r.date).slice(0, 7) !== key) return;
        if (r.type === 'income') { i += r.amount; return; }
        e += r.amount; ne++; daySet[r.date] = 1;
      });
      return { exp: round(e), inc: round(i), nExp: ne, days: Object.keys(daySet).length };
    }
    var cur = bucket(curKey), pv = bucket(prevKey);
    var bal = round(cur.inc - cur.exp);
    var rate = cur.inc > 0 ? bal / cur.inc * 100 : 0;

    var allSum = 0, allN = 0, maxOne = 0;
    all.forEach(function (r) {
      if (r.type === 'income') return;
      allSum += r.amount; allN++;
      if (r.amount > maxOne) maxOne = r.amount;
    });

    var now = new Date();
    var isNow = yrs === now.getFullYear() && mos === now.getMonth() + 1;
    setText('mmL1', (isNow ? '本月' : mos + '月') + '支出');
    setText('mmL2', (isNow ? '本月' : mos + '月') + '结余');
    setText('mmExp', fmtBig(cur.exp));
    setText('mmBal', (bal < 0 ? '−' : '') + fmtBig(Math.abs(bal)));
    setText('mmDaily', fmtBig(cur.exp / dim));
    setText('mmAvg', fmtBig(allN ? allSum / allN : 0));
    setText('mmDailyD', '当月 ' + cur.days + ' 天有账');
    setText('mmBalD', '储蓄率 ' + rate.toFixed(1) + '%');
    setText('mmAvgD', '最大单笔 ' + fmtBig(maxOne));

    var bel = $('mmBal');
    if (bel) { bel.classList.toggle('pos', bal > 0); bel.classList.toggle('neg', bal < 0); }

    var el = $('mmExpD');
    if (el) {
      el.classList.remove('up');
      el.classList.remove('down');
      if (pv.exp > 0) {
        var d = (cur.exp - pv.exp) / pv.exp * 100;
        el.textContent = '较上月 ' + (d > 0 ? '▲ ' : d < 0 ? '▼ ' : '＝ ') + Math.abs(d).toFixed(1) + '%';
        if (d > 0) el.classList.add('up');
        else if (d < 0) el.classList.add('down');
      } else {
        el.textContent = '上月无支出';
      }
    }
  }

  function renderSide() {
    var recs = allRecords();
    var count = $('sideCount'), rangeEl = $('sideRange'), local = $('sideLocal'), dims = $('sideDims');
    if (count) count.textContent = recs.length.toLocaleString('zh-CN') + ' 笔';
    if (dims) dims.textContent = EXPENSE_CATS.length + ' 类 · ' + countSubCats() + ' 子类';
    if (rangeEl) {
      var dates = recs.map(function (r) { return r.date; }).sort();
      rangeEl.textContent = dates.length ? (dates[0].slice(0, 7).replace('-', '.') + ' — ' + dates[dates.length - 1].slice(0, 7).replace('-', '.')) : '—';
    }
    if (local) {
      var n = state.store.added.length + Object.keys(state.store.edited).length + state.store.deleted.length;
      local.textContent = n + ' 笔';
    }
  }

  function renderPeriod() {
    var el = $('periodChip');
    if (!el) return;
    var recs = scopeRecords();
    if (!recs.length) { el.textContent = '暂无数据'; return; }
    var dates = recs.map(function (r) { return r.date; }).sort();
    el.textContent = dates[0].slice(0, 7).replace('-', '.') + ' — ' + dates[dates.length - 1].slice(0, 7).replace('-', '.');
  }

  /* ---------------- 日历：分类 / 子类筛选（与工具条同一行） ---------------- */
  var cmpYear = 2026, cmpOpen = false;
  function renderCatBar(p) {
    var catBox = $('catRow'), subBox = $('subRow');
    if (!catBox || !subBox) return;
    var cat = state.filters.category;
    var colors = catColors(p);

    var html = '<button type="button" data-cat="all" style="--c:' + p.primary + ';--ink:' + p.primary + '"' +
      (cat === 'all' ? ' class="is-active"' : '') + '><i></i>全部</button>';
    EXPENSE_CATS.forEach(function (c, i) {
      html += '<button type="button" data-cat="' + esc(c) + '" style="--c:' + colors[i] + ';--ink:' + catInk(p, colors[i]) + '"' +
        (cat === c ? ' class="is-active"' : '') + '><i></i>' + esc(c) + '</button>';
    });
    html += '<button type="button" data-cat="收入" style="--c:' + p.income + ';--ink:' + catInk(p, p.income) + '"' +
      (cat === '收入' ? ' class="is-active"' : '') + '><i></i>收入</button>';
    catBox.innerHTML = html;

    var sub = '';
    if (cat !== 'all') {
      var base = catColor(p, cat);
      var counts = {}, tot = 0;
      rangeRecords().forEach(function (r) {
        if (r.category !== cat) return;
        counts[r.sub] = (counts[r.sub] || 0) + 1;
        tot++;
      });
      var names = subCatNames(cat);
      sub = '<span class="ct-div" aria-hidden="true"></span>';
      sub += '<button type="button" class="ct-sub" data-sub="all" style="--c:' + p.primary + ';--ink:' + p.primary + '"' +
        (state.filters.sub === 'all' ? ' class="ct-sub is-active"' : '') + '>全部<b>' + tot + '</b></button>';
      names.forEach(function (s, i) {
        var n = counts[s] || 0;
        var on = state.filters.sub === s;
        var step = names.length <= 1 ? .1 : (i / Math.max(1, names.length - 1)) * .5;
        var col = mixColor(base, p.surface, .1 + step * .45);
        sub += '<button type="button" class="ct-sub' + (on ? ' is-active' : '') + (n ? '' : ' is-empty') +
          '" data-sub="' + esc(s) + '" style="--c:' + col + ';--ink:' + catInk(p, col) + '">' + esc(s) +
          '<b>' + n + '</b></button>';
      });
    }
    subBox.innerHTML = sub;

    /* 只有真的横向溢出时才给渐隐遮罩：否则连"收入"那颗也会被淡掉一截 */
    var strip = catBox.parentNode;
    if (strip && strip.classList && strip.classList.contains('ct-chips')) {
      strip.classList.toggle('is-scrollable', strip.scrollWidth - strip.clientWidth > 2);
    }
  }
  function syncCalLegend() { renderCatBar(palette()); }

  function renderCmp() {
    var box = $('cmpMonths');
    if (!box) return;
    if ($('cmpTitle')) $('cmpTitle').textContent = cmpYear + '年';
    box.innerHTML = MONTH_CN.map(function (n, i) {
      var active = cmpYear === state.calMonth.year && (i + 1) === state.calMonth.month;
      return '<button type="button" class="dp-month' + (active ? ' is-active' : '') + '" data-month="' + (i + 1) + '">' + n + '</button>';
    }).join('');
  }
  function openCmp() {
    var pop = $('calMonthPop'), title = $('calTitle');
    if (!pop || !title) return;
    cmpYear = state.calMonth.year;
    cmpOpen = true;
    pop.hidden = false;
    title.classList.add('is-open');
    title.setAttribute('aria-expanded', 'true');
    renderCmp();
  }
  function closeCmp() {
    var pop = $('calMonthPop'), title = $('calTitle');
    cmpOpen = false;
    if (pop) pop.hidden = true;
    if (title) { title.classList.remove('is-open'); title.setAttribute('aria-expanded', 'false'); }
  }

  /* ---------------- 日历：四种粒度的棋盘 ---------------- */
  function groupByDate(rows) {
    var map = {};
    rows.forEach(function (r) { (map[r.date] = map[r.date] || []).push(r); });
    Object.keys(map).forEach(function (k) {
      map[k].sort(function (a, b) {
        if (a.type !== b.type) return a.type === 'income' ? -1 : 1;
        return b.amount - a.amount;
      });
    });
    return map;
  }
  function itemHTML(p, r, opts) {
    var c = r.type === 'income' ? p.income : catColor(p, r.category);
    var ink = catInk(p, c);
    var sign = r.type === 'income' ? '+' : '−';
    var label = r.note || r.sub;
    var tip = label + ' · ' + r.sub + ' · ' + fmtYuan(r.amount);
    return '<button type="button" class="cal-item" data-id="' + esc(r.id) + '" style="--c:' + c + ';--ink:' + ink + '" title="' + esc(tip) + '">' +
      '<span class="ci-name"><i></i><span>' + esc(label) + '</span></span>' +
      (opts && opts.noAmount ? '' : '<b>' + sign + fmtChip(r.amount) + '</b>') + '</button>';
  }
  /* 右上角收支胶囊：净额 + 一颗呼吸点，代替原来的整块填色 */
  function daySumHTML(p, items) {
    if (!items.length) return '<span class="cal-daysum is-off" aria-hidden="true"></span>';
    var de = 0, di = 0;
    items.forEach(function (r) { if (r.type === 'income') di += r.amount; else de += r.amount; });
    var net = de - di;                       /* 支出为正，收入为负 */
    var posNum = di - de;                    /* 净收入 */
    var def = posNum >= 0;
    var col = def ? p.income : p.expense;
    var txt = (def ? '+' : '−') + fmtChip(Math.abs(posNum));
    var tip = '支出 ' + fmtYuan(de) + ' · 收入 ' + fmtYuan(di) + ' · 净额 ' + fmtYuan(posNum);
    return '<span class="cal-daysum" style="--ds:' + col + ';--ds-ink:' + catInk(p, col) + '" title="' + esc(tip) + '">' + txt + '</span>';
  }

  /* 一条条目的最小/最大高度。15px 是 "色点 + 11px 字" 还看得清的底线；
     46px 是两块式再高也只是空，不如把空间留给下面的行 */
  var ENTRY_GAP = 3, ENTRY_MIN = 15, ENTRY_MAX = 46;
  function narrowGrid() {
    return !!(window.matchMedia && window.matchMedia('(max-width: 620px)').matches);
  }
  /* 行高不固定：量出这一格扣掉表头之后还剩多少高度，
     有几个条目、要排几行，就把高度均分下去。
     条少 —— 每条高一截，最多 46px；条多 —— 均分，压到 15px 为止；
     再多的部分折成 "+N 笔"，点开看浮层。 */
  function fitStack(cell, box, headSel, perRow, minRow, maxRow) {
    var nodes = box.querySelectorAll('.cal-item');
    var count = nodes.length;
    var more = box.querySelector('.cal-more');
    if (!count) { if (more) box.removeChild(more); return; }

    var head = headSel ? cell.querySelector(headSel) : null;
    var cs = window.getComputedStyle(cell);
    var padT = parseFloat(cs.paddingTop) || 0;
    var padB = parseFloat(cs.paddingBottom) || 0;
    var headH = head ? head.offsetHeight + (parseFloat(window.getComputedStyle(head).marginBottom) || 0) : 30;
    var avail = Math.max(minRow, cell.clientHeight - padT - padB - headH);

    var rowsFit = Math.max(1, Math.floor((avail + ENTRY_GAP) / (minRow + ENTRY_GAP)));
    var capacity = rowsFit * perRow;
    var overflow = count > capacity;
    /* "+N 笔" 自己占一格，所以溢出时先让出一条 */
    var keep = overflow ? Math.max(1, capacity - 1) : count;
    for (var k = keep; k < count; k++) box.removeChild(nodes[k]);
    var rest = count - keep;
    var slots = keep + (rest > 0 ? 1 : 0);
    var rows = Math.ceil(slots / perRow);
    var rowH = Math.floor((avail - ENTRY_GAP * (rows - 1)) / rows);

    rowH = Math.max(minRow, Math.min(maxRow, rowH));
    box.style.setProperty('--row-h', rowH + 'px');
    /* 两块式要 34px 才站得住，不够就转单行 */
    box.classList.toggle('is-tight', rowH < 34);

    if (rest > 0) {
      if (!more) {
        more = document.createElement('button');
        more.type = 'button';
        more.className = 'cal-more';
        more.setAttribute('data-more', cell.getAttribute('data-date'));
        box.appendChild(more);
      }
      more.innerHTML = '<span class="cm-full">+' + rest + ' 笔</span><span class="cm-mini">+' + rest + '</span>';
      more.title = '查看 ' + cell.getAttribute('data-date') + ' 的全部 ' + count + ' 笔';
    } else if (more) {
      box.removeChild(more);
    }
  }

  function fillMonthEntries(grid) {
    var narrow = narrowGrid();
    var perRow = narrow ? 1 : 2;
    var cells = grid.children;
    for (var i = 0; i < cells.length; i++) {
      var box = cells[i].querySelector('.cal-items');
      if (!box) continue;
      fitStack(cells[i], box, '.cal-cell-head', perRow, narrow ? 5 : ENTRY_MIN, narrow ? 6 : ENTRY_MAX);
    }
  }

  function renderMonthBoard(p, board) {
    var grid = $('calGrid');
    if (!grid) return;
    var y = state.calMonth.year, m = state.calMonth.month;
    var byDate = groupByDate(board);
    var first = new Date(y, m - 1, 1);
    var offset = (first.getDay() + 6) % 7;
    var daysInMonth = new Date(y, m, 0).getDate();
    var cells = Math.ceil((offset + daysInMonth) / 7) * 7;
    var today = todayStr();
    var html = '';
    for (var i = 0; i < cells; i++) {
      var d = new Date(y, m - 1, 1 - offset + i);
      var key = dateKey(d);
      var other = d.getMonth() !== m - 1;
      var items = other ? [] : (byDate[key] || []);
      var cls = 'cal-cell';
      if (other) cls += ' is-other';
      if (d.getDay() === 0 || d.getDay() === 6) cls += ' is-weekend';
      if (key === today) cls += ' is-today';
      if (key === state.focusDate) cls += ' is-focus';
      /* 先把全部条目都写进去，裁几条、每条多高，交给第二遍按真实高度算 */
      html += '<div class="' + cls + '" data-date="' + key + '" data-other="' + (other ? '1' : '0') + '">' +
        '<div class="cal-cell-head"><div class="cal-dayleft"><span class="cal-daynum">' + d.getDate() + '</span>' +
        (d.getDate() === 1 ? '<span class="cal-monthtag">' + (d.getMonth() + 1) + '月</span>' : '') + '</div>' +
        daySumHTML(p, items) + '</div>' +
        '<div class="cal-items">' + items.map(function (r) { return itemHTML(p, r); }).join('') + '</div>' +
        (other ? '' : '<button type="button" class="cal-add" data-add="' + key + '" aria-label="在 ' + key + ' 新增">+</button>') +
        '</div>';
    }
    grid.innerHTML = html;
    fillMonthEntries(grid);
  }

  function renderWeekBoard(p, board) {
    var box = $('calWeekGrid');
    if (!box) return;
    var b = rangeBounds();
    var byDate = groupByDate(board);
    var today = todayStr();
    var html = '';
    for (var i = 0; i < 7; i++) {
      var d = new Date(b.from.getFullYear(), b.from.getMonth(), b.from.getDate() + i);
      var key = dateKey(d);
      var items = byDate[key] || [];
      var de = 0, di = 0;
      items.forEach(function (r) { if (r.type === 'income') di += r.amount; else de += r.amount; });
      var cls = 'wk-col';
      if (key === today) cls += ' is-today';
      if (i >= 5) cls += ' is-weekend';
      html += '<div class="' + cls + '" data-date="' + key + '">' +
        '<div class="wk-head"><span class="wk-dow">' + WEEKDAYS[i] + '</span><b class="wk-day">' + d.getDate() + '</b>' +
        '<span class="wk-sum">' + (de ? '−' + fmtChip(de) : '') + (de && di ? ' / ' : '') + (di ? '+' + fmtChip(di) : '') + '</span></div>' +
        '<div class="cal-items wk-items">' + items.map(function (r) { return itemHTML(p, r); }).join('') +
        (items.length ? '' : '<span class="wk-empty">无记录</span>') + '</div>' +
        '<button type="button" class="cal-add" data-add="' + key + '" aria-label="在 ' + key + ' 新增">+</button>' +
        '</div>';
    }
    box.innerHTML = html;
    /* 周视图的列比月格子高得多，同样按可用高度摊开条目，别让下面空半屏 */
    for (var c = 0; c < box.children.length; c++) {
      var col = box.children[c];
      var list = col.querySelector('.cal-items');
      if (list && list.querySelector('.cal-item')) fitStack(col, list, '.wk-head', narrowGrid() ? 1 : 2, 22, 44);
    }
  }

  function renderDayBoard(p, board) {
    var box = $('calDayBoard');
    if (!box) return;
    var key = dateKey(anchorDate());
    var items = board.filter(function (r) { return r.date === key; });
    var de = 0, di = 0, byCat = {};
    items.forEach(function (r) {
      if (r.type === 'income') { di += r.amount; return; }
      de += r.amount;
      byCat[r.category] = (byCat[r.category] || 0) + r.amount;
    });
    var net = di - de;
    var maxCat = Object.keys(byCat).reduce(function (m2, k) { return Math.max(m2, byCat[k]); }, 1);

    var bars = EXPENSE_CATS.filter(function (c) { return byCat[c]; }).map(function (c) {
      var col = catColor(p, c);
      return '<div class="dsc-row"><span><i style="background:' + col + '"></i>' + esc(c) + '</span>' +
        '<div class="dsc-track"><b style="width:' + (byCat[c] / maxCat * 100).toFixed(1) + '%;background:' + catFill(p, col) + '"></b></div>' +
        '<em>' + fmtYuan(byCat[c]) + '</em></div>';
    }).join('');

    var d = new Date(key + 'T00:00:00');
    box.innerHTML =
      '<aside class="day-side">' +
      '<div class="ds-head"><span class="ds-ym">' + d.getFullYear() + ' 年 ' + (d.getMonth() + 1) + ' 月</span>' +
      '<span class="ds-dow">' + WEEK_CN[d.getDay()] + '</span></div>' +
      '<div class="ds-big"><b>' + d.getDate() + '</b><i>日</i></div>' +
      '<div class="ds-net" style="--ds:' + (Math.abs(net) < .005 ? p.muted : net > 0 ? p.income : p.expense) + '">' +
      '<span>当日净额</span><b>' + (net >= 0 ? '+' : '−') + fmtYuan(Math.abs(net)).slice(1) + '</b></div>' +
      '<div class="ds-meta"><div><span>支出</span><b class="c-expense">' + fmtYuan(de) + '</b></div>' +
      '<div><span>收入</span><b class="c-income">' + fmtYuan(di) + '</b></div>' +
      '<div><span>笔数</span><b>' + items.length + '</b></div></div>' +
      (bars ? '<div class="ds-cats">' + bars + '</div>' : '') +
      '<button type="button" class="btn btn-ghost ds-add" data-add="' + key + '">这天记一笔</button>' +
      '</aside>' +
      '<div class="day-list">' +
      (items.length
        ? items.map(function (r) {
          var c = r.type === 'income' ? p.income : catColor(p, r.category);
          return '<button type="button" class="day-row" data-id="' + esc(r.id) + '" style="--c:' + c + ';--ink:' + catInk(p, c) + '">' +
            '<i></i><div class="dr-main"><b>' + esc(r.note || r.sub) + '</b><span>' + esc(r.category) + ' · ' + esc(r.sub) + '</span></div>' +
            '<em>' + (r.type === 'income' ? '+' : '−') + fmtYuan(r.amount) + '</em></button>';
        }).join('')
        : '<div class="day-empty"><strong>这天还没有记录</strong><span>点上面的按钮，或者去月视图点空白格。</span></div>') +
      '</div>';
  }

  function renderYearBoard(p, board) {
    var box = $('calYearBoard');
    if (!box) return;
    var y = state.calMonth.year;
    var byDate = groupByDate(board);
    var monthTot = [], daySum = {}, peak = 1;
    board.forEach(function (r) {
      if (r.type !== 'expense') return;
      monthTot[r.month] = (monthTot[r.month] || 0) + r.amount;
      daySum[r.date] = (daySum[r.date] || 0) + r.amount;
      if (daySum[r.date] > peak) peak = daySum[r.date];
    });
    var today = todayStr();
    var html = '';
    for (var m = 1; m <= 12; m++) {
      var first = new Date(y, m - 1, 1);
      var offset = (first.getDay() + 6) % 7;
      var days = new Date(y, m, 0).getDate();
      var cells = Math.ceil((offset + days) / 7) * 7;
      var grid = '';
      for (var i = 0; i < cells; i++) {
        var d = new Date(y, m - 1, 1 - offset + i);
        if (d.getMonth() !== m - 1) { grid += '<i class="ym-blank"></i>'; continue; }
        var key = dateKey(d);
        var items = byDate[key] || [];
        var sum = daySum[key] || 0;
        var t = peak > 0 ? Math.min(1, sum / peak) : 0;
        var alpha = sum ? .16 + t * .74 : 0;
        var bgc = sum ? withAlpha(p.expense, alpha) : mixColor(p.surface3, p.surface, .45);
        var ink = sum && alpha > .42 ? '#ffffff' : (sum ? catInk(p, p.expense) : p.muted);
        var cls = 'ym-day' + (sum ? ' has' : '') + (key === today ? ' is-today' : '');
        grid += '<button type="button" class="' + cls + '" data-date="' + key + '" style="background:' + bgc + ';color:' + ink +
          '" title="' + key + ' · ' + (sum ? fmtBig(sum) : '无支出') + '">' + d.getDate() + '</button>';
      }
      html += '<article class="ym">' +
        '<button type="button" class="ym-head" data-month="' + m + '"><b>' + m + '月</b><span>' + fmtBig(monthTot[m] || 0) + '</span></button>' +
        '<div class="ym-week"><span>一</span><span>二</span><span>三</span><span>四</span><span>五</span><span>六</span><span>日</span></div>' +
        '<div class="ym-grid">' + grid + '</div></article>';
    }
    box.innerHTML = html;
  }

  function renderBoard() {
    var y = state.calMonth.year, m = state.calMonth.month;
    var scopeAll = rangeRecords();
    var board = boardRecords();
    var p = palette();

    var exp = 0, inc = 0;
    scopeAll.forEach(function (r) { if (r.type === 'income') inc += r.amount; else exp += r.amount; });
    exp = round(exp); inc = round(inc);

    var t = calTitleParts();
    if ($('calTitleText')) $('calTitleText').textContent = t.main;
    /* 笔数用定宽槽位显示：文本长度一律压到 "24 笔" / "8/24 笔" 两种形态，
       写多长都不会把后面的粒度控件挤走 */
    var cntAll = scopeAll.length, cntShow = board.length;
    if ($('calSub')) {
      $('calSub').textContent = cntShow === cntAll ? cntAll + ' 笔' : cntShow + '/' + cntAll + ' 笔';
      $('calSub').title = t.sub + ' · 共 ' + cntAll + ' 笔' + (cntShow === cntAll ? '' : '，筛选后 ' + cntShow + ' 笔');
    }
    if ($('mbExpense')) $('mbExpense').textContent = fmtBig(exp);
    if ($('mbIncome')) $('mbIncome').textContent = fmtBig(inc);
    if ($('mbBalance')) $('mbBalance').textContent = fmtBig(inc - exp);
    cmpYear = y;

    var scale = state.scale;
    if ($('calGrid')) $('calGrid').hidden = scale !== 'month';
    if ($('calWeekGrid')) $('calWeekGrid').hidden = scale !== 'week';
    if ($('calDayBoard')) $('calDayBoard').hidden = scale !== 'day';
    if ($('calYearBoard')) $('calYearBoard').hidden = scale !== 'year';
    if ($('calWeekHead')) $('calWeekHead').hidden = scale !== 'month';

    if (scale === 'month') renderMonthBoard(p, board);
    else if (scale === 'week') renderWeekBoard(p, board);
    else if (scale === 'day') renderDayBoard(p, board);
    else renderYearBoard(p, board);

    if ($('boardEmpty')) $('boardEmpty').hidden = board.length !== 0 || scale === 'day';
    renderCatBar(p);
  }

  function calTitleParts() {
    var b = rangeBounds();
    if (state.scale === 'month') {
      return { main: state.calMonth.year + '年 ' + state.calMonth.month + '月', sub: '整月视图' };
    }
    if (state.scale === 'year') {
      return { main: state.calMonth.year + '年', sub: '全年总览' };
    }
    if (state.scale === 'week') {
      var f = b.from, t = b.to;
      var sameM = f.getMonth() === t.getMonth();
      var main = sameM
        ? (f.getMonth() + 1) + '月 ' + f.getDate() + ' — ' + t.getDate() + '日'
        : (f.getMonth() + 1) + '月' + f.getDate() + '日 — ' + (t.getMonth() + 1) + '月' + t.getDate() + '日';
      var wk = Math.ceil(((f - new Date(f.getFullYear(), 0, 1)) / 86400000 + new Date(f.getFullYear(), 0, 1).getDay() + 1) / 7);
      return { main: main, sub: f.getFullYear() + '年 第 ' + wk + ' 周' };
    }
    var d = anchorDate();
    return { main: d.getFullYear() + '年 ' + (d.getMonth() + 1) + '月 ' + d.getDate() + '日', sub: WEEK_CN[d.getDay()] };
  }

  function renderAll() {
    renderSide();
    renderPeriod();
    renderKpis();
    renderBoard();
    renderCharts(state.view);
  }

  /* ---------------- 视图 / 分段控件 ---------------- */
  function setView(view) {
    if (!VIEW_META[view]) return;
    state.view = view;
    var views = document.querySelectorAll('.view');
    for (var i = 0; i < views.length; i++) views[i].classList.toggle('is-active', views[i].id === 'view-' + view);
    var navs = document.querySelectorAll('.nav-item');
    for (var j = 0; j < navs.length; j++) navs[j].classList.toggle('is-active', navs[j].dataset.view === view);
    /* 日历页要锁一整屏，正文底距归零，否则那 56px 会把日历顶出一截 */
    var main = document.querySelector('.main');
    if (main) main.classList.toggle('is-calendar', view === 'calendar');
    if ($('pageTitle')) $('pageTitle').textContent = VIEW_META[view][0];
    if ($('pageSub')) $('pageSub').textContent = VIEW_META[view][1];
    writeRoute(view, false);
    if (view === 'calendar') renderBoard();
    requestAnimationFrame(function () {
      /* 日历在 rAF 里再排一次：此时视图已可见，格子高度才是真值，
         一屏能塞几条条目才算得准 */
      if (view === 'calendar') renderBoard();
      resizeAll();
      renderCharts(view);
    });
  }
  /* ---------------- 路由 ----------------
     GitHub Pages 是纯静态托管，没有服务端重写，所以走 hash 路由：
     #/home  #/calendar  #/analysis 都能直接分享、刷新、前进后退。 */
  var ROUTE_ALIAS = {
    home: 'overview', overview: 'overview', index: 'overview',
    calendar: 'calendar', week: 'calendar', month: 'calendar', year: 'calendar',
    analysis: 'analysis', stats: 'analysis', trend: 'analysis'
  };
  var ROUTE_CANON = { overview: 'home', calendar: 'calendar', analysis: 'analysis' };

  function parseRoute() {
    var h = String(location.hash || '').replace(/^#\/?/, '');
    h = h.split('?')[0].split('/')[0].toLowerCase();
    return ROUTE_ALIAS[h] || '';
  }
  function writeRoute(view, replace) {
    var target = '#/' + (ROUTE_CANON[view] || view);
    if (location.hash === target) return;
    if (!location.hash) replace = true;
    try {
      if (replace) history.replaceState(null, '', target);
      else history.pushState(null, '', target);
    } catch (e) { location.hash = target; }
  }
  function bindRoute() {
    function sync() {
      var v = parseRoute();
      if (v && v !== state.view) setView(v);
    }
    window.addEventListener('hashchange', sync);
    window.addEventListener('popstate', sync);
  }

  function bindSeg(el, attr, handler) {
    if (!el) return;
    var btns = Array.prototype.slice.call(el.querySelectorAll('button[' + attr + ']'));
    /* 滑块的位置和宽度都从按钮数量算，段数不再写死在 CSS 里 */
    function sync() {
      var idx = 0;
      btns.forEach(function (b, i) { if (b.classList.contains('is-active')) idx = i; });
      el.dataset.active = String(idx);
      el.style.setProperty('--seg-n', String(btns.length || 1));
      el.style.setProperty('--seg-i', String(idx));
    }
    el.addEventListener('click', function (e) {
      var b = e.target.closest('button[' + attr + ']');
      if (!b) return;
      btns.forEach(function (x) { x.classList.toggle('is-active', x === b); });
      sync();
      handler(b.getAttribute(attr));
    });
    sync();
  }
  function setSegActive(el, attr, value) {
    if (!el) return;
    var btns = Array.prototype.slice.call(el.querySelectorAll('button[' + attr + ']'));
    var idx = 0;
    btns.forEach(function (b, i) {
      var on = b.getAttribute(attr) === String(value);
      b.classList.toggle('is-active', on);
      if (on) idx = i;
    });
    el.dataset.active = String(idx);
    el.style.setProperty('--seg-n', String(btns.length || 1));
    el.style.setProperty('--seg-i', String(idx));
  }

  /* ---------------- Toast ---------------- */
  function toast(msg, kind) {
    var stack = $('toastStack');
    if (!stack) return;
    var el = document.createElement('div');
    el.className = 'toast' + (kind ? ' ' + kind : '');
    el.innerHTML = '<i></i><span>' + esc(msg) + '</span>';
    stack.appendChild(el);
    setTimeout(function () {
      el.classList.add('is-out');
      setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 340);
    }, 2600);
  }

  /* ---------------- 自定义日历选择器 ---------------- */
  var dp = { open: false, view: 'days', year: 2026, month: 11, selected: '' };
  function todayStr() {
    var d = new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }
  function dateKey(d) {
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }
  function setDateValue(s) {
    var hidden = $('fDate');
    if (hidden) hidden.value = s || '';
    var disp = $('dateDisplay');
    if (disp) disp.textContent = s ? (s + ' · ' + weekLabel(s)) : '选择日期';
    dp.selected = s || '';
    if (s) {
      var m = /^(\d{4})-(\d{2})-\d{2}$/.exec(s);
      if (m) { dp.year = Number(m[1]); dp.month = Number(m[2]); dp.view = 'days'; }
    }
    if (dp.open) renderDp();
  }
  function renderDp() {
    var title = $('dpTitle'), daysBox = $('dpDays'), monthsBox = $('dpMonths');
    if (!title || !daysBox || !monthsBox) return;
    title.textContent = dp.view === 'days' ? (dp.year + '年 ' + dp.month + '月') : (dp.year + '年 · 选择月份');
    daysBox.hidden = dp.view !== 'days';
    monthsBox.hidden = dp.view !== 'months';
    if (dp.view === 'months') {
      monthsBox.innerHTML = MONTH_CN.map(function (n, i) {
        return '<button type="button" class="dp-month' + (i + 1 === dp.month ? ' is-active' : '') + '" data-month="' + (i + 1) + '">' + n + '</button>';
      }).join('');
      return;
    }
    var first = new Date(dp.year, dp.month - 1, 1);
    var offset = first.getDay();
    var daysInMonth = new Date(dp.year, dp.month, 0).getDate();
    var count = Math.ceil((offset + daysInMonth) / 7) * 7;
    var today = todayStr();
    var html = '';
    for (var i = 0; i < count; i++) {
      var d = new Date(dp.year, dp.month - 1, 1 - offset + i);
      var key = dateKey(d);
      var cls = 'dp-day';
      if (d.getMonth() !== dp.month - 1) cls += ' is-other';
      if (key === today) cls += ' is-today';
      if (key === dp.selected) cls += ' is-selected';
      html += '<button type="button" class="' + cls + '" data-date="' + key + '" aria-label="' + key + '">' + d.getDate() + '</button>';
    }
    var grid = $('dpGrid');
    if (grid) grid.innerHTML = html;
  }
  function openDp() {
    var pop = $('datePop'), field = $('dateField');
    if (!pop || !field) return;
    dp.open = true;
    pop.hidden = false;
    field.classList.add('is-open');
    field.setAttribute('aria-expanded', 'true');
    renderDp();
    var rect = field.getBoundingClientRect();
    var h = pop.offsetHeight;
    if (rect.bottom + 8 + h > window.innerHeight - 12) {
      pop.style.top = 'auto'; pop.style.bottom = 'calc(100% + 8px)';
    } else {
      pop.style.top = 'calc(100% + 8px)'; pop.style.bottom = 'auto';
    }
  }
  function closeDp() {
    var pop = $('datePop'), field = $('dateField');
    dp.open = false;
    if (pop) pop.hidden = true;
    if (field) { field.classList.remove('is-open'); field.setAttribute('aria-expanded', 'false'); }
  }
  function shiftDp(delta) {
    if (dp.view === 'months') {
      dp.year += delta;
    } else {
      dp.month += delta;
      if (dp.month < 1) { dp.month = 12; dp.year -= 1; }
      else if (dp.month > 12) { dp.month = 1; dp.year += 1; }
    }
    renderDp();
  }
  function bindDatePicker() {
    var field = $('dateField'), wrap = $('dateWrap');
    if (!field || !wrap) return;
    field.addEventListener('click', function (e) {
      e.stopPropagation();
      if (dp.open) closeDp(); else openDp();
    });
    if ($('dpPrev')) $('dpPrev').addEventListener('click', function () { shiftDp(-1); });
    if ($('dpNext')) $('dpNext').addEventListener('click', function () { shiftDp(1); });
    if ($('dpTitle')) $('dpTitle').addEventListener('click', function () {
      dp.view = dp.view === 'days' ? 'months' : 'days';
      renderDp();
    });
    var grid = $('dpGrid');
    if (grid) grid.addEventListener('click', function (e) {
      var b = e.target.closest('button[data-date]');
      if (!b) return;
      var key = b.dataset.date;
      var m = /^(\d{4})-(\d{2})/.exec(key);
      if (m) { dp.year = Number(m[1]); dp.month = Number(m[2]); }
      setDateValue(key);
      closeDp();
      field.focus();
    });
    var months = $('dpMonths');
    if (months) months.addEventListener('click', function (e) {
      var b = e.target.closest('button[data-month]');
      if (!b) return;
      dp.month = Number(b.dataset.month);
      dp.view = 'days';
      renderDp();
    });
    if ($('dpToday')) $('dpToday').addEventListener('click', function () {
      setDateValue(todayStr()); closeDp(); field.focus();
    });
    if ($('dpClose')) $('dpClose').addEventListener('click', function () { closeDp(); });
    document.addEventListener('click', function (e) {
      if (dp.open && !wrap.contains(e.target)) closeDp();
    });
    document.addEventListener('keydown', function (e) {
      if (!dp.open || !wrap.contains(document.activeElement)) return;
      var step = ({ ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 })[e.key];
      if (step === undefined) return;
      e.preventDefault();
      var base = dp.selected ? new Date(dp.selected + 'T00:00:00') : new Date();
      if (isNaN(base.getTime())) base = new Date();
      base.setDate(base.getDate() + step);
      setDateValue(dateKey(base));
    });
  }

  /* ---------------- 弹窗：记账 ---------------- */
  function fillCategoryOptions() {
    var sel = $('fCategory');
    if (!sel) return;
    var cats = state.entryType === 'income' ? INCOME_CATS : EXPENSE_CATS;
    var cur = sel.value;
    sel.innerHTML = cats.map(function (c) { return '<option value="' + esc(c) + '">' + esc(c) + '</option>'; }).join('');
    if (cats.indexOf(cur) !== -1) sel.value = cur;
    fillSubOptions();
  }
  function fillSubOptions(preferred) {
    var sel = $('fSub');
    if (!sel) return;
    var cat = ($('fCategory') && $('fCategory').value) || (state.entryType === 'income' ? '收入' : '餐饮');
    var names = subCatNames(cat);
    sel.innerHTML = '<option value="">自动识别</option>' + names.map(function (n) {
      return '<option value="' + esc(n) + '">' + esc(n) + '</option>';
    }).join('');
    if (preferred && names.indexOf(preferred) !== -1) sel.value = preferred;
    updateSubHint();
  }
  /* 子类留空时，实时回显"会被归到哪"——不选也能看见结果 */
  function updateSubHint() {
    var sel = $('fSub'), note = $('fSubNote');
    if (!sel || !note) return;
    if (sel.value) {
      note.textContent = '已手动指定';
      note.classList.remove('is-auto');
      return;
    }
    var cat = ($('fCategory') && $('fCategory').value) || '餐饮';
    var guess = guessSub(cat, ($('fNote') && $('fNote').value) || '');
    note.textContent = '将自动归入「' + guess + '」';
    note.classList.add('is-auto');
  }
  function setEntryType(t) {
    state.entryType = t === 'income' ? 'income' : 'expense';
    var box = $('typeToggle');
    if (box) {
      var bs = box.querySelectorAll('button[data-type]');
      for (var i = 0; i < bs.length; i++) bs[i].classList.toggle('is-active', bs[i].dataset.type === state.entryType);
    }
    fillCategoryOptions();
  }
  function openModal(record, prefillDate) {
    lastFocused = document.activeElement;
    state.editingId = record ? record.id : null;
    if ($('modalTitle')) $('modalTitle').textContent = record ? '编辑记录' : '记一笔';
    if ($('modalDesc')) $('modalDesc').textContent = record ? '修改后即时更新所有图表与统计。' : '记录一条新的收支流水';
    if ($('modalSave')) $('modalSave').textContent = record ? '保存修改' : '保存记录';
    if ($('modalDelete')) $('modalDelete').hidden = !record;
    setEntryType(record ? record.type : 'expense');
    if ($('fAmount')) $('fAmount').value = record ? String(record.amount) : '';
    setDateValue(record ? record.date : (prefillDate || todayStr()));
    closeDp();
    if ($('fNote')) $('fNote').value = record ? record.note : '';
    var sel = $('fCategory');
    if (sel) {
      if (record) {
        var wanted = record.category;
        var found = false;
        for (var i = 0; i < sel.options.length; i++) if (sel.options[i].value === wanted) { sel.selectedIndex = i; found = true; break; }
        if (!found) { sel.add(new Option(wanted, wanted)); sel.value = wanted; }
      } else {
        sel.selectedIndex = 0;
      }
    }
    /* 只有显式存过子类的记录才回填选择；旧账留「自动识别」并实时显示推断结果 */
    fillSubOptions(record && record.subExplicit ? record.sub : '');
    if ($('formError')) { $('formError').hidden = true; $('formError').textContent = ''; }
    var back = $('modalBackdrop');
    if (back) back.hidden = false;
    setTimeout(function () { if ($('fAmount')) $('fAmount').focus(); }, 120);
  }
  function closeModal() {
    var back = $('modalBackdrop');
    closeDp();
    if (back) back.hidden = true;
    state.editingId = null;
    if ($('modalDelete')) $('modalDelete').hidden = true;
    if (lastFocused && typeof lastFocused.focus === 'function') lastFocused.focus();
    lastFocused = null;
  }
  function submitEntry(e) {
    e.preventDefault();
    var amount = Number($('fAmount') && $('fAmount').value);
    var date = $('fDate') && $('fDate').value;
    var err = $('formError');
    function fail(msg) { if (err) { err.textContent = msg; err.hidden = false; } }
    if (!isFinite(amount) || amount <= 0) { fail('请输入大于 0 的金额。'); return; }
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) { fail('请选择有效日期。'); return; }
    var rawNote = (($('fNote') && $('fNote').value) || '').trim();
    var rec = {
      id: state.editingId || ('u' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7)),
      date: date, type: state.entryType,
      category: ($('fCategory') && $('fCategory').value) || (state.entryType === 'income' ? '收入' : '娱乐'),
      note: canonNote(rawNote),
      amount: round(amount)
    };
    /* 子类：选了就用选的，留空交给关键词匹配 */
    var subSel = $('fSub');
    if (subSel && subSel.value) { rec.sub = subSel.value; rec.subExplicit = true; }
    if (!rec.note) rec.note = rec.category;
    if (state.editingId) {
      state.store.edited[state.editingId] = rec;
      toast('已更新「' + rec.note + '」', 'info');
    } else {
      state.store.added.push(rec);
      toast('已记下 ' + fmtYuan(rec.amount), 'success');
    }
    saveStore();
    closeModal();
    renderAll();
  }

  /* ---------------- 弹窗：删除确认 ---------------- */
  function openConfirm(id) {
    state.pendingDeleteId = id;
    var rec = allRecords().filter(function (r) { return r.id === id; })[0];
    if ($('confirmDesc') && rec) $('confirmDesc').textContent = rec.date + ' · ' + rec.note + ' · ' + fmtYuan(rec.amount) + '，删除后可从「恢复初始数据」找回。';
    var back = $('confirmBackdrop');
    if (back) back.hidden = false;
  }
  function closeConfirm() {
    var back = $('confirmBackdrop');
    if (back) back.hidden = true;
    state.pendingDeleteId = null;
  }
  function confirmDelete() {
    var id = state.pendingDeleteId;
    if (!id) return;
    if (state.store.deleted.indexOf(id) === -1) state.store.deleted.push(id);
    state.store.added = state.store.added.filter(function (r) { return r.id !== id; });
    if (state.store.edited[id]) delete state.store.edited[id];
    saveStore();
    closeConfirm();
    closeModal();
    renderAll();
    toast('记录已删除', 'warn');
  }

  /* ---------------- 导出 CSV ---------------- */
  function csvCell(s) { return '"' + String(s === null || s === undefined ? '' : s).replace(/"/g, '""') + '"'; }
  function exportCsv() {
    var rows = boardRecords();
    if (!rows.length) { toast('当前范围内没有可导出的记录', 'warn'); return; }
    var lines = ['日期,分类,子类,项目备注,类型,金额'];
    rows.forEach(function (r) {
      lines.push([csvCell(r.date), csvCell(r.category), csvCell(r.sub), csvCell(r.note), r.type === 'income' ? '收入' : '支出', r.amount.toFixed(2)].join(','));
    });
    var b = rangeBounds();
    var tag = state.scale === 'day' ? dateKey(b.from)
      : state.scale === 'year' ? String(state.calMonth.year)
        : state.scale === 'week' ? dateKey(b.from) + '_' + dateKey(b.to)
          : state.calMonth.year + '-' + pad2(state.calMonth.month);
    var blob = new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = '轻账_' + tag + '.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    toast('已导出 ' + rows.length + ' 条记录', 'success');
  }

  /* ---------------- 事件绑定 ---------------- */
  function buildSelectOptions() {
    var chips = $('catChips');
    if (chips) {
      chips.innerHTML = '<button type="button" class="chip is-active" data-cat="all">全部分类</button>' +
        ALL_CATS.map(function (c) { return '<button type="button" class="chip" data-cat="' + esc(c) + '">' + esc(c) + '</button>'; }).join('');
    }
  }
  function syncChips() {
    var box = $('catChips');
    if (!box) return;
    var bs = box.querySelectorAll('button[data-cat]');
    for (var i = 0; i < bs.length; i++) bs[i].classList.toggle('is-active', bs[i].dataset.cat === state.filters.category);
  }

  function applyTheme(t, deferCharts) {
    state.theme = t;
    document.documentElement.setAttribute('data-theme', t);
    try { localStorage.setItem(THEME_KEY, t); } catch (e) { /* noop */ }
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', t === 'dark' ? '#0d121c' : '#f5f7fa');
    if (!deferCharts) renderCharts(state.view, 'instant');
  }

  /* 换肤：一帧内换完 token + 图表配色，动的只有一个合成层光斑。
     旧方案走 View Transitions：整页截图两次 + clip-path 圆形擦除。
     clip-path 不是合成动画，每帧都要把整页快照重新裁剪栅格化，
     窗口一大就是成片的掉帧，调时长救不回来，所以整条路拆掉。
     现在这里没有快照、没有布局读写、没有 per-frame 样式写入：
     换色同步完成，"动"的部分只有 .theme-orb 的 transform / opacity。 */
  function themeLayer(cls, id) {
    var el = document.getElementById(id);
    if (!el) {
      el = document.createElement('div');
      el.id = id;
      el.className = cls;
      el.setAttribute('aria-hidden', 'true');
      document.body.appendChild(el);
    }
    return el;
  }
  function setTheme(t, x, y) {
    if (t === state.theme || state.themeAnimating) return;
    var cx = (typeof x === 'number' && x > 0) ? x : window.innerWidth - 46;
    var cy = (typeof y === 'number' && y > 0) ? y : 40;

    /* 1) token 与图表同帧换完：不经过任何中间态，也就没有残影可闪 */
    state.themeAnimating = true;
    try {
      applyTheme(t, true);
      renderCharts(state.view, 'instant');
    } finally {
      /* 2) 光斑 + 扩散环从点击点散开：两层都只改 transform / opacity，
            全程留在合成层，主线程一帧都不用等 */
      var orb = themeLayer('theme-orb', 'themeOrb');
      var ring = themeLayer('theme-ring', 'themeRing');
      var layers = [orb, ring];
      for (var i = 0; i < layers.length; i++) {
        var el = layers[i];
        el.style.left = cx + 'px';
        el.style.top = cy + 'px';
        el.classList.remove('is-on');
        void el.offsetWidth;
      }
      orb.classList.add('is-on');
      ring.classList.add('is-on');
      window.clearTimeout(setTheme._t);
      setTheme._t = window.setTimeout(function () { state.themeAnimating = false; }, 420);
    }
  }

  function bindEvents() {
    var navs = document.querySelectorAll('.nav-item');
    for (var i = 0; i < navs.length; i++) {
      navs[i].addEventListener('click', function () { setView(this.dataset.view); });
    }

    bindSeg($('yearSwitch'), 'data-year', function (v) {
      state.year = v;
      if (/^\d{4}$/.test(v)) {
        state.calendarYear = Number(v);
        setSegActive($('calendarYear'), 'data-cy', v);
        if (state.calMonth.year !== Number(v)) {
          state.calMonth = { year: Number(v), month: state.calMonth.month };
          state.focusDate = '';
        }
      }
      renderAll();
    });
    bindSeg($('trendScope'), 'data-scope', function (v) {
      state.trendScope = v;
      var sub = $('trendSub');
      if (sub) sub.textContent = ({ both: '按自然月汇总', expense: '仅显示支出', income: '仅显示收入' })[v];
      renderTrend(palette());
    });
    bindSeg($('compareMetric'), 'data-metric', function (v) {
      state.compareMetric = v;
      renderCompare(palette());
    });
    bindSeg($('calendarYear'), 'data-cy', function (v) {
      state.calendarYear = Number(v);
      renderCalendar(palette());
    });
    bindSeg($('annualScope'), 'data-ay', function (v) {
      state.annualScope = v === 'both' ? 'both' : v;
      renderAnnual(palette());
    });

    if ($('themeBtn')) $('themeBtn').addEventListener('click', function (e) {
      var r = this.getBoundingClientRect();
      setTheme(state.theme === 'dark' ? 'light' : 'dark', e.clientX || (r.left + r.width / 2), e.clientY || (r.top + r.height / 2));
    });

    if ($('resetBtn')) $('resetBtn').addEventListener('click', function () {
      state.store = { added: [], edited: {}, deleted: [] };
      saveStore();
      renderAll();
      toast('已恢复到两份原始账单数据', 'info');
    });

    /* 概览条格子 → 跳转（本身就是 button，回车/空格天然可用） */
    var kpis = document.querySelectorAll('.stat-cell[data-jump]');
    for (var k = 0; k < kpis.length; k++) {
      kpis[k].addEventListener('click', function () { jumpFromKpi(this.dataset.jump); });
    }

    /* 表单 */
    var form = $('entryForm');
    if (form) form.addEventListener('submit', submitEntry);
    if ($('typeToggle')) $('typeToggle').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-type]');
      if (b) setEntryType(b.dataset.type);
    });
    if ($('fCategory')) $('fCategory').addEventListener('change', function () { fillSubOptions(); });
    if ($('fSub')) $('fSub').addEventListener('change', updateSubHint);
    if ($('fNote')) $('fNote').addEventListener('input', updateSubHint);
    if ($('modalClose')) $('modalClose').addEventListener('click', closeModal);
    if ($('modalCancel')) $('modalCancel').addEventListener('click', closeModal);
    if ($('modalDelete')) $('modalDelete').addEventListener('click', function () {
      if (state.editingId) openConfirm(state.editingId);
    });
    if ($('modalBackdrop')) $('modalBackdrop').addEventListener('click', function (e) { if (e.target === this) closeModal(); });
    if ($('confirmCancel')) $('confirmCancel').addEventListener('click', function () { closeConfirm(); });
    if ($('confirmOk')) $('confirmOk').addEventListener('click', confirmDelete);
    if ($('confirmBackdrop')) $('confirmBackdrop').addEventListener('click', function (e) { if (e.target === this) closeConfirm(); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        if (dp.open) { closeDp(); return; }
        if (cmpOpen) { closeCmp(); return; }
        if ($('dayPop') && !$('dayPop').hidden) { closeDayPop(); return; }
        if (!$('confirmBackdrop').hidden) { closeConfirm(); return; }
        closeModal();
      }
    });

    /* 日历：粒度 / 步进 / 筛选 / 交互 */
    bindSeg($('scaleSeg'), 'data-scale', function (v) { setScale(v); });
    if ($('calPrev')) $('calPrev').addEventListener('click', function () { closeCmp(); shiftCalStep(-1); });
    if ($('calNext')) $('calNext').addEventListener('click', function () { closeCmp(); shiftCalStep(1); });
    if ($('calToday')) $('calToday').addEventListener('click', function () {
      var d = new Date();
      setAnchor(d);
      state.focusDate = '';
      renderBoard(); renderCharts('calendar');
    });
    /* 工具条里不再重复放一个"记一笔"：顶栏那个一直都在，
       在日历页时把它的默认日期接到当前视图上 */
    if ($('addBtn')) $('addBtn').addEventListener('click', function () {
      openModal(null, state.view === 'calendar' ? defaultAddDate() : '');
    });
    if ($('calTitle')) $('calTitle').addEventListener('click', function (e) {
      e.stopPropagation();
      if (cmpOpen) closeCmp(); else openCmp();
    });
    if ($('cmpPrev')) $('cmpPrev').addEventListener('click', function () { cmpYear -= 1; renderCmp(); });
    if ($('cmpNext')) $('cmpNext').addEventListener('click', function () { cmpYear += 1; renderCmp(); });
    var cmpMonths = $('cmpMonths');
    if (cmpMonths) cmpMonths.addEventListener('click', function (e) {
      var b = e.target.closest('button[data-month]');
      if (!b) return;
      setCalMonth(cmpYear, Number(b.dataset.month));
      closeCmp();
    });
    document.addEventListener('click', function (e) {
      if (!cmpOpen) return;
      var t = $('calTitle'), pop = $('calMonthPop');
      if ((t && t.contains(e.target)) || (pop && pop.contains(e.target))) return;
      closeCmp();
    });

    if ($('searchInput')) $('searchInput').addEventListener('input', debounce(function (e) {
      state.filters.q = e.target.value; renderBoard();
    }, 180));
    bindSeg($('typeSeg'), 'data-type', function (v) {
      state.filters.type = v;
      if (v === 'income' && state.filters.category !== 'all' && state.filters.category !== '收入') {
        state.filters.category = 'all';
        state.filters.sub = 'all';
      }
      syncFilterUI(); renderBoard();
    });
    var chips = $('catChips');
    if (chips) chips.addEventListener('click', function (e) {
      var b = e.target.closest('button[data-cat]');
      if (!b) return;
      state.filters.category = b.dataset.cat;
      state.filters.sub = 'all';
      if (state.filters.type === 'income' && b.dataset.cat !== 'all' && b.dataset.cat !== '收入') state.filters.type = 'all';
      syncFilterUI(); renderBoard();
    });
    /* 分类 / 子类筛选条（日历上方） */
    /* 分类 / 子类筛选条（日历工具条里的 .ct-chips）。
       上一版绑在 .cat-bar 上，那个容器在合并成一行工具条时已经删掉，
       于是子类按钮点下去毫无反应——这次绑真实容器。 */
    var catBar = document.querySelector('.ct-chips');
    if (catBar) catBar.addEventListener('click', function (e) {
      var c = e.target.closest('button[data-cat]');
      if (c) {
        state.filters.category = c.dataset.cat;
        state.filters.sub = 'all';
        if (state.filters.type === 'income' && c.dataset.cat !== 'all' && c.dataset.cat !== '收入') state.filters.type = 'all';
        syncFilterUI(); renderBoard();
        return;
      }
      var s = e.target.closest('button[data-sub]');
      if (s) {
        state.filters.sub = (state.filters.sub === s.dataset.sub || s.dataset.sub === 'all') ? 'all' : s.dataset.sub;
        syncFilterUI(); renderBoard();
      }
    });
    if ($('weekdayChip')) $('weekdayChip').addEventListener('click', function () {
      state.filters.weekday = 'all'; syncFilterUI(); renderBoard();
    });
    if ($('subChip')) $('subChip').addEventListener('click', function () {
      state.filters.sub = 'all'; syncFilterUI(); renderBoard();
    });
    function resetBoardFilters() {
      state.filters = { q: '', type: 'all', category: 'all', sub: 'all', weekday: 'all' };
      state.focusDate = '';
      syncFilterUI(); renderBoard();
    }
    if ($('resetFilters')) $('resetFilters').addEventListener('click', function () {
      resetBoardFilters(); toast('筛选条件已重置', 'info');
    });
    if ($('boardReset')) $('boardReset').addEventListener('click', resetBoardFilters);
    if ($('exportBtn')) $('exportBtn').addEventListener('click', exportCsv);

    /* 当日明细浮层的开关 */
    if ($('dayMask')) $('dayMask').addEventListener('click', closeDayPop);
    if ($('dayPopClose')) $('dayPopClose').addEventListener('click', closeDayPop);
    if ($('dayPopAdd')) $('dayPopAdd').addEventListener('click', function () {
      var k = dayPopKey;
      closeDayPop();
      openModal(null, k || todayStr());
    });
    if ($('dayPopList')) $('dayPopList').addEventListener('click', function (e) {
      var b = e.target.closest('[data-day-id]');
      if (!b) return;
      var rec = allRecords().filter(function (r) { return r.id === b.dataset.dayId; })[0];
      if (!rec) return;
      closeDayPop();
      openModal(rec);
    });


    /* 棋盘：条目 / 空格 / 更多 / 年视图小格 —— 全部走一张委托表 */
    var boardEl = document.querySelector('.cal-board');
    if (boardEl) boardEl.addEventListener('click', function (e) {
      var more = e.target.closest('[data-more]');
      if (more) { openDayPop(more.dataset.more); return; }

      var ymHead = e.target.closest('.ym-head[data-month]');
      if (ymHead) { gotoMonth(state.calMonth.year, Number(ymHead.dataset.month)); return; }

      var ym = e.target.closest('.ym-day[data-date]');
      if (ym) { jumpToDay(ym.dataset.date); return; }

      var add = e.target.closest('[data-add]');
      if (add) { openModal(null, add.dataset.add); return; }

      var item = e.target.closest('[data-id]');
      if (item) {
        var rec = allRecords().filter(function (r) { return r.id === item.dataset.id; })[0];
        if (rec) openModal(rec);
        return;
      }

      var cell = e.target.closest('.cal-cell[data-date]');
      if (cell && cell.dataset.other === '0') { tapDay(cell.dataset.date); return; }

      var wk = e.target.closest('.wk-col[data-date]');
      if (wk) tapDay(wk.dataset.date);
    });

    /* 分析页：年度卡 → 日历 */
    var annualGrid = $('annualGrid');
    if (annualGrid) annualGrid.addEventListener('click', function (e) {
      var b = e.target.closest('[data-jump-year]');
      if (!b) return;
      var y = Number(b.dataset.jumpYear);
      jumpToDetail({ reset: true, year: y, month: bestMonthOfYear(y), label: '已跳转：' + y + '年' + bestMonthOfYear(y) + '月' });
    });

    /* 点击波纹 */
    document.addEventListener('pointerdown', function (e) {
      var btn = e.target.closest('.btn, .icon-btn, .mini-btn');
      if (!btn) return;
      var r = btn.getBoundingClientRect();
      var s = Math.max(r.width, r.height);
      var span = document.createElement('span');
      span.className = 'ripple';
      span.style.width = span.style.height = s + 'px';
      span.style.left = (e.clientX - r.left - s / 2) + 'px';
      span.style.top = (e.clientY - r.top - s / 2) + 'px';
      btn.appendChild(span);
      setTimeout(function () { if (span.parentNode) span.parentNode.removeChild(span); }, 640);
    });

    window.addEventListener('resize', debounce(function () {
      resizeAll();
      renderCharts(state.view);
      /* 每格能放几条随高度变，窗口一变就得重排棋盘 */
      if (state.view === 'calendar') renderBoard();
    }, 160));
  }

  /* ---------------- 当日明细浮层 ----------------
     格子是扫描用的，不是归档用的。装不下的那截不该被裁掉，
     所以点格子直接把这天摊开：大字号、全部条目、点一行就能改。 */
  var dayPopKey = '';
  function tapDay(key) {
    var rows = allRecords().filter(function (r) { return r.date === key; });
    if (!rows.length) { openModal(null, key); return; }
    openDayPop(key);
  }
  function openDayPop(key) {
    var pop = $('dayPop'), mask = $('dayMask');
    if (!pop || !mask) return;
    dayPopKey = key;
    var p = palette();
    var d = new Date(key + 'T00:00:00');
    var rows = allRecords().filter(function (r) { return r.date === key; });
    rows.sort(function (a, b) {
      if (a.type !== b.type) return a.type === 'income' ? -1 : 1;
      return b.amount - a.amount;
    });
    var de = 0, di = 0;
    rows.forEach(function (r) { if (r.type === 'income') di += r.amount; else de += r.amount; });
    de = round(de); di = round(di);
    var net = round(di - de);

    if ($('dayPopTitle')) $('dayPopTitle').textContent = (d.getMonth() + 1) + '月' + d.getDate() + '日 · ' + WEEKDAYS[(d.getDay() + 6) % 7];
    if ($('dayPopSub')) $('dayPopSub').textContent = key + ' · 共 ' + rows.length + ' 笔';
    if ($('dayPopExp')) $('dayPopExp').textContent = fmtBig(de);
    if ($('dayPopInc')) $('dayPopInc').textContent = fmtBig(di);
    if ($('dayPopNet')) $('dayPopNet').textContent = (net < 0 ? '−' : '') + fmtBig(Math.abs(net));

    var html = rows.map(function (r) {
      var c = r.type === 'income' ? p.income : catColor(p, r.category);
      var ink = catInk(p, c);
      var label = r.note || r.sub;
      return '<button type="button" class="day-row2" data-day-id="' + esc(r.id) + '" style="--c:' + c + ';--ink:' + ink + '">' +
        '<span class="dr2-dot">' + esc(String(r.sub || r.category).slice(0, 1)) + '</span>' +
        '<span class="dr2-mid"><b class="dr2-note">' + esc(label) + '</b>' +
        '<i class="dr2-sub">' + esc(r.category) + ' / ' + esc(r.sub) + '</i></span>' +
        '<b class="dr2-amt ' + (r.type === 'income' ? 'pos' : 'neg') + '">' + (r.type === 'income' ? '+' : '−') + fmtChip(r.amount) + '</b>' +
        '</button>';
    }).join('');
    if (!html) html = '<div class="day-pop-empty">这一天还没有记录</div>';
    if ($('dayPopList')) $('dayPopList').innerHTML = html;

    mask.hidden = false;
    pop.hidden = false;
    if ($('dayPopList')) $('dayPopList').scrollTop = 0;
    if ($('dayPopClose')) $('dayPopClose').focus();
  }
  function closeDayPop() {
    if ($('dayPop')) $('dayPop').hidden = true;
    if ($('dayMask')) $('dayMask').hidden = true;
    dayPopKey = '';
  }


  function jumpFromKpi(kind) {
    if (kind === 'income') { jumpToDetail({ reset: true, type: 'income', label: '已筛选：全部收入' }); return; }
    if (kind === 'expense') { jumpToDetail({ reset: true, type: 'expense', label: '已筛选：全部支出' }); return; }
    if (kind === 'rate') { setView('analysis'); toast('已打开年度分析', 'info'); return; }
    jumpToDetail({ reset: true, label: '已跳转日历' });
  }

  /* ---------------- 启动 ---------------- */
  function init() {
    state.store = loadStore();
    var saved = null;
    try { saved = localStorage.getItem(THEME_KEY); } catch (e) { /* noop */ }
    state.theme = (saved === 'dark' || saved === 'light') ? saved : 'light';
    document.documentElement.setAttribute('data-theme', state.theme);
    state.anchorDate = todayStr();
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', state.theme === 'dark' ? '#0d121c' : '#f5f7fa');

    buildSelectOptions();
    bindEvents();
    bindDatePicker();
    setSegActive($('scaleSeg'), 'data-scale', state.scale);
    renderAll();

    /* 深链优先：地址栏带 #/calendar 就直接开到日历，否则补上 #/home */
    var initialRoute = parseRoute();
    bindRoute();
    if (initialRoute && initialRoute !== state.view) setView(initialRoute);
    else writeRoute(state.view, true);

    if (!hasEcharts) toast('ECharts 未加载，图表不可用', 'warn');
    requestAnimationFrame(function () {
      setTimeout(function () {
        var veil = $('bootVeil');
        if (veil) veil.classList.add('is-done');
      }, 420);
    });
  }

  /* ---------------- 对外挂钩（assets/sync.js 用） ----------------
     同步层不碰内部结构，只通过这几个方法读一份快照、灌一份快照。 */
  window.QZ = {
    getStore: function () {
      return {
        added: state.store.added,
        edited: state.store.edited,
        deleted: state.store.deleted,
        theme: document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light'
      };
    },
    setStore: function (s) {
      s = s || {};
      state.store = {
        added: Array.isArray(s.added) ? s.added : [],
        edited: (s.edited && typeof s.edited === 'object' && !Array.isArray(s.edited)) ? s.edited : {},
        deleted: Array.isArray(s.deleted) ? s.deleted : []
      };
      saveStore();
      renderAll();
    },
    theme: function () {
      return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
    },
    setTheme: function (t) { if (t === 'dark' || t === 'light') setTheme(t); },
    onStoreChange: function (fn) { if (typeof fn === 'function') STORE_HOOKS.push(fn); },
    toast: toast
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
