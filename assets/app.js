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
  /* 原始 xlsx 里的体重与拼音表：体重作为种子值，用户记录覆盖；拼音只服务搜索 */
  var SEED_WEIGHTS = (window.BILL_DATA && window.BILL_DATA.weights && typeof window.BILL_DATA.weights === 'object')
    ? window.BILL_DATA.weights : {};
  var PY_MAP = (window.BILL_DATA && window.BILL_DATA.pinyin && typeof window.BILL_DATA.pinyin === 'object')
    ? window.BILL_DATA.pinyin : {};
  var STORE_KEY = 'qingzhang.ledger.v1';
  var THEME_KEY = 'qingzhang.theme.v1';
  var CATCOLOR_KEY = 'qingzhang.catcolors.v1';
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
  /* 反向别名：「早餐」也要能被「早饭 / zaofan」搜到 */
  var ALIAS_REV = (function () {
    var m = {};
    Object.keys(NOTE_ALIAS).forEach(function (a) {
      var k = NOTE_ALIAS[a];
      if (!m[k]) m[k] = [];
      m[k].push(a);
    });
    return m;
  })();

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
    view: 'calendar',
    year: 'all',
    theme: 'light',
    scale: 'month',
    calMonth: { year: 2026, month: 11 },
    anchorDate: '',
    focusDate: '',
    trendScope: 'both',
    calendarYear: Y_LAST,
    annualScope: 'both',
    filters: { q: '', type: 'all', category: 'all', sub: 'all', weekday: 'all', amount: 'all', quick: '' },
    editingId: null,
    entryType: 'expense',
    pendingDeleteId: null,
    store: { added: [], edited: {}, deleted: [], weights: {}, weightCleared: [] },
    catColors: {},
    layout: null
  };

  var charts = {};
  /* 状态每次落盘后的回调，云同步层（assets/sync.js）靠它知道"本地改了" */
  var STORE_HOOKS = [];
  /* 数据版本：任何一次落盘 +1。「关于这一天」用它判断内容是否真变了，
     没变就复用原来的 DOM，不再重播入场动画 —— 这是消除自动闪烁的关键。 */
  var storeRev = 0;
  var lastFocused = null;
  var lastTrendRows = [], lastBalanceRows = [], lastStackRows = [], lastTopRows = [], lastSideTrendRows = [];
  /* 总览与分析已合并进同一页；导航只剩两个入口，默认落在日历。 */
  var VIEW_META = {
    overview: ['总览', '收支总览 + 年度分析，汇总在同一页。'],
    calendar: ['日历', '一个月的所有流水，尽在一页日历。点格子进当日明细。']
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

  /* ---------------- 分类配色自定义 ----------------
     五个支出分类 + 收入，各挂一个 CSS 变量。palette() 每次都从 CSS 变量读，
     所以覆盖值只要写回 :root，图表、筛选滑块、明细条会一起换色。
     读写都走 localStorage，刷新/换设备（同浏览器）都记得。 */
  var CAT_COLOR_DEFS = [
    { key: '餐饮', name: '餐饮', css: '--cat-food', def: '#ffd5d5' },
    { key: '日常', name: '日常', css: '--cat-daily', def: '#9bc2e6' },
    { key: '交通', name: '交通', css: '--cat-travel', def: '#f0a52a' },
    { key: '服饰', name: '服饰', css: '--cat-wear', def: '#8b5cf6' },
    { key: '娱乐', name: '娱乐', css: '--cat-fun', def: '#ffe699' },
    { key: '收入', name: '收入', css: '--income', def: '#e04a4a' }
  ];
  function toHex(c) {
    var rgb = parseColor(c);
    if (!rgb) return '#000000';
    function h2(n) { n = Math.max(0, Math.min(255, n | 0)).toString(16); return n.length < 2 ? '0' + n : n; }
    return '#' + h2(rgb[0]) + h2(rgb[1]) + h2(rgb[2]);
  }
  function loadCatColors() {
    var raw = null;
    try { raw = localStorage.getItem(CATCOLOR_KEY); } catch (e) { /* noop */ }
    var m = {};
    if (raw) {
      try {
        var j = JSON.parse(raw);
        CAT_COLOR_DEFS.forEach(function (d) {
          var v = j && j[d.key];
          if (typeof v === 'string' && parseColor(v)) m[d.key] = toHex(v);
        });
      } catch (e) { /* noop */ }
    }
    state.catColors = m;
    applyCatColors();
  }
  function applyCatColors() {
    var root = document.documentElement;
    CAT_COLOR_DEFS.forEach(function (d) {
      var v = state.catColors[d.key];
      if (v) root.style.setProperty(d.css, v);
      else root.style.removeProperty(d.css);
    });
  }
  function saveCatColors() {
    try { localStorage.setItem(CATCOLOR_KEY, JSON.stringify(state.catColors)); } catch (e) { /* noop */ }
  }
  function catColorNow(key) {
    var d = CAT_COLOR_DEFS.filter(function (x) { return x.key === key; })[0];
    if (!d) return '#000000';
    if (state.catColors[key]) return state.catColors[key];
    var cs = getComputedStyle(document.documentElement);
    return toHex((cs.getPropertyValue(d.css) || '').trim() || d.def);
  }
  function setCatColor(key, hex) {
    if (!parseColor(hex)) return;
    state.catColors[key] = toHex(hex);
    applyCatColors();
    saveCatColors();
    refreshAfterColor();
  }
  /* 换色后所有依赖分类色的东西都要重画：图表、筛选滑块、明细条、总览统计 */
  function refreshAfterColor() {
    renderCharts(state.view, 'instant');
    if (state.view === 'calendar') renderBoard();
    renderKpis();
    renderOvMetrics();
  }
  function buildColorRows() {
    var box = $('cpRows');
    if (!box) return;
    box.innerHTML = CAT_COLOR_DEFS.map(function (d, i) {
      var hex = catColorNow(d.key);
      var rgb = parseColor(hex) || [0, 0, 0];
      return '<div class="cp-row" data-cp="' + esc(d.key) + '">' +
        '<span class="cp-swatch" style="background:' + hex + '">' +
        '<input type="color" value="' + hex + '" data-cp-pick aria-label="' + esc(d.name) + '取色"></span>' +
        '<span class="cp-name">' + esc(d.name) + '</span>' +
        '<div class="cp-fields">' +
        '<label>HEX<input type="text" data-cp-hex value="' + hex + '" maxlength="7" spellcheck="false" aria-label="' + esc(d.name) + 'HEX"></label>' +
        '<label>RGB<input type="text" data-cp-rgb value="' + rgb.join(',') + '" maxlength="15" spellcheck="false" aria-label="' + esc(d.name) + 'RGB"></label>' +
        '</div></div>';
    }).join('');
    box.oninput = function (e) {
      var row = e.target.closest('[data-cp]');
      if (!row) return;
      var key = row.getAttribute('data-cp');
      var v = e.target.value.trim();
      if (e.target.hasAttribute('data-cp-pick')) {
        setCatColor(key, v);
        syncColorRow(row, key);
        return;
      }
      var rgb = null;
      if (e.target.hasAttribute('data-cp-hex')) {
        rgb = /^#?[0-9a-f]{6}$/i.test(v) ? parseColor(v.charAt(0) === '#' ? v : '#' + v) : null;
      } else {
        var p = v.split(',').map(function (x) { return parseInt(x, 10); });
        if (p.length === 3 && p.every(function (n) { return isFinite(n) && n >= 0 && n <= 255; })) rgb = p;
      }
      e.target.classList.toggle('is-bad', !rgb);
      if (!rgb) return;
      setCatColor(key, toHex('rgb(' + rgb.join(',') + ')'));
      syncColorRow(row, key);
    };
  }
  function syncColorRow(row, key) {
    var hex = catColorNow(key);
    var rgb = parseColor(hex) || [0, 0, 0];
    var sw = row.querySelector('.cp-swatch');
    if (sw) sw.style.background = hex;
    var pk = row.querySelector('[data-cp-pick]');
    if (pk) pk.value = hex;
    var hx = row.querySelector('[data-cp-hex]');
    if (hx && document.activeElement !== hx) { hx.value = hex; hx.classList.remove('is-bad'); }
    var rg = row.querySelector('[data-cp-rgb]');
    if (rg && document.activeElement !== rg) { rg.value = rgb.join(','); rg.classList.remove('is-bad'); }
  }

  /* ---------------- 数据层 ---------------- */
  function cleanWeights(w) {
    var out = {};
    if (!w || typeof w !== 'object' || Array.isArray(w)) return out;
    Object.keys(w).slice(0, 5000).forEach(function (k) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(k)) return;
      var v = Number(w[k]);
      if (isFinite(v) && v >= 20 && v <= 300) out[k] = Math.round(v * 10) / 10;
    });
    return out;
  }
  function cleanWeightCleared(a) {
    if (!Array.isArray(a)) return [];
    var out = [], seen = {};
    a.slice(0, 5000).forEach(function (k) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(String(k)) && !seen[k]) { seen[k] = 1; out.push(String(k)); }
    });
    return out;
  }
  function emptyStore() { return { added: [], edited: {}, deleted: [], weights: {}, weightCleared: [] }; }
  /* 原始账单里的体重是种子值：本地没有、且没被用户主动删掉的日期才补进来。
     每次同步落盘后再跑一次，云端的快照也不会把种子值冲掉。 */
  function mergeSeedWeights() {
    var s = state.store;
    if (!s) return;
    if (!Array.isArray(s.weightCleared)) s.weightCleared = [];
    var cleared = {};
    s.weightCleared.forEach(function (k) { cleared[k] = 1; });
    Object.keys(SEED_WEIGHTS).forEach(function (k) {
      if (cleared[k] || (s.weights[k] !== undefined && s.weights[k] !== null && s.weights[k] !== '')) return;
      var v = Number(SEED_WEIGHTS[k]);
      if (isFinite(v) && v >= 20 && v <= 300) s.weights[k] = Math.round(v * 10) / 10;
    });
  }
  function loadStore() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (!raw) return emptyStore();
      var o = JSON.parse(raw);
      return {
        added: Array.isArray(o.added) ? o.added : [],
        edited: (o.edited && typeof o.edited === 'object' && !Array.isArray(o.edited)) ? o.edited : {},
        deleted: Array.isArray(o.deleted) ? o.deleted : [],
        weights: cleanWeights(o.weights),
        weightCleared: cleanWeightCleared(o.weightCleared)
      };
    } catch (e) { return emptyStore(); }
  }
  function saveStore() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state.store)); } catch (e) { /* 隐私模式下静默 */ }
    storeRev++;
    NOTE_FREQ = null;
    DAY_COUNT = null;
    for (var i = 0; i < STORE_HOOKS.length; i++) {
      try { STORE_HOOKS[i](); } catch (e) { /* 通知失败不能拖垮记账 */ }
    }
  }
  function canonNote(n) {
    var s = String(n || '').trim();
    if (!s) return s;
    return NOTE_ALIAS[s] || s;
  }
  /* 搜索：中文原名 + 别名（早饭→早餐）+ 全拼 + 首字母，一并塞进检索串。
     翻译只查 data.js 里随数据打包的字符表，离线可用。 */
  function pyOf(s) {
    return String(s || '').toLowerCase().replace(/[\u4e00-\u9fff]/g, function (c) {
      return PY_MAP[c] || '';
    }).replace(/[^a-z0-9]/g, '');
  }
  function initialsOf(s) {
    var out = '';
    String(s || '').replace(/[\u4e00-\u9fff]/g, function (c) {
      var p = PY_MAP[c] || '';
      if (p) out += p.charAt(0);
      return ' ';
    }).split(/[^a-z0-9]+/).forEach(function (w) { if (w) out += w.charAt(0); });
    return out;
  }
  var SEARCH_CACHE = Object.create(null);
  function searchBlob(r) {
    var cacheKey = [r.id, r.date, r.note, r.sub, r.category, r.raw].join('\u0001');
    var hit = SEARCH_CACHE[cacheKey];
    if (hit !== undefined) return hit;
    var parts = [];
    function add(x) { x = String(x || '').trim(); if (x && parts.indexOf(x) === -1) parts.push(x); }
    add(r.note); add(r.sub); add(r.category); add(r.raw); add(r.date);
    var canon = canonNote(r.note);
    add(canon);
    (ALIAS_REV[canon] || []).forEach(add);
    var py = [], ini = [];
    parts.forEach(function (x) {
      var a = pyOf(x), b = initialsOf(x);
      if (a) py.push(a);
      if (b) ini.push(b);
    });
    var text = (parts.join(' ') + ' ' + py.join(' ') + ' ' + ini.join(' ')).toLowerCase();
    SEARCH_CACHE[cacheKey] = text;
    return text;
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
  /* 快捷筛选要的两张频次表：名目出现次数、每天记录条数。
     全量算一次缓存住，saveStore() 里递增 storeRev 时一并清掉。 */
  var NOTE_FREQ = null, DAY_COUNT = null;
  function noteFreqOf(n) {
    if (!NOTE_FREQ) {
      NOTE_FREQ = Object.create(null);
      allRecords().forEach(function (r) {
        var k = canonNote(r.note) || r.sub || '';
        if (k) NOTE_FREQ[k] = (NOTE_FREQ[k] || 0) + 1;
      });
    }
    return NOTE_FREQ[n] || 0;
  }
  function dayCountOf(dt) {
    if (!DAY_COUNT) {
      DAY_COUNT = Object.create(null);
      allRecords().forEach(function (r) { DAY_COUNT[r.date] = (DAY_COUNT[r.date] || 0) + 1; });
    }
    return DAY_COUNT[dt] || 0;
  }
  function matchFilters(r) {
    var f = state.filters;
    var q = f.q.trim().toLowerCase().replace(/[\s'’"-]/g, '');
    var wd = f.weekday;
    if (f.type !== 'all' && r.type !== f.type) return false;
    if (f.category !== 'all' && r.category !== f.category) return false;
    if (f.sub !== 'all' && r.sub !== f.sub) return false;
    /* 星期：数字来自图表点击（0=周一），workday / weekend 来自新增的分段控件 */
    var d = new Date(r.date + 'T00:00:00');
    if (wd && wd !== 'all') {
      var dow = isNaN(d.getTime()) ? -1 : (d.getDay() + 6) % 7;
      if (wd === 'workday' && !(dow >= 0 && dow < 5)) return false;
      else if (wd === 'weekend' && dow < 5) return false;
      else if (/^\d+$/.test(String(wd)) && dow !== Number(wd)) return false;
    }
    /* 金额档位 */
    if (f.amount && f.amount !== 'all') {
      var a = Math.abs(Number(r.amount) || 0);
      if (f.amount === 'small' && a > 20) return false;
      if (f.amount === 'mid' && (a <= 20 || a >= 100)) return false;
      if (f.amount === 'large' && a < 100) return false;
    }
    /* 快捷标签：备注明细的重复度 / 当天的记录密度，跟金额、星期档位都不重叠 */
    if (f.quick) {
      var noteTxt = String(r.note || '').trim();
      if (f.quick === 'hasnote' && !noteTxt) return false;
      if (f.quick === 'nonote' && noteTxt) return false;
      if (f.quick === 'repeat' && noteFreqOf(canonNote(r.note) || r.sub || '') < 3) return false;
      if (f.quick === 'new' && noteFreqOf(canonNote(r.note) || r.sub || '') > 1) return false;
      if (f.quick === 'multi' && dayCountOf(r.date) < 3) return false;
    }
    if (q && searchBlob(r).replace(/[\s'’"-]/g, '').indexOf(q) === -1) return false;
    return true;
  }
  function boardRecords() {
    return sortedDesc(rangeRecords().filter(matchFilters));
  }
  function filtersActive() {
    var f = state.filters;
    return f.category !== 'all' || f.sub !== 'all' || f.type !== 'all' ||
      (f.weekday !== 'all' && f.weekday !== '') || !!f.q.trim() ||
      (f.amount && f.amount !== 'all') || !!f.quick;
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
    fitDaySide();
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

  function syncFilterUI() {
    var f = state.filters;
    if ($('searchInput')) $('searchInput').value = f.q;
    setSegActive($('typeSeg'), 'data-type', f.type);
    setSegActive($('amountSeg'), 'data-amount', f.amount || 'all');
    var ws = $('weekdaySeg');
    if (ws) {
      var numericWd = /^\d+$/.test(String(f.weekday));
      setSegActive(ws, 'data-weekday', numericWd ? 'all' : (f.weekday || 'all'));
      ws.classList.toggle('is-custom', numericWd);
      if (numericWd) Array.prototype.forEach.call(ws.querySelectorAll('button'), function (b) { b.classList.remove('is-active'); });
    }
    syncChips();
    syncCalLegend();
    syncQuickActive();
  }
  /* 快捷分段：和金额、星期、类型都是「并且」，谁也不覆盖谁。
     这里的五个标签只做前面几行做不到的事：备注明细与当天密度。 */
  function activeQuickKey(f) {
    return f.quick || 'all';
  }
  function syncQuickActive() {
    var box = $('subQuick');
    if (!box) return;
    markActive(box, 'data-quick', activeQuickKey(state.filters));
    syncFilterSeg(box);
  }
  function applyQuick(kind) {
    var f = state.filters;
    f.quick = (kind === 'all' || f.quick === kind) ? '' : kind;
    syncFilterUI(); renderBoard();
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
    if (opts.reset) state.filters = { q: '', type: 'all', category: 'all', sub: 'all', weekday: 'all', amount: 'all', quick: '' };
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
    /* 不挂 inside dataZoom：它会拦截 wheel 并 preventDefault，
       鼠标停在趋势图上时整页滚不动。数据最多 36 个月，本来也不需要缩放。 */
    o.dataZoom = [];
    o.series = series;
    setOpt('chartTrend', o);
    lastTrendRows = rows;
    bindAxisClick('chartTrend', function (idx) { jumpMonthFromRow(lastTrendRows[idx]); });
  }

  /* 体重记录：按日期升序的折线 + 平均线。数据来自 state.store.weights，
     与账目共用同一份 localStorage / 云同步快照。 */
  function renderWeight(p) {
    var w = state.store.weights || {};
    var keys = Object.keys(w).filter(function (k) {
      return /^\d{4}-\d{2}-\d{2}$/.test(k) && isFinite(Number(w[k]));
    }).sort();
    var vals = keys.map(function (k) { return Number(w[k]); });
    var sub = $('weightSub');
    if (sub) {
      if (!keys.length) sub.textContent = '在天页「体重」里记下第一条';
      else {
        var first = vals[0], last = vals[vals.length - 1];
        var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
        var diff = last - first;
        sub.textContent = keys.length + ' 条 · 最新 ' + last.toFixed(1) + ' kg · 区间 ' +
          lo.toFixed(1) + '～' + hi.toFixed(1) + ' kg · 较首次 ' +
          (diff >= 0 ? '+' : '−') + Math.abs(diff).toFixed(1) + ' kg';
      }
    }
    var o = baseOption(p);
    o.grid = { left: 6, right: 14, top: 22, bottom: 6, containLabel: true };
    o.tooltip = tooltipCommon(p, {
      trigger: 'axis',
      axisPointer: { type: 'line', lineStyle: { color: withAlpha(p.primary, .45) } },
      /* 横轴只写 MM-DD 省地方，但 tooltip 必须给出完整年月日，
         否则跨年对比时看不出是哪一年 */
      formatter: function (ps) {
        if (!ps || !ps.length) return '';
        var i = ps[0].dataIndex;
        var k = keys[i] || '';
        var v = ps[0].value;
        var d = new Date(k + 'T00:00:00');
        var wd = isNaN(d.getTime()) ? '' : ' 周' + '日一二三四五六'.charAt(d.getDay());
        return '<div style="font-weight:700;margin-bottom:3px">' + k + wd + '</div>' +
          '<span style="color:' + p.primary + '">●</span> 体重 <b>' + Number(v).toFixed(1) + ' kg</b>';
      }
    });
    o.xAxis = catAxis(p, keys.map(function (k) { return k.slice(5); }), {
      boundaryGap: false,
      axisLabel: { color: p.muted, fontSize: 10.5, fontFamily: p.font, hideOverlap: true }
    });
    o.yAxis = valAxis(p, {
      scale: true,
      min: function (v) { return Math.floor(v.min - 1); },
      max: function (v) { return Math.ceil(v.max + 1); },
      axisLabel: { color: p.muted, fontSize: 10.5, fontFamily: p.font, formatter: function (v) { return v.toFixed(0); } }
    });
    var avg = vals.length ? vals.reduce(function (a, b) { return a + b; }, 0) / vals.length : 0;
    o.series = [{
      name: '体重', type: 'line', smooth: .34, symbol: 'circle', symbolSize: 7,
      showSymbol: vals.length <= 40, data: vals,
      lineStyle: { width: 2.6, color: p.primary },
      itemStyle: { color: p.primary, borderColor: p.surface, borderWidth: 2 },
      areaStyle: { color: gradV(withAlpha(p.primary, .26), withAlpha(p.primary, 0)) },
      markLine: vals.length ? {
        silent: true, symbol: 'none',
        lineStyle: { type: 'dashed', color: p.muted, width: 1, opacity: .7 },
        label: { formatter: '均 ' + avg.toFixed(1) + ' kg', color: p.muted, fontSize: 10, position: 'insideEndTop' },
        data: [{ yAxis: avg }]
      } : undefined
    }];
    o.graphic = keys.length ? [] : [{
      type: 'text', left: 'center', top: 'middle',
      style: { text: '还没有体重记录\n在天页「体重」里记下第一条', fill: p.muted,
        fontSize: 12, lineHeight: 20, textAlign: 'center', fontFamily: p.font }
    }];
    setOpt('chartWeight', o);
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
      /* 合并页：总览三图 + 原分析页七图，一次全画 */
      renderTrend(p); renderDonut(p); renderBalance(p); renderWeight(p);
      renderAnnual(p); renderCalendar(p); renderStack(p); renderTop(p);
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
  }

  function setText(id, v) {
    var el = $(id);
    if (el) el.textContent = v;
  }

  /* ---------------- 日历：分类 / 子类筛选（与工具条同一行） ---------------- */
  var cmpYear = 2026, cmpMonth = 11, cmpOpen = false;
  /* 分类 / 子类各是一条独立的等宽分段控件，和「全部 / 支 / 收」完全同款：
     段数写进 --seg-n，滑块靠 --seg-i 平移。
     关键：按钮与 .seg-ind 只在「集合真的变了」时重建；同一次筛选切换
     只改 is-active 与 --seg-i，滑块节点留在原地，transform 过渡才会跑。 */
  /* 滑块拖过一次会留下内联 transform；如果不清掉，之后点按钮只改 --seg-i
     也推不动滑块 —— 这就是"选项选中了但滑块不动"的根因。
     任何一次非拖拽的状态变化都先清内联，让 CSS 的 --seg-i 重新接管。
     拖动中的滑块带 data-busy，不会被这里打断。 */
  function resetSegInd(el) {
    var ind = el && el.querySelector('.seg-ind');
    if (!ind || ind.dataset.busy === '1') return;
    ind.style.transition = '';
    ind.style.transform = '';
  }
  function syncFilterSeg(el) {
    if (!el) return;
    var bs = el.querySelectorAll('button[data-cat], button[data-sub], button[data-quick]');
    var idx = 0, ac = '';
    for (var i = 0; i < bs.length; i++) {
      if (bs[i].classList.contains('is-active')) {
        idx = i;
        ac = bs[i].style.getPropertyValue('--c') || '';
      }
    }
    el.style.setProperty('--seg-n', String(bs.length || 1));
    el.style.setProperty('--seg-i', String(idx));
    el.dataset.active = String(idx);
    if (ac) el.style.setProperty('--ac', ac);
    resetSegInd(el);
  }
  function markActive(el, attr, value) {
    if (!el) return;
    Array.prototype.forEach.call(el.querySelectorAll('button[' + attr + ']'), function (b) {
      b.classList.toggle('is-active', b.getAttribute(attr) === String(value));
    });
  }
  function renderCatBar(p) {
    var catBox = $('catRow'), subBox = $('subRow'), wrap = $('ctFilters'), quick = $('subQuick');
    if (!catBox || !subBox) return;
    var cat = state.filters.category;
    var colors = catColors(p);
    var theme = document.documentElement.getAttribute('data-theme') || 'light';

    /* 主类：只随换肤重建。筛选切换时节点保持不动，滑块真正滑过去。 */
    var mainSig = theme + '|' + p.primary + '|' + p.income + '|' + EXPENSE_CATS.join(',');
    if (catBox.dataset.sig !== mainSig) {
      var html = '<span class="seg-ind" aria-hidden="true"></span>' +
        '<button type="button" data-cat="all" style="--c:' + p.primary + ';--ink:' + catInk(p, p.primary) + '">全部</button>';
      EXPENSE_CATS.forEach(function (c, i) {
        html += '<button type="button" data-cat="' + esc(c) + '" style="--c:' + colors[i] + ';--ink:' + catInk(p, colors[i]) + '">' + esc(c) + '</button>';
      });
      html += '<button type="button" data-cat="收入" style="--c:' + p.income + ';--ink:' + catInk(p, p.income) + '">收入</button>';
      catBox.innerHTML = html;
      catBox.dataset.sig = mainSig;
    }
    markActive(catBox, 'data-cat', cat);
    syncFilterSeg(catBox);

    /* 子类：换分类 / 换肤 / 笔数变化才重建；同一分类里换子类只挪滑块 */
    var names = [], counts = {}, tot = 0;
    if (cat !== 'all') {
      rangeRecords().forEach(function (r) {
        if (r.category !== cat) return;
        counts[r.sub] = (counts[r.sub] || 0) + 1;
        tot++;
      });
      names = subCatNames(cat);
    }
    var subSig = names.length ? theme + '|' + p.primary + '|' + cat + '|' + names.join(',') + '|' +
      names.map(function (n) { return counts[n] || 0; }).join(',') + '|' + tot : '';
    if (subBox.dataset.sig !== subSig) {
      var sub = '';
      if (names.length) {
        var base = catColor(p, cat);
        sub = '<span class="seg-ind" aria-hidden="true"></span>';
        sub += '<button type="button" class="ct-sub" data-sub="all" style="--c:' + p.primary + ';--ink:' + catInk(p, p.primary) + '">全部<b>' + tot + '</b></button>';
        names.forEach(function (name, i) {
          var n = counts[name] || 0;
          var step = names.length <= 1 ? .1 : (i / Math.max(1, names.length - 1)) * .5;
          var col = mixColor(base, p.surface, .1 + step * .45);
          sub += '<button type="button" class="ct-sub' + (n ? '' : ' is-empty') + '" data-sub="' + esc(name) +
            '" style="--c:' + col + ';--ink:' + catInk(p, col) + '">' + esc(name) + '<b>' + n + '</b></button>';
        });
      }
      subBox.innerHTML = sub;
      subBox.dataset.sig = subSig;
    }
    if (names.length) {
      markActive(subBox, 'data-sub', state.filters.sub);
      syncFilterSeg(subBox);
    }
    subBox.hidden = !names.length;
    if (quick) quick.hidden = !!names.length;
    if (wrap) wrap.classList.toggle('has-sub', !!names.length);
  }
  function syncCalLegend() { renderCatBar(palette()); }

  /* 日期标题弹层：年→年历、月→月历、周→周历、天→日历。
     四种粒度共用同一个浮层，内容按 state.scale 现场生成。 */
  function renderCmp() {
    var pop = $('calMonthPop'), box = $('cmpMonths'), title = $('cmpTitle');
    if (!box) return;
    var scale = state.scale, i;
    if (pop) pop.setAttribute('data-mode', scale);
    if (scale === 'year') {
      if (title) title.textContent = cmpYear + '年 · 选择年份';
      if (pop) pop.setAttribute('aria-label', '选择年份');
      var years = [];
      for (i = cmpYear - 5; i <= cmpYear + 6; i++) years.push(i);
      box.innerHTML = '<div class="dp-months dp-years">' + years.map(function (y) {
        return '<button type="button" class="dp-month' + (y === state.calMonth.year ? ' is-active' : '') +
          '" data-year="' + y + '">' + y + '</button>';
      }).join('') + '</div>';
      return;
    }
    if (scale === 'month') {
      if (title) title.textContent = cmpYear + '年';
      if (pop) pop.setAttribute('aria-label', '选择月份');
      box.innerHTML = '<div class="dp-months">' + MONTH_CN.map(function (n, ix) {
        var active = cmpYear === state.calMonth.year && (ix + 1) === state.calMonth.month;
        return '<button type="button" class="dp-month' + (active ? ' is-active' : '') +
          '" data-month="' + (ix + 1) + '">' + n + '</button>';
      }).join('') + '</div>';
      return;
    }
    if (title) title.textContent = cmpYear + '年 ' + cmpMonth + '月';
    if (scale === 'week') {
      if (pop) pop.setAttribute('aria-label', '选择周');
      var first = new Date(cmpYear, cmpMonth - 1, 1);
      var last = new Date(cmpYear, cmpMonth, 0);
      var cur = startOfWeek(first), n = 1, html = '';
      var anchorWeek = dateKey(startOfWeek(anchorDate()));
      while (cur <= last) {
        var e = new Date(cur); e.setDate(e.getDate() + 6);
        var k = dateKey(cur);
        var label = (cur.getMonth() + 1) + '/' + cur.getDate() + ' — ' + (e.getMonth() + 1) + '/' + e.getDate();
        html += '<button type="button" class="dp-week-btn' + (k === anchorWeek ? ' is-active' : '') +
          '" data-week-start="' + k + '"><b>第 ' + n + ' 周</b><span>' + label + '</span></button>';
        cur = new Date(cur); cur.setDate(cur.getDate() + 7); n++;
      }
      box.innerHTML = '<div class="dp-weeks">' + html + '</div>';
      return;
    }
    /* day：与日历同款周一开头的迷你月历 */
    if (pop) pop.setAttribute('aria-label', '选择日期');
    var f = new Date(cmpYear, cmpMonth - 1, 1);
    var offset = (f.getDay() + 6) % 7;
    var dim = new Date(cmpYear, cmpMonth, 0).getDate();
    var count = Math.ceil((offset + dim) / 7) * 7;
    var today = todayStr(), sel = dateKey(anchorDate()), days = '';
    for (i = 0; i < count; i++) {
      var d = new Date(cmpYear, cmpMonth - 1, 1 - offset + i);
      var key = dateKey(d), cls = 'dp-day';
      if (d.getMonth() !== cmpMonth - 1) cls += ' is-other';
      if (key === today) cls += ' is-today';
      if (key === sel) cls += ' is-selected';
      days += '<button type="button" class="' + cls + '" data-date="' + key + '" aria-label="' + key + '">' + d.getDate() + '</button>';
    }
    box.innerHTML = '<div class="dp-days"><div class="dp-week"><span>一</span><span>二</span><span>三</span><span>四</span><span>五</span><span>六</span><span>日</span></div>' +
      '<div class="dp-grid">' + days + '</div></div>';
  }
  function shiftCmp(dir) {
    if (state.scale === 'year' || state.scale === 'month') cmpYear += dir;
    else {
      cmpMonth += dir;
      if (cmpMonth < 1) { cmpMonth = 12; cmpYear -= 1; }
      else if (cmpMonth > 12) { cmpMonth = 1; cmpYear += 1; }
    }
    renderCmp();
  }
  function openCmp() {
    var pop = $('calMonthPop'), title = $('calTitle');
    if (!pop || !title) return;
    var a = (state.scale === 'week' || state.scale === 'day')
      ? anchorDate() : new Date(state.calMonth.year, state.calMonth.month - 1, 1);
    cmpYear = state.scale === 'year' ? state.calMonth.year : a.getFullYear();
    cmpMonth = a.getMonth() + 1;
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
  var ENTRY_GAP = 3, ENTRY_MIN = 22, ENTRY_MAX = 48;
  function narrowGrid() {
    return !!(window.matchMedia && window.matchMedia('(max-width: 620px)').matches);
  }
  /* 条少 —— 每条高一截，最多 48px；条多 —— 均分，压到 22px 为止；
     再多的部分折成 "+N 笔"，点格子或它都进当日明细。
     extraSel 用于底部还有固定条（周视图的汇总）时，把那段高度先扣掉。 */
  function fitStack(cell, box, headSel, perRow, minRow, maxRow, extraSel, moreOutside) {
    var nodes = box.querySelectorAll('.cal-item');
    var count = nodes.length;
    var host = moreOutside ? cell : box;
    var more = host.querySelector('.cal-more');
    if (!count) {
      if (more) more.parentNode.removeChild(more);
      if (moreOutside) cell.classList.remove('has-more');
      return;
    }

    var head = headSel ? cell.querySelector(headSel) : null;
    var extra = extraSel ? cell.querySelector(extraSel) : null;
    var cs = window.getComputedStyle(cell);
    var padT = parseFloat(cs.paddingTop) || 0;
    var padB = parseFloat(cs.paddingBottom) || 0;
    var headH = head ? head.offsetHeight + (parseFloat(window.getComputedStyle(head).marginBottom) || 0) : 30;
    var extraH = extra ? extra.offsetHeight + (parseFloat(window.getComputedStyle(extra).marginTop) || 0) : 0;
    var avail = Math.max(minRow, cell.clientHeight - padT - padB - headH - extraH);

    var rowsFit = Math.max(1, Math.floor((avail + ENTRY_GAP) / (minRow + ENTRY_GAP)));
    var capacity = rowsFit * perRow;
    var overflow = count > capacity;
    /* "+N 笔" 自己占一格，所以溢出时先让出一条 */
    /* 月格：+N 笔 独立占底部整行，不再挤掉条目格；周格沿用旧的一格预留 */
    var keep = overflow ? (moreOutside ? capacity : Math.max(1, capacity - 1)) : count;
    for (var k = keep; k < count; k++) box.removeChild(nodes[k]);
    var rest = count - keep;
    var slots = keep + (overflow && !moreOutside ? 1 : 0);
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
        host.appendChild(more);
      }
      more.innerHTML = '<span class="cm-full">+' + rest + ' 笔</span><span class="cm-mini">+' + rest + '</span>';
      more.title = '查看 ' + cell.getAttribute('data-date') + ' 的全部 ' + count + ' 笔';
    } else if (more) {
      more.parentNode.removeChild(more);
    }
    if (moreOutside) cell.classList.toggle('has-more', rest > 0);
  }

  function fillMonthEntries(grid) {
    var narrow = narrowGrid();
    var perRow = narrow ? 1 : 2;
    var cells = grid.children;
    for (var i = 0; i < cells.length; i++) {
      var box = cells[i].querySelector('.cal-items');
      if (!box) continue;
      /* 右下角 ＋ 常驻，先把那 28px 让出来，条目不会压到它下面 */
      fitStack(cells[i], box, '.cal-cell-head', perRow, narrow ? 5 : ENTRY_MIN, narrow ? 6 : ENTRY_MAX, '.cal-add', true);
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
      var items = (byDate[key] || []).slice();
      /* 同类挨在一起：先按分类固定顺序，同类里按金额从大到小 */
      items.sort(function (a2, b2) {
        var oa = a2.type === 'income' ? 99 : EXPENSE_CATS.indexOf(a2.category);
        var ob = b2.type === 'income' ? 99 : EXPENSE_CATS.indexOf(b2.category);
        if (oa < 0) oa = 50;
        if (ob < 0) ob = 50;
        if (oa !== ob) return oa - ob;
        return b2.amount - a2.amount;
      });
      var de = 0, di = 0;
      items.forEach(function (r) { if (r.type === 'income') di += r.amount; else de += r.amount; });
      var tot = de + di, net = round(di - de);
      var cls = 'wk-col';
      if (key === today) cls += ' is-today';
      if (i >= 5) cls += ' is-weekend';
      html += '<div class="' + cls + '" data-date="' + key + '">' +
        '<div class="wk-head">' +
        '<div class="wk-head-top"><span class="wk-dow">' + WEEKDAYS[i] + '</span>' +
        '<b class="wk-day">' + d.getDate() + '</b></div>' +
        '<div class="wk-head-sum">' +
        (de ? '<span class="wk-out">−' + fmtChip(de) + '</span>' : '') +
        (di ? '<span class="wk-in">+' + fmtChip(di) + '</span>' : '') +
        (!de && !di ? '<span class="wk-none">暂无流水</span>' : '') +
        '</div></div>' +
        '<div class="cal-items wk-items' + (items.length ? '' : ' is-empty') + '">' +
        (items.length
          ? items.map(function (r) { return itemHTML(p, r); }).join('')
          : '<div class="wk-empty"><b>无记录</b><span>点右下角 ＋ 记一笔</span></div>') +
        '</div>' +
        '<div class="wk-foot">' +
        '<div class="wk-bar">' +
        (tot ? '<i class="wkb-out" style="width:' + (de / tot * 100).toFixed(1) + '%"></i>' +
          '<i class="wkb-in" style="width:' + (di / tot * 100).toFixed(1) + '%"></i>' : '') +
        '</div>' +
        '<span class="wk-foot-txt">' + (items.length
          ? items.length + ' 笔 · 净 ' + (net >= 0 ? '+' : '−') + fmtChip(Math.abs(net))
          : '暂无流水') + '</span>' +
        '</div>' +
        '<button type="button" class="cal-add" data-add="' + key + '" aria-label="在 ' + key + ' 新增">+</button>' +
        '</div>';
    }
    box.innerHTML = html;
    /* 一列不到 200px，两块式塞不下名称：整列一行一条，底部汇总条的高度先扣掉。
       行高上限放到 64px，条少时把整列铺满，条多时也不至于挤成一条线。 */
    for (var c = 0; c < box.children.length; c++) {
      var col = box.children[c];
      var list = col.querySelector('.cal-items');
      if (list && list.querySelector('.cal-item')) fitStack(col, list, '.wk-head', 1, 28, 64, '.wk-foot', false);
    }
  }

  /* 天页「关于这一天」：六张纯 SVG/CSS 图表，全部带 hover 提示与点击跳日。
     不依赖 ECharts 的容器尺寸，移动端也能正常渲染。 */
  /* 天页「关于这一天」：单列竖向六张卡。
     删掉了近 30 天走势 / 同星期几 / 记账热力，换成更能回答"今天怎么了"的三张：
     当日分类构成、单笔金额分布、体重记录。全部内联 SVG / CSS，带 hover 与点击跳日。 */
  function dayInsightsHTML(p, key, items, de) {
    var byDate = {};
    allRecords().forEach(function (r) {
      if (r.type === 'income') return;
      byDate[r.date] = (byDate[r.date] || 0) + r.amount;
    });
    var d0 = new Date(key + 'T00:00:00');
    function at(off) {
      var d = new Date(d0.getFullYear(), d0.getMonth(), d0.getDate() - off);
      var k = dateKey(d);
      return { k: k, v: round(byDate[k] || 0), d: d };
    }
    function card(title, body, idx) {
      return '<div class="ins-card" style="--i:' + idx + '"><h4>' + title + '</h4>' +
        '<div class="ins-body">' + body + '</div></div>';
    }

    /* 1) 近 7 日支出：折线 + 淡填充，点/线都能悬浮看数、点击跳日 */
    var WD = ['日', '一', '二', '三', '四', '五', '六'];
    var week = [], max7 = 1, min7 = 0;
    for (var w = 6; w >= 0; w--) {
      var y = at(w); week.push(y);
      if (y.v > max7) max7 = y.v;
      if (y.v < min7) min7 = y.v;
    }
    var span7 = Math.max(1, max7 - min7);
    function lx(i) { return 7 + i * (206 / 6); }
    function ly(v) { return 37 - ((v - min7) / span7) * 30; }
    var pts7 = week.map(function (h, i) { return lx(i).toFixed(1) + ',' + ly(h.v).toFixed(1); }).join(' ');
    var area7 = 'M' + lx(0).toFixed(1) + ',40 L' + pts7.split(' ').join(' L') + ' L' + lx(6).toFixed(1) + ',40 Z';
    var dots7 = week.map(function (h, i) {
      var t = h.k + '\n支出 ' + fmtYuan(h.v) + (i === 6 ? '\n今天' : '');
      return '<circle class="ins-ln-dot' + (i === 6 ? ' is-today' : '') + '" cx="' + lx(i).toFixed(1) +
        '" cy="' + ly(h.v).toFixed(1) + '" r="' + (i === 6 ? 3.4 : 2.4) +
        '" data-tip="' + esc(t) + '" data-jump-day="' + h.k + '"/>';
    }).join('');
    var line7 =
      '<svg class="ins-line" viewBox="0 0 220 44" preserveAspectRatio="none" aria-hidden="true">' +
      '<path class="ins-ln-area" d="' + area7 + '"/>' +
      '<polyline class="ins-ln-path" points="' + pts7 + '"/>' + dots7 + '</svg>' +
      '<div class="ins-ln-x">' + week.map(function (h, i) {
        return '<span' + (i === 6 ? ' class="is-today"' : '') + '>' + WD[h.d.getDay()] + '</span>';
      }).join('') + '</div>';

    /* 2) 今天的位置：跟昨天、本月日均、今年所有天比 —— 全是对当天的横向对比，
       比"最大一笔"更能回答"今天花得多不多" */

    /* 3) 当前月 / 当前年剩余：以近 6 个完整月的月均、往年全年均值作参考线 */
    var dim = new Date(d0.getFullYear(), d0.getMonth() + 1, 0).getDate();
    var elapsed = d0.getDate(), mtd = 0, ytd = 0, mDays = 0;
    for (var md = 0; md < elapsed; md++) {
      var dd = new Date(d0.getFullYear(), d0.getMonth(), 1 + md);
      var vv = round(byDate[dateKey(dd)] || 0);
      mtd += vv;
      if (vv > 0) mDays++;
    }
    for (var t = new Date(d0.getFullYear(), 0, 1); t <= d0; t.setDate(t.getDate() + 1)) {
      ytd += round(byDate[dateKey(t)] || 0);
    }
    var monthBudget = 0, monthN = 0;
    for (var back = 1; back <= 6; back++) {
      var bm = new Date(d0.getFullYear(), d0.getMonth() - back, 1);
      var bdim = new Date(bm.getFullYear(), bm.getMonth() + 1, 0).getDate(), bsum = 0;
      for (var bd = 1; bd <= bdim; bd++) bsum += round(byDate[dateKey(new Date(bm.getFullYear(), bm.getMonth(), bd))] || 0);
      if (bsum > 0) { monthBudget += bsum; monthN++; }
    }
    monthBudget = monthN ? monthBudget / monthN : (mtd > 0 ? mtd / Math.max(1, elapsed) * dim : 0);
    /* 当前年结余 = 当年已入账收入 − 当年支出，就是这一年真正赚下的钱。
       旧口径拿往年支出均值当"年预算"，算出来只是"花超没超"，不是结余，已废弃。 */
    var yYear = String(d0.getFullYear()), yInc = 0, yExp = 0;
    allRecords().forEach(function (r) {
      if (String(r.date).slice(0, 4) !== yYear) return;
      if (r.type === 'income') yInc += r.amount; else yExp += r.amount;
    });
    var mLeft = monthBudget - mtd, yLeft = round(yInc - yExp);
    var mLeftPct = monthBudget > 0 ? Math.max(0, Math.min(100, mtd / monthBudget * 100)) : 0;
    /* 年结余的进度条按"花掉收入的比例"显示，越低越省 */
    var yLeftPct = yInc > 0 ? Math.max(0, Math.min(100, yExp / yInc * 100)) : 0;

    /* 2b) 今天的位置：昨日对比 / 本月日均 / 今年排名 */
    var yest = at(1).v;
    var dDelta = round(de - yest);
    var dPct = yest > 0 ? dDelta / yest * 100 : null;
    var monthDaily = mDays > 0 ? mtd / mDays : (elapsed > 0 ? mtd / elapsed : 0);
    var ratio = monthDaily > 0 ? de / monthDaily : 0;
    var yKeyPrefix = String(d0.getFullYear());
    var yearDays = [];
    Object.keys(byDate).forEach(function (k) {
      if (k.slice(0, 4) === yKeyPrefix && byDate[k] > 0) yearDays.push(byDate[k]);
    });
    var higher = 0;
    yearDays.forEach(function (v) { if (v > de) higher++; });
    var rank = de > 0 ? higher + 1 : 0;
    var pctBelow = yearDays.length ? Math.round((yearDays.length - higher - (de > 0 ? 1 : 0)) / yearDays.length * 100) : 0;
    if (pctBelow < 0) pctBelow = 0;
    var cmpCard =
      '<div class="ins-cmp">' +
      '<div class="ins-cmp-top">' +
      '<div><span>较昨日</span><b class="' + (dDelta > 0 ? 'is-up' : dDelta < 0 ? 'is-down' : '') + '">' +
      (yest > 0
        ? (dDelta >= 0 ? '+' : '−') + fmtYuan(Math.abs(dDelta)).slice(1) +
          (dPct !== null ? ' · ' + (dPct >= 0 ? '+' : '−') + Math.abs(dPct).toFixed(0) + '%' : '')
        : (de > 0 ? fmtYuan(de) : '昨天没记')) +
      '</b></div>' +
      '<div><span>本月日均</span><b>' + fmtYuan(monthDaily) + '</b></div>' +
      '</div>' +
      '<div class="ins-cmp-bar" data-tip="' + esc('今天 ' + fmtYuan(de) + ' / 日均 ' + fmtYuan(monthDaily) +
        ' · ' + (ratio * 100).toFixed(0) + '%') + '"><i style="width:' +
      Math.max(2, Math.min(100, ratio * 100)).toFixed(1) + '%"></i></div>' +
      '<div class="ins-cmp-foot"><span>今年排名</span><b>' +
      (rank ? '第 ' + rank + ' 高 · 超过 ' + pctBelow + '%' : (yearDays.length ? '今天还没花' : '今年无记录')) +
      '</b></div>' +
      '</div>';

    /* 4) 当日分类构成：一条堆叠横条 + 前三名图例 */
    var catSum = {}, catTotal = 0;
    items.forEach(function (r) {
      if (r.type === 'income') return;
      catSum[r.category] = (catSum[r.category] || 0) + r.amount;
      catTotal += r.amount;
    });
    var catList = Object.keys(catSum).sort(function (a, b) { return catSum[b] - catSum[a]; });
    var stack = catList.map(function (c) {
      var pct = catTotal > 0 ? catSum[c] / catTotal * 100 : 0;
      return '<i data-tip="' + esc(c + ' ' + fmtYuan(catSum[c]) + ' · ' + pct.toFixed(0) + '%') +
        '" style="width:' + pct.toFixed(1) + '%;background:' + catFill(p, catColor(p, c)) + '"></i>';
    }).join('');
    var legend = catList.slice(0, 3).map(function (c) {
      var pct = catTotal > 0 ? catSum[c] / catTotal * 100 : 0;
      return '<span><i style="background:' + catFill(p, catColor(p, c)) + '"></i>' + esc(c) +
        '<b>' + pct.toFixed(0) + '%</b></span>';
    }).join('');
    var catCard = catList.length
      ? '<div class="ins-stack">' + stack + '</div><div class="ins-legend">' + legend + '</div>'
      : '<div class="ins-none">今天还没有支出分类</div>';

    /* 5) 单笔金额分布：和上方「金额」筛选项同档 */
    var buckets = [{ label: '≤20', n: 0 }, { label: '20~100', n: 0 }, { label: '≥100', n: 0 }];
    items.forEach(function (r) {
      if (r.type === 'income') return;
      var a = Math.abs(Number(r.amount) || 0);
      if (a <= 20) buckets[0].n++;
      else if (a < 100) buckets[1].n++;
      else buckets[2].n++;
    });
    var maxB = Math.max(1, buckets[0].n, buckets[1].n, buckets[2].n);
    var amtBars = buckets.map(function (b) {
      var bh = Math.max(3, Math.round(b.n / maxB * 34));
      return '<div class="ins-ab" data-tip="' + esc(b.label + ' 元 · ' + b.n + ' 笔') + '">' +
        '<b style="height:' + bh + 'px"></b><span>' + b.label + '</span><em>' + b.n + '</em></div>';
    }).join('');

    /* 6) 体重记录：接新增的每日体重，给出当天值 / 较上次 / 最近 7 次迷你线 */
    var w = state.store.weights || {};
    var wkeys = Object.keys(w).filter(function (k) {
      return /^\d{4}-\d{2}-\d{2}$/.test(k) && isFinite(Number(w[k]));
    }).sort();
    var cur = w[key] ? Number(w[key]) : 0;
    var prevKeys = wkeys.filter(function (k) { return k < key; });
    var prev = prevKeys.length ? Number(w[prevKeys[prevKeys.length - 1]]) : 0;
    var diff = cur && prev ? cur - prev : 0;
    var wLast = wkeys.slice(-7).map(function (k) { return Number(w[k]); });
    var wlo = wLast.length ? Math.min.apply(null, wLast) : 0;
    var whi = wLast.length ? Math.max.apply(null, wLast) : 1;
    var wpts = wLast.map(function (v, i) {
      var px = 3 + i * (154 / Math.max(1, wLast.length - 1));
      var py = 30 - ((v - wlo) / Math.max(.1, whi - wlo)) * 24;
      return px.toFixed(1) + ',' + py.toFixed(1);
    }).join(' ');
    var wSpark = wLast.length > 1
      ? '<svg class="ins-wspark" viewBox="0 0 160 34" preserveAspectRatio="none" aria-hidden="true">' +
        '<polyline points="' + wpts + '" fill="none" stroke="' + p.primary + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/></svg>'
      : '';
    var weightCard = wkeys.length
      ? '<div class="ins-weight" data-focus-weight="1" title="点这里跳到体重输入框">' +
        '<b>' + (cur ? cur.toFixed(1) : w[wkeys[wkeys.length - 1]].toFixed(1)) + '<i>kg</i></b>' +
        '<span>' + (cur ? '今日体重' : '最近一次 ' + wkeys[wkeys.length - 1].slice(5)) +
        (cur && prev ? ' · 较上次 ' + (diff >= 0 ? '+' : '−') + Math.abs(diff).toFixed(1) + ' kg' : '') + '</span>' +
        wSpark + '</div>'
      : '<div class="ins-none" data-focus-weight="1">还没有体重记录 · 点这里去记一条</div>';

    var leftCard =
      '<div class="ins-left">' +
      '<div class="ins-left-row"><div><span>当前月剩余</span><b class="' + (mLeft < 0 ? 'is-over' : '') + '">' + fmtYuan(mLeft) + '</b></div>' +
      '<div><span>当前年结余</span><b class="' + (yLeft < 0 ? 'is-over' : '') + '">' + fmtYuan(yLeft) + '</b></div></div>' +
      '<div class="ins-left-bar"><i style="width:' + mLeftPct.toFixed(1) + '%"></i></div>' +
      '<div class="ins-left-bar is-year"><i style="width:' + yLeftPct.toFixed(1) + '%"></i></div>' +
      '<div class="ins-foot"><span>今年收 ' + fmtBig(yInc) + ' · 支 ' + fmtBig(yExp) + ' · 本月已记 ' + mDays + ' 天</span></div>' +
      '</div>';

    return card('近 7 日支出', line7, 0) +
      card('今天的位置', cmpCard, 1) +
      card('月剩余 / 年结余', leftCard, 2) +
      card('当日分类构成', catCard, 3) +
      card('单笔金额分布', '<div class="ins-abs">' + amtBars + '</div>', 4) +
      card('体重记录', weightCard, 5);
  }

  /* 左栏内容随当天分类数变化：先按紧凑排版，仍超高就整体等比缩小，
     永远不出现上下滚动。两次测量是因为加宽后行会变少，缩放比要重算。 */
  function fitDaySide() {
    var side = document.querySelector('.day-side');
    var inner = side && side.querySelector('.ds-inner');
    if (!inner || !side.clientHeight) return;
    inner.style.transform = 'none';
    inner.style.width = '100%';
    var have = side.clientHeight, need = inner.scrollHeight;
    if (need <= have + 1) return;
    var k = Math.max(.72, have / need);
    inner.style.width = (100 / k).toFixed(3) + '%';
    var need2 = inner.scrollHeight || need;
    var k2 = Math.max(.72, Math.min(1, have / need2));
    inner.style.width = (100 / k2).toFixed(3) + '%';
    inner.style.transform = 'scale(' + k2.toFixed(4) + ')';
  }
  function renderDayBoard(p, board) {
    var box = $('calDayBoard');
    if (!box) return;
    var key = dateKey(anchorDate());
    var items = board.filter(function (r) { return r.date === key; });
    var de = 0, di = 0;
    items.forEach(function (r) {
      if (r.type === 'income') { di += r.amount; return; }
      de += r.amount;
    });
    var net = di - de;

    /* 当日明细：一个种类占一整行，行内把该类的每一笔做成可编辑的小胶囊 */
    var groups = {};
    items.forEach(function (r) {
      var g = r.type === 'income' ? '收入' : (r.category || '其它');
      if (!groups[g]) groups[g] = { name: g, rows: [], total: 0 };
      groups[g].rows.push(r);
      groups[g].total += r.amount;
    });
    var order = Object.keys(groups).sort(function (a, b) { return groups[b].total - groups[a].total; });
    var catRowsHTML = order.map(function (g) {
      var gr = groups[g];
      var col = g === '收入' ? p.income : catColor(p, g);
      var ink = catInk(p, col);
      var chips = gr.rows.map(function (r) { return itemHTML(p, r); }).join('');
      return '<div class="dl-cat" style="--c:' + col + ';--ink:' + ink + '">' +
        '<span class="dlc-bar"></span>' +
        '<div class="dlc-name"><b>' + esc(g) + '</b><i>' + gr.rows.length + ' 笔</i></div>' +
        '<div class="dlc-recs">' + chips + '</div>' +
        '<em class="dlc-total">' + (g === '收入' ? '+' : '−') + fmtYuan(gr.total) + '</em>' +
        '</div>';
    }).join('');
    if (!catRowsHTML) catRowsHTML = '<div class="day-empty"><strong>这天还没有记录</strong><span>用左侧的表单记下第一笔。</span></div>';

    var qIdx = quickType === 'income' ? 1 : 0;
    var quickHTML =
      '<form class="ds-quick" id="quickEntryForm" novalidate>' +
      '<h4>＋ 记一笔 <span>' + esc(key) + '</span></h4>' +
      '<input type="hidden" id="qDate" value="' + esc(key) + '">' +
      '<div class="dq-top">' +
      '<div class="seg dq-seg" id="qTypeSeg" role="group" aria-label="收支类型" data-active="' + qIdx +
      '" style="--seg-n:2;--seg-i:' + qIdx + '">' +
      '<span class="seg-ind" aria-hidden="true"></span>' +
      '<button type="button" data-qtype="expense"' + (qIdx === 0 ? ' class="is-active"' : '') + '>− 支出</button>' +
      '<button type="button" data-qtype="income"' + (qIdx === 1 ? ' class="is-active"' : '') + '>＋ 收入</button>' +
      '</div>' +
      '<div class="dq-amount"><i>¥</i><input type="number" id="qAmount" step="0.01" min="0.01" placeholder="0.00" required autocomplete="off" aria-label="金额"></div>' +
      '</div>' +
      '<div class="dq-row">' +
      '<label><span>分类</span><select id="qCategory"></select></label>' +
      '<label><span>子类</span><select id="qSub"></select></label>' +
      '</div>' +
      '<div class="dq-bottom">' +
      '<label class="dq-note"><span>备注</span><input type="text" id="qNote" maxlength="40" placeholder="例如：午餐、房租" autocomplete="off"></label>' +
      '<button type="submit" class="btn btn-primary">保存这笔</button>' +
      '</div>' +
      '<p class="dq-error" id="qError" hidden></p>' +
      '</form>';

    var wVal = (state.store.weights || {})[key];
    var weightHTML =
      '<form class="ds-weight" id="weightForm" novalidate>' +
      '<span class="dw-label">体重</span>' +
      '<input type="hidden" id="weightDate" value="' + esc(key) + '">' +
      '<input type="number" id="weightInput" step="0.1" min="20" max="300" value="' + (wVal || '') +
      '" placeholder="—" autocomplete="off" aria-label="体重（kg）">' +
      '<b class="dw-unit">kg</b>' +
      '<button type="submit" class="dw-save">记录</button>' +
      (wVal ? '<button type="button" class="dw-clear" id="weightClear" title="删除这天的体重" aria-label="删除这天的体重">×</button>' : '') +
      '</form>';

    /* 「关于这一天」按内容签名复用 DOM：轮询 / 筛选重绘时只要数据没变，
       节点原样保留，insIn 入场动画不会重播 —— 这是消除自动闪烁的关键。 */
    var insSig = [key, document.documentElement.getAttribute('data-theme'), storeRev,
      items.map(function (r) { return r.id + ':' + r.amount; }).join(','), de, di].join('|');
    var oldIns = box.querySelector('.day-ins-col .day-insights');
    var reuseIns = (oldIns && oldIns.getAttribute('data-sig') === insSig) ? oldIns : null;
    if (reuseIns && reuseIns.parentNode) reuseIns.parentNode.removeChild(reuseIns);

    var d = new Date(key + 'T00:00:00');
    var isWeekend = d.getDay() === 0 || d.getDay() === 6;
    box.innerHTML =
      '<aside class="day-side' + (isWeekend ? ' is-weekend' : '') + '">' +
      '<div class="ds-inner">' +
      '<div class="ds-head"><span class="ds-ym">' + d.getFullYear() + ' 年 ' + (d.getMonth() + 1) + ' 月</span>' +
      '<span class="ds-dow">' + WEEK_CN[d.getDay()] + '</span></div>' +
      '<div class="ds-big"><b>' + d.getDate() + '</b><i>日</i></div>' +
      '<div class="ds-net" style="--ds:' + (Math.abs(net) < .005 ? p.muted : net > 0 ? p.income : p.expense) + '">' +
      '<span>当日净额</span><b>' + (net >= 0 ? '+' : '−') + fmtYuan(Math.abs(net)).slice(1) + '</b></div>' +
      '<div class="ds-meta"><div><span>支出</span><b class="c-expense">' + fmtYuan(de) + '</b></div>' +
      '<div><span>收入</span><b class="c-income">' + fmtYuan(di) + '</b></div>' +
      '<div><span>笔数</span><b>' + items.length + '</b></div></div>' +
      weightHTML +
      quickHTML +
      '</div>' +
      '</aside>' +
      '<div class="day-list">' +
      '<div class="day-list-head">' +
      '<div><h3>当日明细</h3><span>' + key + ' · 共 ' + items.length + ' 笔 · ' + order.length + ' 类</span></div>' +
      '<div class="dlh-sum"><span>支出 <b class="c-expense">' + fmtYuan(de) + '</b></span>' +
      '<span>收入 <b class="c-income">' + fmtYuan(di) + '</b></span></div>' +
      '</div>' +
      '<div class="day-cat-list">' + catRowsHTML + '</div>' +
      '</div>' +
      '<div class="day-ins-col">' +
      '<div class="ins-title"><h3>关于这一天</h3><span>六张小图，看今天处在什么位置</span></div>' +
      '<div class="day-insights" data-sig="' + esc(insSig) + '"' + (reuseIns ? ' data-static="1"' : '') + '>' +
      (reuseIns ? '' : dayInsightsHTML(p, key, items, de)) + '</div>' +
      '</div>';
    if (reuseIns) {
      var freshIns = box.querySelector('.day-ins-col .day-insights');
      if (freshIns && freshIns.parentNode) freshIns.parentNode.replaceChild(reuseIns, freshIns);
    }
    fillQuickCats();
    enableSegDrag($('qTypeSeg'));
    requestAnimationFrame(fitDaySide);
  }

  function renderYearBoard(p, board) {
    var box = $('calYearBoard');
    if (!box) return;
    var y = state.calMonth.year;
    var byDate = groupByDate(board);
    /* 年历的热度算法：筛支出就看支出、筛收入就看收入，
       选「全部」仍按支出（消费日历的原始口径），不会因为混进收入而失真。
       早年这里硬写 r.type !== 'expense' 直接 return，
       所以切到收入时整张年历全空 —— 现在按筛选方向取数。 */
    var wantInc = state.filters.type === 'income';
    var tone = wantInc ? p.income : p.expense;
    var monthTot = [], daySum = {}, peak = 1;
    board.forEach(function (r) {
      if ((r.type === 'income') !== wantInc) return;
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
        var sum = daySum[key] || 0;
        var t = peak > 0 ? Math.min(1, sum / peak) : 0;
        var alpha = sum ? .16 + t * .74 : 0;
        var bgc = sum ? withAlpha(tone, alpha) : mixColor(p.surface3, p.surface, .45);
        var ink = sum && alpha > .42 ? '#ffffff' : (sum ? catInk(p, tone) : p.muted);
        var cls = 'ym-day' + (sum ? ' has' : '') + (key === today ? ' is-today' : '');
        grid += '<button type="button" class="' + cls + '" data-date="' + key + '" style="background:' + bgc + ';color:' + ink +
          '" title="' + key + ' · ' + (sum ? fmtBig(sum) : (wantInc ? '无收入' : '无支出')) + '">' + d.getDate() + '</button>';
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

  /* 总览「数据体检」：十几块横向指标，全部按当前年度范围算。
     每块固定三段：小标题 / 主数值 / 一行注脚，可选一根比例条。
     之后要加减条目，只动这个数组里的东西就行。 */
  function renderOvMetrics() {
    var box = $('ovMetrics');
    if (!box) return;
    var rows = scopeRecords();
    if (!rows.length) {
      box.innerHTML = '<div class="ovs-empty">这个范围内还没有记录</div>';
      return;
    }
    function compact(v) {
      var n = Math.abs(Number(v) || 0);
      if (n >= 10000) return '¥' + (v / 10000).toFixed(n >= 100000 ? 0 : 1) + ' 万';
      return fmtBig(v);
    }
    function tile(k, v, n, opt) {
      opt = opt || {};
      return '<div class="ovm-cell">' +
        '<span class="ovm-k">' + esc(k) + '</span>' +
        '<b class="ovm-v' + (opt.cls ? ' ' + opt.cls : '') + '">' + v + '</b>' +
        (opt.bar !== undefined && opt.bar !== null
          ? '<div class="ovm-bar"><i style="width:' + Math.max(0, Math.min(100, opt.bar)).toFixed(1) + '%"></i></div>' : '') +
        '<i class="ovm-n">' + n + '</i></div>';
    }

    var expRows = [], incRows = [];
    rows.forEach(function (r) { if (r.type === 'income') incRows.push(r); else expRows.push(r); });

    var expSum = 0, incSum = 0, maxOne = null, big = 0, small = 0;
    var dayTot = {}, dayCnt = {}, catSum = {};
    expRows.forEach(function (r) {
      expSum += r.amount;
      if (!maxOne || r.amount > maxOne.amount) maxOne = r;
      if (r.amount >= 100) big++; else if (r.amount <= 20) small++;
      dayTot[r.date] = (dayTot[r.date] || 0) + r.amount;
      catSum[r.category || '其它'] = (catSum[r.category || '其它'] || 0) + r.amount;
    });
    var incTop = null, incNote = {};
    incRows.forEach(function (r) {
      incSum += r.amount;
      var nm = canonNote(r.note) || r.sub || '未命名';
      if (!incNote[nm]) incNote[nm] = 0;
      incNote[nm] += r.amount;
    });
    Object.keys(incNote).forEach(function (n) { if (!incTop || incNote[n] > incNote[incTop]) incTop = n; });
    rows.forEach(function (r) { dayCnt[r.date] = (dayCnt[r.date] || 0) + 1; });

    var keys = Object.keys(dayCnt).sort();
    var spanDays = keys.length
      ? Math.round((new Date(keys[keys.length - 1] + 'T00:00:00') - new Date(keys[0] + 'T00:00:00')) / 864e5) + 1
      : 1;
    var activeDays = Object.keys(dayTot).length;
    var expN = expRows.length || 1;

    /* 周末 / 工作日的单日均值 */
    var wkSum = 0, wkN = 0, wdSum = 0, wdN = 0;
    Object.keys(dayTot).forEach(function (k) {
      var dw = new Date(k + 'T00:00:00').getDay();
      if (isNaN(dw)) return;
      if (dw === 0 || dw === 6) { wkSum += dayTot[k]; wkN++; }
      else { wdSum += dayTot[k]; wdN++; }
    });
    var wkAvg = wkN ? wkSum / wkN : 0, wdAvg = wdN ? wdSum / wdN : 0;

    /* 连续记账：最长一段 + 末尾还在延续的一段 */
    var best = 0, tail = 0, prevK = null;
    keys.forEach(function (k) {
      if (prevK && Math.round((new Date(k + 'T00:00:00') - new Date(prevK + 'T00:00:00')) / 864e5) === 1) tail++;
      else tail = 1;
      if (tail > best) best = tail;
      prevK = k;
    });

    /* 月度极值 */
    var mTot = {};
    expRows.forEach(function (r) {
      var k = r.year * 100 + r.month;
      mTot[k] = (mTot[k] || 0) + r.amount;
    });
    var mKeys = Object.keys(mTot);
    var mHi = null, mLo = null;
    mKeys.forEach(function (k) {
      if (mHi === null || mTot[k] > mTot[mHi]) mHi = k;
      if (mLo === null || mTot[k] < mTot[mLo]) mLo = k;
    });
    function mLbl(k) { return k ? (String(k).slice(0, 4) + '.' + String(k).slice(4)) : '—'; }

    /* 分类集中度与名目重复度 */
    var cats = Object.keys(catSum).sort(function (a, b) { return catSum[b] - catSum[a]; });
    var cr3 = expSum > 0 ? cats.slice(0, 3).reduce(function (s, c) { return s + catSum[c]; }, 0) / expSum * 100 : 0;

    var peakDay = keys.slice().sort(function (a, b) { return dayCnt[b] - dayCnt[a]; })[0] || '—';
    var dailyAvg = expSum / Math.max(1, spanDays);
    var prev = prevYearTotals();
    var yoy = (prev && prev.expense > 0) ? (expSum / prev.expense - 1) * 100 : null;

    var html = '';
    html += tile('日均支出', compact(dailyAvg),
      spanDays + ' 天跨度 · ' + activeDays + ' 天有账', { bar: activeDays / Math.max(1, spanDays) * 100 });
    html += tile('单笔均值', compact(expSum / expN), expN + ' 笔支出');
    html += tile('最大单笔', maxOne ? compact(maxOne.amount) : '—',
      maxOne ? esc((maxOne.note || maxOne.sub || '未命名') + ' · ' + maxOne.date) : '没有支出');
    html += tile('储蓄率', incSum > 0 ? pctText((incSum - expSum) / incSum * 100) : '—',
      '收 ' + compact(incSum) + ' · 支 ' + compact(expSum),
      { cls: incSum > 0 && incSum - expSum >= 0 ? 'pos' : 'neg', bar: incSum > 0 ? expSum / incSum * 100 : 0 });
    html += tile('餐饮占比', expSum > 0 ? pctText((catSum['餐饮'] || 0) / expSum * 100) : '—',
      compact(catSum['餐饮'] || 0), { bar: expSum > 0 ? (catSum['餐饮'] || 0) / expSum * 100 : 0 });
    html += tile('周末日均', compact(wkAvg),
      '工作日 ' + compact(wdAvg) + (wdAvg > 0 ? ' · ' + (wkAvg / wdAvg).toFixed(2) + ' 倍' : ''));
    html += tile('小额笔数', small + ' 笔',
      '≤20 元 · 占 ' + pctText(small / expN * 100),
      { bar: small / expN * 100 });
    html += tile('大额笔数', big + ' 笔',
      '≥100 元 · 占 ' + pctText(big / expN * 100),
      { bar: big / expN * 100, cls: big / expN > .2 ? 'neg' : '' });
    html += tile('最长连续', best + ' 天', '末尾已连 ' + tail + ' 天');
    html += tile('空白天数', (spanDays - activeDays) + ' 天',
      '覆盖率 ' + pctText(activeDays / Math.max(1, spanDays) * 100),
      { bar: 100 - activeDays / Math.max(1, spanDays) * 100 });
    html += tile('月度最高', mHi ? compact(mTot[mHi]) : '—',
      mHi ? mLbl(mHi) + ' · 最低 ' + mLbl(mLo) : '没有支出');
    html += tile('收入主力', incTop ? esc(incTop) : '—',
      incTop ? compact(incNote[incTop]) + ' · 占收入 ' + pctText(incNote[incTop] / Math.max(1, incSum) * 100) : '没有收入');
    html += tile('笔数峰值', dayCnt[peakDay] + ' 笔', peakDay);
    html += tile('全年预计', compact(dailyAvg * 365), '按日均 ' + compact(dailyAvg) + ' 推算');
    html += tile('集中度', pctText(cr3),
      '前三类 ' + (cats.slice(0, 3).join(' / ') || '—'), { bar: cr3 });
    html += tile('同比去年', yoy === null ? '—' : (yoy >= 0 ? '+' : '−') + Math.abs(yoy).toFixed(1) + '%',
      prev ? '去年 ' + compact(prev.expense) : '切到单一年份可比',
      { cls: yoy === null ? '' : yoy >= 0 ? 'neg' : 'pos' });

    box.innerHTML = html;
    if ($('ovmSub')) {
      $('ovmSub').textContent = '覆盖 ' + keys.length + ' 天 · ' + rows.length + ' 笔 · ' + cats.length + ' 个分类';
    }
  }

  function renderAll() {
    renderKpis();
    renderOvMetrics();
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
    analysis: 'overview', stats: 'overview', trend: 'overview',
    calendar: 'calendar', week: 'calendar', month: 'calendar', year: 'calendar', day: 'calendar'
  };
  var ROUTE_CANON = { overview: 'home', calendar: 'calendar' };

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
      resetSegInd(el);
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
    resetSegInd(el);
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
  /* 天页内嵌记账表单：与弹窗共用一套落库逻辑，只是字段前缀不同。
     用独立前缀避免和弹窗的 id 撞车，两个入口可以同时存在于 DOM 里。 */
  var quickType = 'expense';
  /* 展开框里的每个 option 都带分类文字色与同色淡底，
     select 本体跟着当前选中项换色，深色主题自动派生浅色文字。 */
  function optionPaint(p, col) {
    return ' style="color:' + catInk(p, col) + ';background-color:' + mixColor(col, p.surface, .86) + ';"';
  }
  function paintSelect(sel) {
    if (!sel) return;
    var opt = sel.options[sel.selectedIndex];
    if (!opt) return;
    var c = opt.getAttribute('data-c') || '';
    if (!c) { sel.style.color = ''; sel.style.backgroundColor = ''; sel.style.borderColor = ''; return; }
    var p = palette();
    sel.style.color = catInk(p, c);
    sel.style.backgroundColor = mixColor(c, p.surface, .9);
    sel.style.borderColor = mixColor(c, p.border, .55);
  }
  function fillQuickCats() {
    var sel = $('qCategory');
    if (!sel) return;
    var cats = quickType === 'income' ? INCOME_CATS : EXPENSE_CATS;
    var p = palette();
    sel.innerHTML = cats.map(function (c) {
      var col = catColor(p, c);
      return '<option value="' + esc(c) + '" data-c="' + col + '"' + optionPaint(p, col) + '>' + esc(c) + '</option>';
    }).join('');
    paintSelect(sel);
    fillQuickSubs();
  }
  function fillQuickSubs() {
    var sel = $('qSub');
    if (!sel) return;
    var cat = ($('qCategory') && $('qCategory').value) || '餐饮';
    var p = palette(), base = catColor(p, cat), names = subCatNames(cat);
    sel.innerHTML = '<option value="" data-c="' + base + '"' + optionPaint(p, base) + '>自动识别</option>' +
      names.map(function (n, i) {
        var step = names.length <= 1 ? .1 : (i / Math.max(1, names.length - 1)) * .5;
        var col = mixColor(base, p.surface, .1 + step * .45);
        return '<option value="' + esc(n) + '" data-c="' + col + '"' + optionPaint(p, col) + '>' + esc(n) + '</option>';
      }).join('');
    paintSelect(sel);
  }
  /* 每日体重：和账目共用 store / localStorage / 云同步，按日期一个键 */
  function submitWeight(e) {
    e.preventDefault();
    var inp = $('weightInput');
    var v = Number(inp && inp.value);
    if (!isFinite(v) || v < 20 || v > 300) { toast('体重请填 20 — 300 kg', 'warn'); return; }
    var key = $('weightDate') ? $('weightDate').value : dateKey(anchorDate());
    state.store.weights = state.store.weights || {};
    state.store.weights[key] = Math.round(v * 10) / 10;
    if (!Array.isArray(state.store.weightCleared)) state.store.weightCleared = [];
    state.store.weightCleared = state.store.weightCleared.filter(function (k) { return k !== key; });
    saveStore();
    renderAll();
    toast('已记录 ' + state.store.weights[key].toFixed(1) + ' kg', 'success');
  }
  function clearWeight() {
    var key = $('weightDate') ? $('weightDate').value : dateKey(anchorDate());
    if (state.store.weights) delete state.store.weights[key];
    if (!Array.isArray(state.store.weightCleared)) state.store.weightCleared = [];
    if (state.store.weightCleared.indexOf(key) === -1) state.store.weightCleared.push(key);
    saveStore();
    renderAll();
    toast('已删除这天的体重', 'info');
  }
  function submitQuick(e) {
    e.preventDefault();
    var err = $('qError');
    var msg = commitEntry({
      amount: $('qAmount') ? $('qAmount').value : '',
      date: $('qDate') ? $('qDate').value : '',
      type: quickType,
      category: $('qCategory') ? $('qCategory').value : '',
      sub: $('qSub') ? $('qSub').value : '',
      note: $('qNote') ? $('qNote').value : ''
    });
    if (msg) { if (err) { err.textContent = msg; err.hidden = false; } return; }
    if (err) { err.hidden = true; err.textContent = ''; }
  }

  function fillCategoryOptions() {
    var sel = $('fCategory');
    if (!sel) return;
    var cats = state.entryType === 'income' ? INCOME_CATS : EXPENSE_CATS;
    var cur = sel.value, p = palette();
    sel.innerHTML = cats.map(function (c) {
      var col = catColor(p, c);
      return '<option value="' + esc(c) + '" data-c="' + col + '"' + optionPaint(p, col) + '>' + esc(c) + '</option>';
    }).join('');
    if (cats.indexOf(cur) !== -1) sel.value = cur;
    paintSelect(sel);
    fillSubOptions();
  }
  function fillSubOptions(preferred) {
    var sel = $('fSub');
    if (!sel) return;
    var cat = ($('fCategory') && $('fCategory').value) || (state.entryType === 'income' ? '收入' : '餐饮');
    var names = subCatNames(cat), p = palette(), base = catColor(p, cat);
    sel.innerHTML = '<option value="" data-c="' + base + '"' + optionPaint(p, base) + '>自动识别</option>' +
      names.map(function (n, i) {
        var step = names.length <= 1 ? .1 : (i / Math.max(1, names.length - 1)) * .5;
        var col = mixColor(base, p.surface, .1 + step * .45);
        return '<option value="' + esc(n) + '" data-c="' + col + '"' + optionPaint(p, col) + '>' + esc(n) + '</option>';
      }).join('');
    if (preferred && names.indexOf(preferred) !== -1) sel.value = preferred;
    paintSelect(sel);
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
  /* 弹窗与天页内嵌表单共用的落库入口：校验、组装、存增量层、重绘。
     返回空串表示成功，否则返回可直接展示的错误文案。 */
  function commitEntry(v) {
    var amount = Number(v.amount);
    if (!isFinite(amount) || amount <= 0) return '请输入大于 0 的金额。';
    if (!v.date || !/^\d{4}-\d{2}-\d{2}$/.test(v.date)) return '请选择有效日期。';
    var rawNote = String(v.note || '').trim();
    var rec = {
      id: v.editingId || ('u' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7)),
      date: v.date, type: v.type === 'income' ? 'income' : 'expense',
      category: v.category || (v.type === 'income' ? '收入' : '娱乐'),
      note: canonNote(rawNote),
      amount: round(amount)
    };
    /* 子类：选了就用选的，留空交给关键词匹配 */
    if (v.sub) { rec.sub = v.sub; rec.subExplicit = true; }
    if (!rec.note) rec.note = rec.category;
    if (v.editingId) {
      state.store.edited[v.editingId] = rec;
      toast('已更新「' + rec.note + '」', 'info');
    } else {
      state.store.added.push(rec);
      toast('已记下 ' + fmtYuan(rec.amount), 'success');
    }
    saveStore();
    renderAll();
    return '';
  }
  function submitEntry(e) {
    e.preventDefault();
    var err = $('formError');
    var msg = commitEntry({
      editingId: state.editingId,
      amount: $('fAmount') ? $('fAmount').value : '',
      date: $('fDate') ? $('fDate').value : '',
      type: state.entryType,
      category: $('fCategory') ? $('fCategory').value : '',
      sub: $('fSub') ? $('fSub').value : '',
      note: $('fNote') ? $('fNote').value : ''
    });
    if (msg) { if (err) { err.textContent = msg; err.hidden = false; } return; }
    closeModal();
  }

  /* ---------------- 弹窗：删除确认 ---------------- */
  function openConfirm(id) {
    state.pendingDeleteId = id;
    var rec = allRecords().filter(function (r) { return r.id === id; })[0];
    if ($('confirmDesc') && rec) $('confirmDesc').textContent = rec.date + ' · ' + rec.note + ' · ' + fmtYuan(rec.amount) + '，删除后不可撤销。';
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

  /* 换肤：光晕已取消。只做一次 token + 图表配色的同步替换，
     不生成覆盖层、不读写布局、不设切换锁，连点也能立刻响应。
     底色与卡面本来就没有 background-color 过渡，所以是干净的一帧切换。 */
  function setTheme(t) {
    if (t === state.theme) return;
    applyTheme(t, true);
    renderCharts(state.view, 'instant');
  }

  /* 配色自定义的读写口子，条目定义在 CAT_COLOR_DEFS */
  function bindColorPanel() {
    var btn = $('colorBtn'), pop = $('colorPop');
    if (!btn || !pop) return;
    btn.addEventListener('click', function () {
      var open = pop.hasAttribute('hidden');
      if (open) { pop.removeAttribute('hidden'); requestAnimationFrame(function () { pop.classList.add('is-open'); }); }
      else { closeColorPanel(); }
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    if ($('cpClose')) $('cpClose').addEventListener('click', closeColorPanel);
    if ($('cpReset')) $('cpReset').addEventListener('click', function () {
      state.catColors = {};
      try { localStorage.removeItem(CATCOLOR_KEY); } catch (e) { /* noop */ }
      applyCatColors();
      buildColorRows();
      refreshAfterColor();
      toast('配色已恢复默认', 'info');
    });
    buildColorRows();
  }
  function closeColorPanel() {
    var pop = $('colorPop'), btn = $('colorBtn');
    if (!pop) return;
    pop.classList.remove('is-open');
    setTimeout(function () { if (!pop.classList.contains('is-open')) pop.setAttribute('hidden', ''); }, 200);
    if (btn) btn.setAttribute('aria-expanded', 'false');
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
    bindSeg($('calendarYear'), 'data-cy', function (v) {
      state.calendarYear = Number(v);
      renderCalendar(palette());
    });
    bindSeg($('annualScope'), 'data-ay', function (v) {
      state.annualScope = v === 'both' ? 'both' : v;
      renderAnnual(palette());
    });

    if ($('themeBtn')) $('themeBtn').addEventListener('click', function () {
      setTheme(state.theme === 'dark' ? 'light' : 'dark');
    });
    bindColorPanel();

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
    if ($('fCategory')) $('fCategory').addEventListener('change', function () { paintSelect($('fCategory')); fillSubOptions(); });
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
    if ($('cmpPrev')) $('cmpPrev').addEventListener('click', function () { shiftCmp(-1); });
    if ($('cmpNext')) $('cmpNext').addEventListener('click', function () { shiftCmp(1); });
    var cmpMonths = $('cmpMonths');
    if (cmpMonths) cmpMonths.addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.year) {
        setCalMonth(Number(b.dataset.year), state.calMonth.month); closeCmp(); return;
      }
      if (b.dataset.month) {
        setCalMonth(cmpYear, Number(b.dataset.month)); closeCmp(); return;
      }
      if (b.dataset.weekStart) {
        state.scale = 'week';
        setSegActive($('scaleSeg'), 'data-scale', 'week');
        setAnchor(new Date(b.dataset.weekStart + 'T00:00:00'));
        state.focusDate = '';
        renderBoard(); renderCharts('calendar'); closeCmp(); return;
      }
      if (b.dataset.date) {
        jumpToDay(b.dataset.date); closeCmp(); return;
      }
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
    /* 分类 / 子类两条等宽分段控件，事件委托在稳定的 .ct-filters 上 */
    var catBar = document.querySelector('.ct-filters');
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
        return;
      }
      var qk = e.target.closest('button[data-quick]');
      if (qk) { applyQuick(qk.dataset.quick); return; }
      var spec = null;
      ['amount', 'weekday'].some(function (k) {
        var b = e.target.closest('button[data-' + k + ']');
        if (b) { spec = { k: k, v: b.dataset[k] }; return true; }
        return false;
      });
      if (spec) {
        var f = state.filters;
        var nv = spec.v === 'all' ? 'all' : (f[spec.k] === spec.v ? 'all' : spec.v);
        f[spec.k] = nv;
        if (spec.k === 'weekday') f.weekday = nv;
        syncFilterUI(); renderBoard();
      }
    });
    function resetBoardFilters() {
      state.filters = { q: '', type: 'all', category: 'all', sub: 'all', weekday: 'all', amount: 'all', quick: '' };
      state.focusDate = '';
      syncFilterUI(); renderBoard();
    }
    if ($('resetFilters')) $('resetFilters').addEventListener('click', function () {
      resetBoardFilters(); toast('筛选条件已重置', 'info');
    });
    if ($('boardReset')) $('boardReset').addEventListener('click', resetBoardFilters);
    if ($('exportBtn')) $('exportBtn').addEventListener('click', exportCsv);

    /* 棋盘：条目 / 空格 / 更多 / 年视图小格 —— 全部走一张委托表 */
    var boardEl = document.querySelector('.cal-board');
    if (boardEl) boardEl.addEventListener('click', function (e) {
      var qt = e.target.closest('[data-qtype]');
      if (qt) {
        quickType = qt.dataset.qtype === 'income' ? 'income' : 'expense';
        var qbs = document.querySelectorAll('#quickEntryForm [data-qtype]');
        for (var qi = 0; qi < qbs.length; qi++) qbs[qi].classList.toggle('is-active', qbs[qi].dataset.qtype === quickType);
        var qSeg = $('qTypeSeg');
        if (qSeg) {
          var qI = quickType === 'income' ? 1 : 0;
          qSeg.dataset.active = String(qI);
          qSeg.style.setProperty('--seg-i', String(qI));
          resetSegInd(qSeg);
        }
        fillQuickCats();
        return;
      }

      /* 「关于这一天」里的柱/格/折线点都带日期，点一下就翻到那天 */
      var jd = e.target.closest('[data-jump-day]');
      if (jd) { jumpToDay(jd.dataset.jumpDay); return; }

      var more = e.target.closest('[data-more]');
      if (more) { jumpToDay(more.dataset.more); return; }

      var ymHead = e.target.closest('.ym-head[data-month]');
      if (ymHead) { gotoMonth(state.calMonth.year, Number(ymHead.dataset.month)); return; }

      var ym = e.target.closest('.ym-day[data-date]');
      if (ym) { jumpToDay(ym.dataset.date); return; }

      var add = e.target.closest('[data-add]');
      if (add) { openModal(null, add.dataset.add); return; }

      var item = e.target.closest('[data-id]');
      if (item) {
        /* 月/周格子里的条目也算格子的一部分：切到天视图看当日明细。
           天页里点具体那一笔才进编辑，明细分类行同理。 */
        var holder = item.closest('.cal-cell[data-date], .wk-col[data-date]');
        if (holder) { jumpToDay(holder.dataset.date); return; }
        var rec = allRecords().filter(function (r) { return r.id === item.dataset.id; })[0];
        if (rec) openModal(rec);
        return;
      }

      var cell = e.target.closest('.cal-cell[data-date]');
      if (cell && cell.dataset.other === '0') { tapDay(cell.dataset.date); return; }

      var wk = e.target.closest('.wk-col[data-date]');
      if (wk) tapDay(wk.dataset.date);
    });

    /* 天页内嵌表单是每次重绘都重建的，事件只能委托在稳定的 .cal-board 上 */
    if (boardEl) {
      boardEl.addEventListener('submit', function (e) {
        if (e.target && e.target.id === 'quickEntryForm') submitQuick(e);
        if (e.target && e.target.id === 'weightForm') submitWeight(e);
      });
      boardEl.addEventListener('change', function (e) {
        if (e.target && e.target.id === 'qCategory') { paintSelect($('qCategory')); fillQuickSubs(); }
        if (e.target && e.target.id === 'qSub') paintSelect($('qSub'));
        if (e.target && e.target.id === 'fSub') paintSelect($('fSub'));
      });
      boardEl.addEventListener('click', function (e) {
        if (e.target.closest && e.target.closest('#weightClear')) { clearWeight(); return; }
        if (e.target.closest && e.target.closest('[data-focus-weight]')) {
          var wi = $('weightInput');
          if (wi) { wi.focus(); if (wi.select) wi.select(); }
        }
      });
    }

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

  /* 格子与年历的小日子走同一条路：切到「天」视图看那一整天的明细。
     天页本身就是当日明细，左侧还带内嵌记账表单。 */
  function tapDay(key) {
    jumpToDay(key);
  }


  function jumpFromKpi(kind) {
    if (kind === 'income') { jumpToDetail({ reset: true, type: 'income', label: '已筛选：全部收入' }); return; }
    if (kind === 'expense') { jumpToDetail({ reset: true, type: 'expense', label: '已筛选：全部支出' }); return; }
    if (kind === 'rate') { setView('overview'); toast('已打开总览 · 年度分析', 'info'); return; }
    jumpToDetail({ reset: true, label: '已跳转日历' });
  }

  /* ---------------- 启动 ---------------- */
  /* 全局悬浮提示：接管原生 title 与动态图表的 data-tip。
     气泡固定在鼠标上方、pointer-events:none，永远不会被光标挡住。 */
  function bindHoverTip() {
    var tip = $('hoverTip');
    if (!tip) return;
    var active = null;
    function place(x, y) {
      var w = tip.offsetWidth || 160, h = tip.offsetHeight || 34;
      var px = Math.max(w / 2 + 8, Math.min(window.innerWidth - w / 2 - 8, x));
      var py = Math.max(h + 10, y - 14);
      tip.style.left = px + 'px';
      tip.style.top = py + 'px';
    }
    document.addEventListener('mouseover', function (e) {
      if (!e.target || typeof e.target.closest !== 'function') return;
      var el = e.target.closest('[title], [data-tip]');
      if (!el) return;
      var text = el.getAttribute('data-tip') || el.getAttribute('title') || '';
      if (!text) return;
      if (el.hasAttribute('title')) {
        el.__nativeTip = el.getAttribute('title');
        el.removeAttribute('title');
      }
      active = el;
      tip.textContent = text;
      tip.hidden = false;
      place(e.clientX, e.clientY);
    });
    document.addEventListener('mousemove', function (e) {
      if (active && !tip.hidden) place(e.clientX, e.clientY);
    });
    document.addEventListener('mouseout', function (e) {
      if (!active) return;
      if (e.relatedTarget && active.contains(e.relatedTarget)) return;
      if (active.__nativeTip) {
        active.setAttribute('title', active.__nativeTip);
        active.__nativeTip = '';
      }
      active = null;
      tip.hidden = true;
    });
  }

  /* ---------------- 总览：可拖动 / 可缩放的板块布局 ----------------
     12 列栅格，每块记 [列宽, 行高]；拖动改 DOM 顺序，右下角手柄改跨度。
     保存后进 localStorage，并随云同步的 state.json 一起走 —— 换设备拿到
     同一份排布；要固化成默认，把保存下来的 JSON 抄进 DEFAULT_LAYOUT 即可。 */
  var LAYOUT_KEY = 'qingzhang.overview.layout.v1';
  var OV_COLS = 12;
  var DEFAULT_LAYOUT = {
    v: 1,
    order: ['kpi', 'trend', 'donut', 'balance', 'weight', 'metrics', 'divider', 'annual',
      'calheat', 'stack', 'top'],
    spans: {
      kpi: [12, 3], trend: [12, 7], donut: [6, 7], balance: [6, 7], weight: [12, 6],
      metrics: [12, 10], divider: [12, 1], annual: [12, 7],
      calheat: [12, 8], stack: [12, 7], top: [12, 7]
    }
  };
  var ovGrid = null, ovEditing = false;
  var OV_CHART_IDS = {
    chartTrend: 'trend', chartDonut: 'donut', chartBalance: 'balance',
    chartCalendar: 'calheat', chartStack: 'stack',
    chartTop: 'top', chartWeight: 'weight'
  };
  function ovIdOf(el) {
    if (el.getAttribute && el.getAttribute('data-oid')) return el.getAttribute('data-oid');
    var c = el.querySelector('.chart[id]');
    if (c) return OV_CHART_IDS[c.id] || c.id;
    if (el.classList.contains('stat-strip')) return 'kpi';
    if (el.classList.contains('stat-mini')) return 'mini';
    if (el.classList.contains('merged-head')) return 'divider';
    if (el.classList.contains('annual-card')) return 'annual';
    return 'p' + Math.random().toString(36).slice(2, 7);
  }
  function ovTitleOf(el) {
    var h = el.querySelector('h3, h2');
    if (h) return h.textContent.trim();
    if (el.classList.contains('stat-strip')) return '收支总览';
    if (el.classList.contains('stat-mini')) return '本月速览';
    return '板块';
  }
  function validLayout(L) {
    return !!(L && L.v === 1 && Array.isArray(L.order) && L.spans && typeof L.spans === 'object');
  }
  function readLayout() {
    try { var o = JSON.parse(localStorage.getItem(LAYOUT_KEY)); if (validLayout(o)) return o; } catch (e) { /* noop */ }
    return null;
  }
  function writeLayout(L) {
    try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(L)); } catch (e) { /* noop */ }
  }
  function setOvSpan(el, w, h) {
    el.dataset.ovW = String(w);
    el.dataset.ovH = String(h);
    el.style.gridColumn = 'span ' + w;
    el.style.gridRow = 'span ' + h;
  }
  function collectLayout() {
    var L = { v: 1, order: [], spans: {} };
    if (!ovGrid) return L;
    Array.prototype.forEach.call(ovGrid.children, function (el) {
      if (!el.classList || !el.classList.contains('ov-panel')) return;
      var id = el.dataset.ovId;
      L.order.push(id);
      L.spans[id] = [Number(el.dataset.ovW) || 12, Number(el.dataset.ovH) || 6];
    });
    return L;
  }
  function applyLayout(L) {
    if (!ovGrid || !validLayout(L)) return;
    var byId = {}, i;
    Array.prototype.forEach.call(ovGrid.children, function (el) {
      if (el.dataset && el.dataset.ovId) byId[el.dataset.ovId] = el;
    });
    for (i = 0; i < L.order.length; i++) {
      var el = byId[L.order[i]];
      if (!el) continue;
      ovGrid.appendChild(el);
      delete byId[L.order[i]];
    }
    Object.keys(byId).forEach(function (id) { ovGrid.appendChild(byId[id]); });
    Array.prototype.forEach.call(ovGrid.children, function (el) {
      var sp = (L.spans && L.spans[el.dataset.ovId]) || [12, 6];
      setOvSpan(el,
        Math.max(3, Math.min(OV_COLS, Number(sp[0]) || 12)),
        Math.max(1, Math.min(20, Number(sp[1]) || 6)));
    });
    requestAnimationFrame(resizeAll);
  }
  function initOverviewLayout() {
    var view = $('view-overview');
    if (!view) return;
    var grid = document.createElement('div');
    grid.className = 'ov-grid';
    grid.id = 'overviewGrid';
    var panels = [], wrappers = [];
    Array.prototype.slice.call(view.children).forEach(function (node) {
      if (!node.classList) return;
      if (node.id === 'ovToolbar') return;
      if (node.classList.contains('chart-grid')) {
        wrappers.push(node);
        Array.prototype.slice.call(node.children).forEach(function (c) { panels.push(c); });
      } else panels.push(node);
    });
    panels.forEach(function (el) {
      el.classList.add('ov-panel');
      el.dataset.ovId = ovIdOf(el);
      var grip = document.createElement('button');
      grip.type = 'button';
      grip.className = 'ov-grip';
      grip.dataset.ovDrag = '1';
      grip.title = '拖动调整位置';
      grip.setAttribute('aria-label', '拖动调整「' + ovTitleOf(el) + '」的位置');
      grip.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="9" cy="6" r="1.5"/><circle cx="15" cy="6" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="9" cy="18" r="1.5"/><circle cx="15" cy="18" r="1.5"/></svg>';
      var rz = document.createElement('span');
      rz.className = 'ov-resize';
      rz.dataset.ovResize = '1';
      rz.title = '拖动调整大小';
      el.appendChild(grip);
      el.appendChild(rz);
      grid.appendChild(el);
    });
    wrappers.forEach(function (w) { if (w.parentNode) w.parentNode.removeChild(w); });
    view.appendChild(grid);
    ovGrid = grid;
    applyLayout(validLayout(state.layout) ? state.layout : DEFAULT_LAYOUT);
    bindOverviewEditor();
  }
  function bindOverviewEditor() {
    var editBtn = $('ovEditBtn'), saveBtn = $('ovSaveBtn'), resetBtn = $('ovResetBtn'),
      copyBtn = $('ovCopyBtn'), hint = $('ovHint');
    if (editBtn) editBtn.addEventListener('click', function () {
      ovEditing = !ovEditing;
      var view = $('view-overview');
      if (view) view.classList.toggle('is-editing', ovEditing);
      editBtn.setAttribute('aria-pressed', String(ovEditing));
      editBtn.classList.toggle('is-on', ovEditing);
      [saveBtn, resetBtn, copyBtn].forEach(function (b) { if (b) b.hidden = !ovEditing; });
      if (hint) hint.textContent = ovEditing
        ? '拖左上角手柄换位置，拖右下角改大小，排好点「保存布局」'
        : '点「排列布局」可自由调整各板块的位置与大小';
      requestAnimationFrame(resizeAll);
    });
    if (saveBtn) saveBtn.addEventListener('click', function () {
      var L = collectLayout();
      L.savedAt = new Date().toISOString();
      state.layout = L;
      writeLayout(L);
      saveStore();                 /* 触发云同步钩子，layout 随 state.json 一起推走 */
      toast('布局已保存，并已加入云同步', 'success');
    });
    if (resetBtn) resetBtn.addEventListener('click', function () {
      state.layout = null;
      try { localStorage.removeItem(LAYOUT_KEY); } catch (e) { /* noop */ }
      applyLayout(DEFAULT_LAYOUT);
      saveStore();
      toast('已恢复默认布局', 'info');
    });
    if (copyBtn) copyBtn.addEventListener('click', function () {
      var txt = JSON.stringify(collectLayout());
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(txt).then(
          function () { toast('布局代码已复制', 'success'); },
          function () { window.prompt('复制这段布局代码', txt); });
      } else window.prompt('复制这段布局代码', txt);
    });
    bindOvPointer();
  }
  /* 指针拖拽：ghost 跟随光标，落点用 elementFromPoint 找目标板块，
     插入前/后由光标相对目标中心决定；缩放按栅格列宽与行高换算跨度。 */
  function bindOvPointer() {
    if (!ovGrid) return;
    var act = null, ghost = null;
    function clearTargets() {
      Array.prototype.forEach.call(ovGrid.querySelectorAll('.is-drop-target'),
        function (x) { x.classList.remove('is-drop-target'); });
    }
    function moveGhost(e) {
      if (!ghost || !act) return;
      ghost.style.left = (e.clientX - act.ox) + 'px';
      ghost.style.top = (e.clientY - act.oy) + 'px';
    }
    /* 页面很长：拖到视口上下边缘时自动滚，才能把底部的板块搬到顶上 */
    function updateTarget(e) {
      clearTargets();
      act.target = null;
      var under = document.elementFromPoint(e.clientX, e.clientY);
      var t = under && under.closest ? under.closest('.ov-panel') : null;
      if (t && t !== act.panel && t.parentNode === ovGrid) {
        t.classList.add('is-drop-target');
        act.target = t;
        var tr = t.getBoundingClientRect();
        var midY = tr.top + tr.height / 2, midX = tr.left + tr.width / 2;
        act.after = e.clientY > midY || (Math.abs(e.clientY - midY) < tr.height / 3 && e.clientX > midX);
      }
    }
    function autoScroll() {
      if (!act || act.mode !== 'drag') return;
      var y = act.lastY || 0;
      if (y > window.innerHeight - 72) window.scrollBy(0, 16);
      else if (y < 72 && window.scrollY > 0) window.scrollBy(0, -16);
      if (act.lastX !== undefined) updateTarget({ clientX: act.lastX, clientY: act.lastY });
      act.scrollTimer = setTimeout(autoScroll, 16);
    }
    function onDown(e) {
      if (!ovEditing || !e.target || typeof e.target.closest !== 'function') return;
      var g = e.target.closest('[data-ov-drag]'), r = e.target.closest('[data-ov-resize]');
      if (!g && !r) return;
      var panel = (g || r).closest('.ov-panel');
      if (!panel) return;
      e.preventDefault();
      var rect = panel.getBoundingClientRect();
      if (g) {
        ghost = document.createElement('div');
        ghost.className = 'ov-ghost';
        ghost.textContent = ovTitleOf(panel);
        ghost.style.width = rect.width + 'px';
        ghost.style.height = rect.height + 'px';
        document.body.appendChild(ghost);
        panel.classList.add('is-drag-src');
        act = {
          mode: 'drag', panel: panel, ox: e.clientX - rect.left, oy: e.clientY - rect.top,
          lastX: e.clientX, lastY: e.clientY, scrollTimer: null
        };
        moveGhost(e);
        autoScroll();
      } else {
        var gr = ovGrid.getBoundingClientRect(), cs = window.getComputedStyle(ovGrid);
        var gap = parseFloat(cs.columnGap) || 12;
        var colU = (gr.width - gap * (OV_COLS - 1)) / OV_COLS + gap;
        var rowU = (parseFloat(cs.gridAutoRows) || 46) + (parseFloat(cs.rowGap) || 12);
        panel.classList.add('is-resizing');
        act = {
          mode: 'resize', panel: panel, x: e.clientX, y: e.clientY, colU: colU, rowU: rowU,
          w: Number(panel.dataset.ovW) || 12, h: Number(panel.dataset.ovH) || 6
        };
      }
      document.body.classList.add('is-ov-dragging');
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
    }
    function onMove(e) {
      if (!act) return;
      if (act.mode === 'drag') {
        act.lastX = e.clientX; act.lastY = e.clientY;
        moveGhost(e);
        updateTarget(e);
      } else {
        var dw = Math.round((e.clientX - act.x) / act.colU);
        var dh = Math.round((e.clientY - act.y) / act.rowU);
        setOvSpan(act.panel,
          Math.max(3, Math.min(OV_COLS, act.w + dw)),
          Math.max(2, Math.min(18, act.h + dh)));
        requestAnimationFrame(resizeAll);
      }
    }
    function onUp() {
      if (!act) return;
      if (act.scrollTimer) clearTimeout(act.scrollTimer);
      if (act.mode === 'drag' && act.target) {
        var t = act.target, p = act.panel;
        try {
          if (act.after) t.parentNode.insertBefore(p, t.nextSibling);
          else t.parentNode.insertBefore(p, t);
        } catch (err) { /* 目标已脱离 DOM 时忽略 */ }
      }
      if (act.panel) act.panel.classList.remove('is-drag-src', 'is-resizing');
      if (ghost && ghost.parentNode) ghost.parentNode.removeChild(ghost);
      ghost = null;
      clearTargets();
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.body.classList.remove('is-ov-dragging');
      act = null;
      requestAnimationFrame(resizeAll);
    }
    ovGrid.addEventListener('pointerdown', onDown);
  }

  /* 所有分段滑块：按住时滑块贴着指针走（软跟随，有重量但不拖沓），
     跨段时照常触发对应按钮；松手后立刻起步冲向目标段，落位前冲过一点再收回。
     最后一段用 easeOutBack —— 起步就是全速，不像 easeInOut 那样先愣一下。
     原生 click 在拖动后吞掉，避免重复触发。 */
  var SEG_CTRLS = [], SEG_DOC_BOUND = false;
  function segDocBind() {
    if (SEG_DOC_BOUND) return;
    SEG_DOC_BOUND = true;
    document.addEventListener('pointermove', function (e) {
      for (var i = 0; i < SEG_CTRLS.length; i++) SEG_CTRLS[i].move(e);
    });
    function allUp() { for (var i = 0; i < SEG_CTRLS.length; i++) SEG_CTRLS[i].up(); }
    document.addEventListener('pointerup', allUp);
    document.addEventListener('pointercancel', allUp);
  }
  function enableSegDrag(el) {
    if (!el || el.dataset.segDrag === '1') return;
    el.dataset.segDrag = '1';
    var act = null, suppress = false, raf = 0;
    var cur = 0, target = 0, unit = 1, pad = 4, trackW = 0;
    var REL_MS = 320, relT0 = 0, relFrom = 0, relTo = 0, releasing = false;

    function indEl() { return el.querySelector('.seg-ind'); }
    function btns() { return Array.prototype.slice.call(el.querySelectorAll('button')); }
    function activeIdx() {
      var k = 0;
      btns().forEach(function (b, i) { if (b.classList.contains('is-active')) k = i; });
      return k;
    }
    function metrics() {
      var r = el.getBoundingClientRect(), bs = btns();
      pad = parseFloat(getComputedStyle(el).paddingLeft) || 4;
      unit = Math.max(1, (r.width - pad * 2) / Math.max(1, bs.length));
      trackW = unit * Math.max(0, bs.length - 1);
      return r;
    }
    function idxAt(x) {
      return Math.max(0, Math.min(btns().length - 1, Math.round((x - act.rLeft - pad - unit / 2) / unit)));
    }
    function paint() {
      var n = indEl();
      if (!n) return;
      n.style.transition = 'none';
      n.style.transform = 'translateX(' + cur.toFixed(2) + 'px)';
    }
    /* 交还给 CSS：--seg-i 已经停在目标段上，内联一撤就是同一位置，看不出跳变 */
    function releaseTransform() {
      var n = indEl();
      if (!n) return;
      n.dataset.busy = '';
      n.style.transition = '';
      n.style.transform = '';
    }
    /* easeOutBack：t=0 时斜率最大（立刻起步），接近 1 时越过目标再回来。
       c1=1.05 → 过冲约 3.8%，一段 80px 的宽度上冲 3px 左右，够看出来，不夸张。 */
    function easeOutBack(t) {
      var c1 = 1.05, c3 = c1 + 1;
      return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
    }
    function tick(now) {
      if (releasing) {
        var t = Math.min(1, (now - relT0) / REL_MS);
        cur = relFrom + (relTo - relFrom) * easeOutBack(t);
        if (cur < -unit * .14) cur = -unit * .14;
        if (cur > trackW + unit * .14) cur = trackW + unit * .14;
        paint();
        if (t < 1) { raf = requestAnimationFrame(tick); }
        else { cur = relTo; paint(); releaseTransform(); releasing = false; raf = 0; }
        return;
      }
      if (!act) { raf = 0; return; }
      /* 拖拽中：软跟随，0.40 的插值让滑块几乎贴住指针但不失重 */
      cur += (target - cur) * .40;
      if (cur < -unit * .14) cur = -unit * .14;
      if (cur > trackW + unit * .14) cur = trackW + unit * .14;
      paint();
      if (Math.abs(target - cur) > .2) { raf = requestAnimationFrame(tick); }
      else { cur = target; paint(); raf = 0; }
    }
    function start() { if (!raf) raf = requestAnimationFrame(tick); }

    el.addEventListener('pointerdown', function (e) {
      if (e.button !== 0 || btns().length < 2) return;
      /* 上一次拖动留下的"吞掉下一次点击"标记必须在新的手势开始时清掉，
         否则指针在滑块外抬起（没触发 click）时，下一次点击会被无辜吃掉 */
      suppress = false;
      /* 上一段回弹还没走完就再次按下：停住它，从当前位置接着跟手 */
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      releasing = false;
      var n = indEl();
      if (n) { n.dataset.busy = '1'; n.style.transition = 'none'; }
      var r = metrics(), idx = activeIdx();
      cur = target = idx * unit;
      act = { x: e.clientX, y: e.clientY, rLeft: r.left, last: idx, moved: false };
    });
    function onMove(e) {
      if (!act) return;
      if (!act.moved && Math.abs(e.clientX - act.x) < 4 && Math.abs(e.clientY - act.y) < 4) return;
      if (!act.moved) { act.moved = true; el.classList.add('is-dragging'); }
      target = Math.max(-unit * .12, Math.min(trackW + unit * .12, e.clientX - act.rLeft - pad - unit / 2));
      var i = idxAt(e.clientX);
      if (i >= 0 && i !== act.last) {
        act.last = i;
        var b = btns()[i];
        if (b && !b.classList.contains('is-active')) b.click();
      }
      start();
    }
    function up() {
      if (!act) return;
      if (act.moved) {
        suppress = true;
        el.classList.remove('is-dragging');
        /* 松手不等待：当前位置直接起步，320ms 冲到目标段并回弹一下 */
        relFrom = cur;
        relTo = act.last * unit;
        relT0 = performance.now();
        releasing = true;
        act = null;
        if (raf) cancelAnimationFrame(raf);
        raf = requestAnimationFrame(tick);
        return;
      }
      /* 只是点了一下没拖动：把内联样式彻底交还 CSS，
         否则会出现"选项已经选了、滑块却还停在原地"的假死。 */
      act = null;
      releaseTransform();
    }
    el.addEventListener('click', function (e) {
      if (!suppress) return;
      suppress = false;
      e.stopPropagation();
      e.preventDefault();
    }, true);
    /* 文档级 pointer 事件只挂一次，所有滑块登记到 SEG_CTRLS 里统一分发；
       天页每次重绘都会重建表单，逐个 addEventListener 会一直堆积。 */
    SEG_CTRLS = SEG_CTRLS.filter(function (c) { return c.el && c.el.isConnected; });
    SEG_CTRLS.push({ el: el, move: onMove, up: up });
    segDocBind();
  }
  function enableSegDragAll() {
    Array.prototype.forEach.call(document.querySelectorAll('.seg'), enableSegDrag);
  }

  function init() {
    state.store = loadStore();
    mergeSeedWeights();
    var saved = null;
    try { saved = localStorage.getItem(THEME_KEY); } catch (e) { /* noop */ }
    state.theme = (saved === 'dark' || saved === 'light') ? saved : 'light';
    document.documentElement.setAttribute('data-theme', state.theme);

    loadCatColors();
    state.anchorDate = todayStr();
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', state.theme === 'dark' ? '#0d121c' : '#f5f7fa');

    buildSelectOptions();
    bindEvents();
    bindDatePicker();
    bindHoverTip();
    state.layout = readLayout();
    initOverviewLayout();
    syncFilterUI();
    setSegActive($('scaleSeg'), 'data-scale', state.scale);
    renderAll();
    enableSegDragAll();

    /* 默认打开日历；地址栏带深链（含旧的 #/analysis）则优先深链 */
    var initialRoute = parseRoute() || 'calendar';
    bindRoute();
    setView(initialRoute);

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
        weights: state.store.weights || {},
        weightCleared: state.store.weightCleared || [],
        theme: document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light',
        layout: state.layout || null
      };
    },
    setStore: function (s) {
      s = s || {};
      var before = JSON.stringify(state.store);
      var next = {
        added: Array.isArray(s.added) ? s.added : [],
        edited: (s.edited && typeof s.edited === 'object' && !Array.isArray(s.edited)) ? s.edited : {},
        deleted: Array.isArray(s.deleted) ? s.deleted : [],
        weights: cleanWeights(s.weights),
        weightCleared: cleanWeightCleared(s.weightCleared)
      };
      state.store = next;
      mergeSeedWeights();
      var changed = JSON.stringify(next) !== before;
      if (validLayout(s.layout)) {
        state.layout = s.layout;
        writeLayout(s.layout);
        applyLayout(s.layout);
      }
      /* 云端内容没变就什么也不做：每分钟轮询不再重建天页、不再重播入场动画 */
      if (changed) { saveStore(); renderAll(); }
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
