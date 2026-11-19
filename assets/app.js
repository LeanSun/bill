/* ============================================================
   轻账 · Ledger — 应用逻辑
   数据：公开版不含账单明细；私人数据由 assets/boot.js 门禁后注入
         window.BILL_DATA（私有仓库 private-data.json）
   图表：本地 echarts 5.5.1，无网络依赖
   存储：localStorage 保存新增 / 修改 / 删除，不改动源文件
   ============================================================ */
(function () {
  'use strict';

  /* 资源版本：本地静态页每次发布都得换 URL，否则浏览器会拿 max-age=600
     的旧副本 —— 改了样式/脚本却在页面上看不见，多半就是这一层。 */
  var ASSET_V = '1.0.47';

  /* ---------------- 常量 ----------------
     SEED / 年份不再是脚本加载时就算好的常量：私人数据要等门禁脚本
     fetch 完私有仓库才能用。这里先空着，applyDataset() 在 init 前灌进来。 */
  var SEED = [], SEED_WEIGHTS = {}, PY_MAP = {}, YEARS = [], Y_LAST = 2026;
  function applyDataset(d) {
    d = d || {};
    SEED = Array.isArray(d.records) ? d.records : [];
    /* 原始 xlsx 里的体重与拼音表：体重作为种子值，用户记录覆盖；拼音只服务搜索 */
    SEED_WEIGHTS = (d.weights && typeof d.weights === 'object') ? d.weights : {};
    PY_MAP = (d.pinyin && typeof d.pinyin === 'object') ? d.pinyin : {};
    /* 数据里实际出现过的年份，升序。年度分析、对比图、消费日历都从这里取，
       游客版 SEED 为空 → YEARS 为空 → 年份按钮只剩一个「全部」 */
    var m = {};
    SEED.forEach(function (r) {
      var y = Number(String(r.date || '').slice(0, 4));
      if (y > 1900) m[y] = true;
    });
    YEARS = Object.keys(m).map(Number).sort(function (a, b) { return a - b; });
    Y_LAST = YEARS[YEARS.length - 1] || 2026;
    state.calendarYear = Y_LAST;
    state.calMonth = { year: Y_LAST, month: new Date().getMonth() + 1 };
  }
  /* 门禁：没连上私有仓库，这台机器上就不该出现任何一条记录。
     判断在 assets/boot.js 里同步算好，这里只读结果。 */
  var LOCKED = !(window.QZGate && window.QZGate.ok);
  var STORE_KEY = 'qingzhang.ledger.v1';
  var THEME_KEY = 'qingzhang.theme.v1';
  var CATCOLOR_KEY = 'qingzhang.catcolors.v1';
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
     顺序即优先级——先列的子类先抢关键词，所以具体词在上、泛指词在下。
     关键词这一层刻意写宽：同义词、口语、简称、外卖平台、常见菜名都收进来，
     记一笔时写字的人不用管"标准词"是哪两个字（午饭 / 中饭 / 盒饭 都归三餐）。 */
  var SUBCATS = {
    '餐饮': [
      { name: '三餐', keys: ['早餐', '午餐', '晚餐', '夜宵', '早饭', '早点', '午饭', '中饭', '晚饭', '夜饭', '宵夜', '盒饭', '便当', '食堂', '下馆子', '聚餐', '吃饭', '包子', '馅饼', '面条', '热干面', '葱油饼', '炸鸡', '烧鸡', '鸡肉卷', 'KFC', '麦当劳', '饿了么', '美团', '火锅', '汤圆', '饺子', '馄饨', '牛排', '腊肠', '培根', '牛板筋', '豆腐', '玉米', '燕麦', '外卖', '快餐', '米线', '米粉', '螺蛳粉', '拉面', '拌面', '炒饭', '盖饭', '炒粉', '烧烤', '烤串', '炸串', '麻辣烫', '冒菜', '串串', '汉堡', '披萨', '寿司', '粥', '饼', '饭'] },
      { name: '零食', keys: ['零食', '薯片', '锅巴', '辣条', '干脆面', '饼干', '泡芙', '沙琪玛', '华夫饼', '牛角包', '面包', '面饼', '口香糖', '巧克力', '果冻', '坚果', '蟹棒', '鱼豆腐', '素肉', '手撕', '冰棍', '雪糕', '冰淇淋', '蛋糕', '蛋卷', '薯条', '爆米花', '鸡爪', '鸭脖', '瓜子', '糖果'] },
      { name: '饮料', keys: ['饮料', '可乐', '汽水', '奶茶', '咖啡', '牛奶', '果汁', '柠檬水', '冰红茶', '绿茶', '乌龙茶', '蜂蜜茶', '柠檬茶', '气泡水', '苏打水', '葡萄糖水', '菠萝啤', '格瓦斯', '奶啤', '啤酒', '酸奶', '西梅饮', '果茶', 'DHA', '矿泉水', '纯净水', '拿铁', '美式', '雪碧', '芬达', '脉动', '红牛', '水'] },
      { name: '水果', keys: ['水果', '桃子', '苹果', '香蕉', '西瓜', '橙', '葡萄', '梨', '草莓', '蓝莓', '西梅', '榴莲', '芒果', '樱桃', '车厘子', '柚子', '哈密瓜', '火龙果', '猕猴桃'] },
      { name: '超市', keys: ['超市', '菜市场', '买菜', '购物', '调料', '酱', '蘸料', '香油', '花生油', '核桃油', '白砂糖', '可可粉', '碱水面', '脱水', '底料', '料包', '鸡蛋', '面粉', '酱油', '醋', '食盐', '大米'] },
      { name: '其它', keys: [] }
    ],
    '日常': [
      { name: '房租', keys: ['房租', '物业'] },
      { name: '水电费', keys: ['水电费', '水费', '电费', '燃气', '煤气', '取暖', '采暖', '宽带', '网费', '物业费'] },
      { name: '酒店', keys: ['酒店', '民宿', '宾馆', '住宿'] },
      { name: '电子产品', keys: ['手机壳', '数据线', '电池', '鼠标垫', '手写笔', '平板', '显示器', '键盘', '鼠标', '充电', '耳机', '摄像', '补光灯', '镜头', '硬盘', '内存', '主板', '机箱', '电源', '散热', '固态', '钢化膜', '保护壳', '手柄', '连接线'] },
      { name: '家居百货', keys: ['抽纸', '卷纸', '纸巾', '毛巾', '洗衣液', '洗衣粉', '洁厕', '泡沫剂', '百洁布', '垃圾袋', '收纳', '衣架', '锅', '勺', '剪刀', '刀', '老虎钳', '指甲刀', '手套', '雨衣', '伞', '床单', '枕', '被', '床垫', '地毯', '垫', '马桶', '地漏', '填缝剂', '防油贴纸', '墙布', '除湿', '湿巾', '洗手液', '沐浴露', '洗发水', '洗面奶', '素颜霜', '面膜', '香薰', '喷雾', '口罩', '创可贴', '褪黑素', '打气筒', '胶水', '夹子', '瓶子', '盒子', '花盆', '花土', '花籽', '种子', '绿萝', '龟背竹', '君子兰', '文竹', '九里香', '鞋套', '鞋垫', '行李箱', '笔', '尺', '牙膏', '牙刷', '牙线', '护发素', '香皂', '肥皂', '柔顺剂', '拖把', '扫把', '簸箕', '抹布', '垃圾桶', '保鲜膜', '棉签', '灯泡', '插座'] },
      { name: '其它', keys: [] }
    ],
    '交通': [
      { name: '地铁', keys: ['地铁', '公交', '轨道', '轻轨'] },
      { name: '共享单车', keys: ['共享单车'] },
      { name: '火车票', keys: ['火车票', '高铁', '动车', '机票', '航班'] },
      { name: '打车', keys: ['打车', '打的', '滴滴', '网约车', '的士', '出租', '顺风车', '拼车', '停车', '过路费', '高速费', '加油', '油费', '洗车', '保养', '修车', '违章'] },
      { name: '其它', keys: [] }
    ],
    '服饰': [
      { name: '衣服', keys: ['短袖', 'T恤', '卫衣', '衬衫', '夹克', '外套', '冲锋衣', '防晒服', '雨披', '内裤', '袜', '帽', '围巾', '腰带', '背包', '吊坠', '挂件', '羽绒服', '大衣', '毛衣', '开衫', '马甲'] },
      { name: '裤子', keys: ['裤子', '短裤', '裙', '牛仔', '长裤', '运动裤'] },
      { name: '鞋', keys: ['鞋', '靴'] },
      { name: '床上用品', keys: ['床单', '枕', '被', '床垫', '毛毯', '毯', '凉席', '四件套'] },
      { name: '其它', keys: [] }
    ],
    '娱乐': [
      { name: '魔方', keys: ['魔方', '魔表', '五阶', '六七阶', '天马', '威龙', '傲速', '补件', '磁铁', '贴纸'] },
      { name: '订阅服务', keys: ['iCloud', '会员', '网盘', '迅雷', '订阅'] },
      { name: '话费', keys: ['话费', '短信费', '流量'] },
      { name: '学习', keys: ['教材', '考试报名', '资料费', '书籍', '荧光笔', '涂卡笔', '印台', '网课', '课程', '课本', '试卷', '打印', '复印', '文具', '笔袋', '学费', '培训', '报名', '书'] },
      { name: '比赛', keys: ['比赛', '台球', '扑克', '俄挺', '单杠', '握力器'] },
      { name: '电子产品', keys: ['平板', 'RTX', 'I5', '主板', '内存条', '固态硬盘', '移动硬盘', '机箱', '电源', '散热', '摄像', '手写笔', '数据线', '鼠标垫', '电池', '补光灯', '显示器', '键盘', '手柄', '保护壳', '钢化膜', '连接线', '扎带', '修打印机'] },
      { name: '人情往来', keys: ['随礼', '红包', '生日', '妇女节', '母亲节', '一日捐', '人情'] },
      { name: '其它', keys: [] }
    ],
    '收入': [
      { name: '工资', keys: ['工资', '薪资', '薪水', '月薪', '发薪', '基本工资', '薪酬', '劳务'] },
      { name: '津贴', keys: ['津贴', '补贴', '高温费', '过节费', '过节', '饭补', '餐补', '车补', '房补', '补助'] },
      { name: '绩效', keys: ['绩效', '奖金', '年终奖', '加班费', '裁判费', '提成', '分红', '奖励', '全勤', '季度奖', '十三薪'] },
      { name: '其它', keys: ['报销', '报销款', '利息', '返现', '中奖', '收入', '转入', '收到'] }
    ]
  };
  /* 子类展示顺序照他给的清单来；自动识别的优先级走 SUBCATS 的排列，两者各管一段 */
  var SUB_ORDER = {
    '日常': ['房租', '水电费', '家居百货', '酒店', '电子产品', '其它'],
    '娱乐': ['魔方', '比赛', '电子产品', '订阅服务', '话费', '人情往来', '学习', '其它']
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
    filters: { q: '', type: 'all', category: 'all', sub: 'all', weekday: 'all', amount: 'all' },
    editingId: null,
    entryType: 'expense',
    pendingDeleteId: null,
    /* v1.0.39：刚存下的那笔。记完账最想知道「它在哪儿」，
       这里留 id + 一个到期时间戳，条目渲染时据此打上 is-new。 */
    newId: '',
    newUntil: 0,
    donutYear: 'all',
    weightYear: 'all',
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
    overview: ['总览', '收支总览与图表，汇总在同一页。'],
    calendar: ['日历', '一个月的所有流水，尽在一页日历。点格子记一笔，双击看当天明细。'],
    cube: ['魔方', '魔方收藏、比赛记录与润滑油指南。独立数据，不进收支账。']
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

  /* 最近记录条里的金额：三位数以内保留一位小数，别把 20.8 四舍五入成 21；
     上千才走整数 + 千位分隔，窄条里也放得下 */
  function fmtTiny(n) {
    var v = Number(n) || 0;
    if (Math.abs(v) >= 1000) return Math.round(v).toLocaleString('zh-CN');
    return String(Math.round(v * 10) / 10);
  }
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
    /* 深色底上，很暗的分类色（比如 #490033）直接铺上去几乎和背景融成一块。
       这里按亮度补一档白：色相不变，块面回来。浅色主题原样返回，
       所以自定义的那组值在两种主题里是同一种颜色，只是暗色下提亮半个档。 */
    var dark = document.documentElement.getAttribute('data-theme') === 'dark';
    function adapt(c) { return dark && lum(c) < .26 ? mixColor(c, '#ffffff', .48) : c; }
    return {
      primary: v('--primary', '#4a6cf7'),
      primary2: v('--primary-2', '#6d8bff'),
      income: adapt(v('--income', '#e04a4a')),
      expense: v('--expense', '#10a06a'),
      danger: v('--danger', '#e5484d'),
      amber: v('--amber', '#f0a52a'),
      violet: v('--violet', '#8b5cf6'),
      sky: v('--sky', '#38a9e8'),
      catFood: adapt(v('--cat-food', '#ffc000')),
      catDaily: adapt(v('--cat-daily', '#490033')),
      catTravel: adapt(v('--cat-travel', '#264465')),
      catWear: adapt(v('--cat-wear', '#8b5cf6')),
      catFun: adapt(v('--cat-fun', '#0000e4')),
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
    { key: '餐饮', name: '餐饮', css: '--cat-food', def: '#ffc000' },
    { key: '日常', name: '日常', css: '--cat-daily', def: '#490033' },
    { key: '交通', name: '交通', css: '--cat-travel', def: '#264465' },
    { key: '服饰', name: '服饰', css: '--cat-wear', def: '#8b5cf6' },
    { key: '娱乐', name: '娱乐', css: '--cat-fun', def: '#0000e4' },
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
  /* 换色后所有依赖分类色的东西都要重画：图表、筛选滑块、明细条、总览数字 */
  function refreshAfterColor() {
    renderCharts(state.view, 'instant');
    if (state.view === 'calendar') renderBoard();
    renderKpis();
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
  /* 社保 / 报销那块的数据单独一份，跟着 store 一起上云。
     清理规则和表单一致：数字要有限、比例 0–100、报销金额 > 0、日期合法。
     rows 允许为空数组（表示还没配过），由界面回落到出厂五行。 */
  function cleanPay(o) {
    if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
    var num = function (v, def) { var n = Number(v); return isFinite(n) ? n : def; };
    var out = {
      base: num(o.base, 8477), wage: num(o.wage, 6400),
      perf: num(o.perf, 2425), subsidy: num(o.subsidy, 550), gap: num(o.gap, 32.075),
      rows: [], reimb: []
    };
    if (Array.isArray(o.rows)) {
      o.rows.slice(0, 24).forEach(function (r) {
        if (!r || !r.name) return;
        out.rows.push({
          name: String(r.name).slice(0, 24),
          p: Math.max(0, Math.min(100, num(r.p, 0))),
          c: Math.max(0, Math.min(100, num(r.c, 0)))
        });
      });
    }
    if (Array.isArray(o.reimb)) {
      o.reimb.slice(0, 500).forEach(function (r) {
        if (!r) return;
        var amt = Number(r.amount);
        if (!isFinite(amt) || amt <= 0) return;
        out.reimb.push({
          id: String(r.id || ('r' + Math.random().toString(36).slice(2, 9))).slice(0, 40),
          note: String(r.note || '报销').slice(0, 40),
          amount: Math.round(amt * 100) / 100,
          date: /^\d{4}-\d{2}-\d{2}$/.test(String(r.date || '')) ? String(r.date) : ''
        });
      });
    }
    return out;
  }
  function emptyStore() { return { added: [], edited: {}, deleted: [], weights: {}, weightCleared: [], pay: null }; }
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
  function shapeStore(o) {
    o = o || {};
    return {
      added: Array.isArray(o.added) ? o.added : [],
      edited: (o.edited && typeof o.edited === 'object' && !Array.isArray(o.edited)) ? o.edited : {},
      deleted: Array.isArray(o.deleted) ? o.deleted : [],
      weights: cleanWeights(o.weights),
      weightCleared: cleanWeightCleared(o.weightCleared),
      pay: cleanPay(o.pay)
    };
  }
  /* 读：门禁没过就是空账本，本机一个键都不碰。
     门禁过了优先用密屉里解出来的那份（boot.js 已经打开）；
     明文老账只在搬家那一刻由 boot.js 读一次，之后就没了。 */
  function loadStore() {
    if (LOCKED) return emptyStore();
    var cache = window.QZ_CACHE && window.QZ_CACHE.store;
    if (cache) return shapeStore(cache);
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (!raw) return emptyStore();
      return shapeStore(JSON.parse(raw));
    } catch (e) { return emptyStore(); }
  }
  /* 写：只写密文。明文那份不再落盘 —— 换台机器、换个浏览器、
     甚至同一台机器上别人打开开发者工具，都读不到东西。 */
  var vaultTimer = 0;
  function saveStore() {
    if (LOCKED) return;
    storeRev++;
    for (var i = 0; i < STORE_HOOKS.length; i++) {
      try { STORE_HOOKS[i](); } catch (e) { /* 通知失败不能拖垮记账 */ }
    }
    if (vaultTimer) return;
    vaultTimer = setTimeout(function () {
      vaultTimer = 0;
      var key = window.QZ_VAULT_KEY;
      if (key && window.QZVault) window.QZVault.save(key, 'ledger', state.store);
      try { localStorage.removeItem(STORE_KEY); } catch (e) { /* 无痕模式 */ }
    }, 180);
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
  /* 口语 → 标准词。NOTE_ALIAS 是双向可用的：
     归一账目名目用它，反向识别也用它 —— 写"午饭"先被翻成"午餐"再匹配，
     于是"三餐"这一类的同义词不用在 SUBCATS 里重复维护一遍 */
  function expandText(s) {
    var t = String(s || '');
    Object.keys(NOTE_ALIAS).forEach(function (k) {
      if (t.indexOf(k) !== -1) t += ' ' + NOTE_ALIAS[k];
    });
    return t;
  }
  /* 关键词归属：命中第一个子类的关键词即归入该子类，全不中则落「其它」 */
  /* 关键词命中：命中就返回那一档的子类名，没命中返回空串。
     刻意不编一个"最像"的答案 —— 留空时的兜底交给 guessSub 明确说清。 */
  function guessSubHit(cat, note) {
    var list = SUBCATS[cat] || [];
    var s = expandText(note);
    for (var i = 0; i < list.length; i++) {
      var item = list[i];
      if (!item.keys.length) continue;
      for (var k = 0; k < item.keys.length; k++) {
        if (s.indexOf(item.keys[k]) !== -1) return item.name;
      }
    }
    return '';
  }
  /* 落库兜底：认不出就归「其它」；没有「其它」这档的分类落到第一档
     （餐饮 → 三餐、日常 → 房租），不再拿列表最后一项去硬凑一个结论。 */
  function guessSub(cat, note) {
    var hit = guessSubHit(cat, note);
    if (hit) return hit;
    var list = SUBCATS[cat] || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].name === '其它' || list[i].name === '其他') return list[i].name;
    }
    return list.length ? list[0].name : '其它';
  }
  function subcatOf(r) { return r.sub || guessSub(r.category, r.note); }

  /* 内容 → 一级分类。两条线索按顺序用：
     ① 你自己记过的同一个名目，按历史里归到最多的那一类（最贴近你的习惯）；
     ② 没有历史就走关键词：谁的子类关键词命中最长，就归谁。
     都没中返回空串 —— 空串表示「没把握」，表单保持用户当前的选择不动。 */
  var HINT_MAP = null, HINT_REV = -1;
  function hintMap() {
    if (HINT_MAP && HINT_REV === storeRev) return HINT_MAP;
    var m = Object.create(null);
    allRecords().forEach(function (r) {
      var k = r.note;
      if (!k) return;
      var slot = m[k] || (m[k] = Object.create(null));
      var c = r.type === 'income' ? '收入' : r.category;
      slot[c] = (slot[c] || 0) + 1;
    });
    Object.keys(m).forEach(function (k) {
      var slot = m[k], best = '', bestN = 0;
      Object.keys(slot).forEach(function (c) { if (slot[c] > bestN) { bestN = slot[c]; best = c; } });
      m[k] = best;
    });
    HINT_MAP = m;
    HINT_REV = storeRev;
    return m;
  }
  /* 最长关键词命中：在给定的一级分类集合里，谁命中的关键词最长就归谁 */
  function matchCat(s2, cats) {
    var best = '', bestLen = 0;
    cats.forEach(function (cat) {
      (SUBCATS[cat] || []).forEach(function (item) {
        for (var i = 0; i < item.keys.length; i++) {
          var k = item.keys[i];
          if (k && k.length > bestLen && s2.indexOf(k) !== -1) { bestLen = k.length; best = cat; }
        }
      });
    });
    return { cat: best, len: bestLen };
  }
  function guessCat(text, type) {
    var s2 = expandText(String(text || '').trim());
    if (!s2) return '';
    var known = hintMap()[String(text).trim()];
    if (known) {
      if (type === 'income' && known === '收入') return '收入';
      if (type !== 'income' && known !== '收入') return known;
    }
    return matchCat(s2, type === 'income' ? INCOME_CATS : EXPENSE_CATS).cat;
  }
  /* 内容 → 收支方向 + 分类，一次算完。
     支出表和收入表各算一遍，谁的关键词更长就听谁的；平手时按支出走
     （"红包"这种两边都沾的词，默认仍是花出去的）。
     命中收入词就顺手把表单切到收入 —— 写"工资 / 津贴 / 报销"不用先点类型。 */
  function guessEntry(text) {
    var raw = String(text || '').trim();
    if (!raw) return null;
    var known = hintMap()[raw];
    if (known) return { type: known === '收入' ? 'income' : 'expense', cat: known };
    var s2 = expandText(raw);
    var inc = matchCat(s2, INCOME_CATS), exp = matchCat(s2, EXPENSE_CATS);
    if (inc.cat && inc.len >= exp.len) return { type: 'income', cat: inc.cat };
    if (exp.cat) return { type: 'expense', cat: exp.cat };
    return null;
  }
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
  /* 总览 / KPI / 图表口径：2024-07 之前的支出不参与统计。
     只挡支出，收入照旧；日历明细仍走 allRecords()，那条线上的老账一笔不少。 */
  var STATS_FROM = '2024-07-01';
  function inStatsScope(r) {
    return !(r.type === 'expense' && String(r.date) < STATS_FROM);
  }
  function scopeRecords() {
    var list = allRecords().filter(inStatsScope);
    if (state.year === 'all') return list;
    var y = Number(state.year);
    return list.filter(function (r) { return r.year === y; });
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
    var prev = anchorDate().getTime(), next = d.getTime();
    state.anchorDate = dateKey(d);
    state.calMonth = { year: d.getFullYear(), month: d.getMonth() + 1 };
    /* 跨月 / 跨年跳转不是硬切：给重绘后的网格补一段短促的滑入。
       相邻日的 soft 动画已经够顺，这里只处理「两天不相邻」的跳。 */
    if (Math.abs(next - prev) > 20 * 86400000) {
      var dir = next > prev ? 'next' : 'prev';
      setTimeout(function () {
        var el = $('calGrid') || $('calWeekGrid') || $('calDayBoard') || $('calYearBoard');
        if (!el) return;
        el.classList.remove('cal-jump-next', 'cal-jump-prev');
        void el.offsetWidth;
        el.classList.add('cal-jump-' + dir);
        setTimeout(function () { el.classList.remove('cal-jump-next', 'cal-jump-prev'); }, 560);
      }, 0);
    }
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
  /* 收支 / 星期 / 金额 / 搜索：与分类无关的那一半筛选。
     子类按钮上的笔数和右侧金额 chip 都要按这一层算，口径才和棋盘一致。 */
  function matchCore(r) {
    var f = state.filters;
    var q = f.q.trim().toLowerCase().replace(/[\s'’"-]/g, '');
    var wd = f.weekday;
    if (f.type !== 'all' && r.type !== f.type) return false;
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
    if (q && searchBlob(r).replace(/[\s'’"-]/g, '').indexOf(q) === -1) return false;
    return true;
  }
  function matchFilters(r) {
    if (!matchCore(r)) return false;
    var f = state.filters;
    if (f.category !== 'all' && r.category !== f.category) return false;
    if (f.sub !== 'all' && r.sub !== f.sub) return false;
    return true;
  }
  function boardRecords() {
    return sortedDesc(rangeRecords().filter(matchFilters));
  }
  function filtersActive() {
    var f = state.filters;
    return f.category !== 'all' || f.sub !== 'all' || f.type !== 'all' ||
      (f.weekday !== 'all' && f.weekday !== '') || !!f.q.trim() ||
      (f.amount && f.amount !== 'all');
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

  /* ---------------- ECharts 公共配置 ---------------- */
  function tooltipCommon(p, extra) {
    return Object.assign({
      backgroundColor: p.surface,
      borderColor: p.border,
      borderWidth: 1,
      padding: [10, 13],
      /* v1.0.41：所有图表 tooltip 统一浮在光标上方，居中且不遮住数据点 */
      position: function (pt, params, dom, rect, size) {
        var w = size.contentSize[0], h = size.contentSize[1];
        return [Math.min(Math.max(pt[0] - w / 2, 6), Math.max(6, size.viewSize[0] - w - 6)),
                Math.max(6, pt[1] - h - 16)];
      },
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
  window.addEventListener('resize', debounce(resizeAll, 160));
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
    if (opts.reset) state.filters = { q: '', type: 'all', category: 'all', sub: 'all', weekday: 'all', amount: 'all' };
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
    softReset();                        /* 翻到一半换粒度：先把动画收干净 */
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
    var allKeys = Object.keys(w).filter(function (k) {
      return /^\d{4}-\d{2}-\d{2}$/.test(k) && isFinite(Number(w[k]));
    }).sort();
    var wy = $('weightYear');
    if (wy) {
      var yrs = [];
      allKeys.forEach(function (k) { var y = Number(k.slice(0, 4)); if (yrs.indexOf(y) < 0) yrs.push(y); });
      yrs.sort(function (a, b) { return b - a; });
      var wsig = 'all,' + yrs.join(',');
      if (wy.dataset.sig !== wsig) {
        wy.dataset.sig = wsig;
        wy.innerHTML = '<span class="seg-ind" aria-hidden="true"></span>' +
          ['all'].concat(yrs).map(function (y) {
            return '<button type="button" data-wy="' + y + '" class="' + (String(state.weightYear) === String(y) ? 'is-active' : '') + '">' +
              (y === 'all' ? '全部' : y) + '</button>';
          }).join('');
        setSegActive(wy, 'data-wy', state.weightYear);
      }
    }
    var keys = allKeys.filter(function (k) {
      return state.weightYear === 'all' || k.slice(0, 4) === String(state.weightYear);
    });
    var vals = keys.map(function (k) { return Number(w[k]); });
    var ts = keys.map(function (k) { return new Date(k + 'T00:00:00').getTime(); });
    /* 隔了 45 天以上的两笔之间插一个空点，把线断开。
       否则 2023-11 到 2024-08 那段 256 天的空档会被画成一条缓慢下滑的假曲线 */
    var pts = [], ptKeys = [];
    keys.forEach(function (k, i) {
      if (i && ts[i] - ts[i - 1] > 45 * 864e5) { pts.push([(ts[i] + ts[i - 1]) / 2, null]); ptKeys.push(''); }
      pts.push([ts[i], vals[i]]); ptKeys.push(k);
    });
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
        var k = ptKeys[i] || '';
        var v = Array.isArray(ps[0].value) ? ps[0].value[1] : ps[0].value;
        var d = new Date(k + 'T00:00:00');
        var wd = isNaN(d.getTime()) ? '' : ' 周' + '日一二三四五六'.charAt(d.getDay());
        return (k ? '<div style="font-weight:700;margin-bottom:3px">' + k + wd + '</div>' : '') +
          '<span style="color:' + p.primary + '">●</span> 体重 <b>' + Number(v).toFixed(1) + ' kg</b>';
      }
    });
    /* 横轴改走时间轴：2022-08 到 2026-10 跨了四年多，MM-DD 挤在一起分不清是哪一年。
       时间轴自己挑刻度，标签统一写成 25.03 这种「年.月」 */
    o.xAxis = {
      type: 'time', boundaryGap: false,
      axisLine: { lineStyle: { color: p.border } }, axisTick: { show: false },
      splitLine: { show: false },
      axisLabel: {
        color: p.muted, fontSize: 10.5, fontFamily: p.font, hideOverlap: true,
        formatter: function (v) {
          var d = new Date(v);
          return String(d.getFullYear()).slice(2) + '.' + ('0' + (d.getMonth() + 1)).slice(-2);
        }
      }
    };
    o.yAxis = valAxis(p, {
      scale: true,
      min: function (v) { return Math.floor(v.min - 1); },
      max: function (v) { return Math.ceil(v.max + 1); },
      axisLabel: { color: p.muted, fontSize: 10.5, fontFamily: p.font, formatter: function (v) { return v.toFixed(0); } }
    });
    var avg = vals.length ? vals.reduce(function (a, b) { return a + b; }, 0) / vals.length : 0;
    o.series = [{
      name: '体重', type: 'line', smooth: .34, symbol: 'circle', symbolSize: 7,
      showSymbol: vals.length <= 40, data: pts,
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

  /* v1.0.40：支出构成自己的年度筛选。全局那枚 yearSwitch 在当前页面
     根本没有挂载点，不能指望它；这里给这张卡一条独立的年份条。 */
  function fillDonutYears() {
    var box = $('donutYear'); if (!box) return;
    var years = [];
    allRecords().forEach(function (r) { var y = Number(r.year); if (y && years.indexOf(y) < 0) years.push(y); });
    years.sort(function (a, b) { return b - a; });
    var sig = state.donutYear + '|' + years.join(',');
    if (box.dataset.sig === sig) return;
    box.dataset.sig = sig;
    box.innerHTML = '<span class="seg-ind" aria-hidden="true"></span>' +
      ['all'].concat(years).map(function (y) {
        return '<button type="button" data-dy="' + y + '" class="' + (String(state.donutYear) === String(y) ? 'is-active' : '') + '">' +
          (y === 'all' ? '全部' : y) + '</button>';
      }).join('');
    setSegActive(box, 'data-dy', state.donutYear);
  }
  function bindDonutYear() {
    bindSeg($('donutYear'), 'data-dy', function (v) {
      state.donutYear = v;
      renderCharts('overview', 'instant');
    });
  }

  /* 支出构成：图例上墙，用引线连到扇区，不再另起一段下方图例 */
  function renderDonut(p) {
    fillDonutYears();
    var data = catTotals(scopeRecords().filter(function (r) {
      return state.donutYear === 'all' || String(r.year) === String(state.donutYear);
    })).filter(function (d) { return d.value > 0; });
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
      type: 'pie', radius: ['42%', '62%'], center: ['50%', '52%'],
      avoidLabelOverlap: true, minAngle: 4,
      itemStyle: { borderColor: p.surface, borderWidth: 3, borderRadius: 6 },
      label: {
        show: true, position: 'outside', alignTo: 'edge', edgeDistance: 2, bleedMargin: 0,
        formatter: function (d) { return d.name + '  {p|' + pctText(d.percent) + '}'; },
        color: p.text2, fontSize: 11.5, fontFamily: p.font, fontWeight: 600,
        rich: { p: { color: p.muted, fontSize: 10.5, fontWeight: 500 } }
      },
      labelLine: { show: true, length: 7, length2: 9, smooth: true, lineStyle: { color: p.borderStrong, width: 1 } },
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
      confine: false,
      position: function (pt, params, dom, rect, size) {
        var w = size.contentSize[0], h = size.contentSize[1];
        return [Math.min(Math.max(pt[0] - w / 2, 6), Math.max(6, size.viewSize[0] - w - 6)),
                Math.max(6, pt[1] - h - 16)];
      },
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
      /* 滑杆回到上一版：条宽 12、长 390、文字 10px。
         26 / 420 / 13px 那一版太抢眼，把日历格挤得没地方呼吸 */
      left: 'center', bottom: 0, itemWidth: 12, itemHeight: 390,
      text: ['贵', '省'], textGap: 10,
      textStyle: { color: p.muted, fontSize: 10, fontFamily: p.font },
      handleStyle: { shadowBlur: 10, shadowColor: 'rgba(24,39,75,.2)' },
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
      /* 底部让出 34px 给滑杆（细条款 + 10px 文字） */
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

  /* ================= v1.0.38 · 图表统一规格 =================
     七张图以前各写各的：这张折线、那张饼、另一张方块图，网格边距、字号、圆角
     一人一套，摆在同一页里像七个人画的。现在归成两种语法，差别只剩数据：
       rankBar —— 排名类：名字在左，横条长度读大小，右边挂数值
       yearBar —— 年份类：年份在横轴，竖条高度读大小，柱顶挂数值
     两套共用同一批字号（10.5 / 11）、同一套圆角（5 / 7）、同一个入场节奏
     （640ms cubicOut）、同一张 tooltip 卡片。换数据不换脸。 */
  function rankBar(p, rows, opt) {
    opt = opt || {};
    var accent = opt.accent || p.primary;
    var accent2 = opt.accent2 || p.primary2;
    var fmt = opt.fmt || function (v) { return v; };
    var inst = RENDER_MODE === 'instant';
    var maxV = Math.max.apply(null, rows.map(function (r) { return Number(r.value) || 0; }).concat([1]));
    var total = rows.reduce(function (s, r) { return s + (Number(r.value) || 0); }, 0) || 1;
    return {
      backgroundColor: 'transparent',
      animation: !inst,
      animationDuration: inst ? 0 : 640,
      animationDurationUpdate: inst ? 0 : 420,
      animationEasing: 'cubicOut',
      textStyle: { fontFamily: p.font },
      grid: { left: 2, right: opt.right || 66, top: 6, bottom: 6, containLabel: true },
      tooltip: tooltipCommon(p, {
        trigger: 'item',
        formatter: function (a) {
          return '<span style="color:' + p.muted + ';font-size:11px">' + esc(a.name) + '</span>' +
            '<div style="margin-top:3px"><b style="font-size:13px">' + fmt(a.value) + '</b>' +
            '<span style="margin-left:8px;color:' + p.muted + ';font-size:11px">' + (a.value / total * 100).toFixed(1) + '%</span></div>';
        }
      }),
      xAxis: { type: 'value', max: maxV, show: false },
      yAxis: {
        type: 'category', inverse: true,
        data: rows.map(function (r) { return r.name; }),
        axisTick: { show: false }, axisLine: { show: false },
        axisLabel: {
          color: p.text2, fontSize: opt.labelSize || 11, fontWeight: 600, fontFamily: p.font,
          width: opt.labelWidth || 92, overflow: 'truncate', margin: 10
        }
      },
      series: [{
        type: 'bar', barWidth: opt.barWidth || 10,
        showBackground: true,
        backgroundStyle: { color: p.surface3, borderRadius: 5 },
        itemStyle: {
          borderRadius: 5,
          color: new echarts.graphic.LinearGradient(0, 0, 1, 0, [
            { offset: 0, color: withAlpha(accent2, .42) },
            { offset: .6, color: accent },
            { offset: 1, color: accent }
          ])
        },
        label: {
          show: true, position: 'right', distance: 7,
          color: p.text2, fontSize: 10.5, fontWeight: 800, fontFamily: p.font,
          formatter: function (a) { return fmt(a.value); }
        },
        emphasis: { itemStyle: { shadowBlur: 14, shadowColor: withAlpha(accent, .32) } },
        data: rows.map(function (r) { return { name: r.name, value: r.value }; })
      }]
    };
  }

  function yearBar(p, rows, opt) {
    opt = opt || {};
    var accent = opt.accent || p.primary;
    var fmt = opt.fmt || function (v) { return v; };
    var axisFmt = opt.axisFmt || fmtAxis;
    var inst = RENDER_MODE === 'instant';
    var dense = rows.length > 9;
    return {
      backgroundColor: 'transparent',
      animation: !inst,
      animationDuration: inst ? 0 : 700,
      animationDurationUpdate: inst ? 0 : 420,
      animationEasing: 'cubicOut',
      textStyle: { fontFamily: p.font },
      grid: { left: 2, right: 10, top: 28, bottom: 2, containLabel: true },
      tooltip: tooltipCommon(p, {
        trigger: 'axis',
        axisPointer: { type: 'shadow', shadowStyle: { color: withAlpha(accent, .07) } },
        formatter: function (a) {
          var v = a[0]; if (!v) return '';
          return '<span style="color:' + p.muted + ';font-size:11px">' + v.axisValue + '</span>' +
            '<div style="margin-top:3px"><b style="font-size:13px">' + fmt(v.value) + '</b></div>';
        }
      }),
      xAxis: {
        type: 'category', data: rows.map(function (r) { return r.name; }), boundaryGap: true,
        axisTick: { show: false }, axisLine: { show: false },
        axisLabel: {
          color: p.muted, fontSize: 10.5, fontWeight: 600, fontFamily: p.font,
          margin: 9, hideOverlap: true, rotate: dense ? 38 : 0
        }
      },
      yAxis: {
        type: 'value', splitNumber: 3,
        axisLine: { show: false }, axisTick: { show: false },
        axisLabel: { color: p.muted, fontSize: 10, fontFamily: p.font, formatter: axisFmt },
        splitLine: { lineStyle: { color: withAlpha(p.text, .08), type: 'dashed' } }
      },
      series: [{
        type: 'bar', barMaxWidth: opt.barWidth || 24, barMinHeight: 3,
        itemStyle: {
          borderRadius: [7, 7, 2, 2],
          color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
            { offset: 0, color: accent },
            { offset: 1, color: withAlpha(accent, .28) }
          ])
        },
        label: {
          show: true, position: 'top', distance: 6,
          color: p.text2, fontSize: 10.5, fontWeight: 800, fontFamily: p.font,
          formatter: function (a) { return fmt(a.value); }
        },
        emphasis: { itemStyle: { shadowBlur: 14, shadowColor: withAlpha(accent, .3) } },
        data: rows.map(function (r) { return r.value; })
      }]
    };
  }
  /* v1.0.39 · 折线语法
     同样的坐标轴、同样的字号与 tooltip 卡，只把「柱子」换成「线 + 面积」。
     年度购买趋势本来就该看走势（今年比去年多花多少），柱子只回答「哪年高」，
     线还能回答「涨得多急」。点、线、面积三件套，点可以点着跳年。 */
  function yearLine(p, rows, opt) {
    opt = opt || {};
    var accent = opt.accent || p.primary;
    var fmt = opt.fmt || function (v) { return v; };
    var axisFmt = opt.axisFmt || fmtAxis;
    var inst = RENDER_MODE === 'instant';
    var dense = rows.length > 9;
    var vals = rows.map(function (r) { return Number(r.value) || 0; });
    var maxV = Math.max.apply(null, vals.concat([1]));
    return {
      backgroundColor: 'transparent',
      animation: !inst,
      animationDuration: inst ? 0 : 760,
      animationDurationUpdate: inst ? 0 : 420,
      animationEasing: 'cubicOut',
      textStyle: { fontFamily: p.font },
      grid: { left: 2, right: 16, top: 30, bottom: 2, containLabel: true },
      tooltip: tooltipCommon(p, {
        trigger: 'axis',
        axisPointer: { type: 'line', lineStyle: { color: withAlpha(accent, .42), width: 1, type: 'dashed' } },
        formatter: function (a) {
          var v = a[0]; if (!v) return '';
          return '<span style="color:' + p.muted + ';font-size:11px">' + v.axisValue + '</span>' +
            '<div style="margin-top:3px"><b style="font-size:13px">' + fmt(v.value) + '</b>' +
            '<span style="margin-left:8px;color:' + p.muted + ';font-size:11px">占峰值 ' +
            (v.value / maxV * 100).toFixed(0) + '%</span></div>';
        }
      }),
      xAxis: {
        type: 'category', data: rows.map(function (r) { return r.name; }), boundaryGap: false,
        axisTick: { show: false }, axisLine: { show: false },
        axisLabel: {
          color: p.muted, fontSize: 10.5, fontWeight: 600, fontFamily: p.font,
          margin: 10, hideOverlap: true, rotate: dense ? 38 : 0
        }
      },
      yAxis: {
        type: 'value', splitNumber: 3,
        axisLine: { show: false }, axisTick: { show: false },
        axisLabel: { color: p.muted, fontSize: 10, fontFamily: p.font, formatter: axisFmt },
        splitLine: { lineStyle: { color: withAlpha(p.text, .08), type: 'dashed' } }
      },
      series: [{
        type: 'line', smooth: .38, symbol: 'circle', symbolSize: 7.5,
        showSymbol: true, connectNulls: true,
        lineStyle: { width: 2.6, color: accent, shadowBlur: 10, shadowColor: withAlpha(accent, .26) },
        itemStyle: { color: accent, borderColor: p.surface, borderWidth: 2 },
        areaStyle: {
          color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
            { offset: 0, color: withAlpha(accent, .26) },
            { offset: 1, color: withAlpha(accent, 0) }
          ])
        },
        label: {
          show: !dense, position: 'top', distance: 7,
          color: p.text2, fontSize: 10.5, fontWeight: 800, fontFamily: p.font,
          formatter: function (a) { return fmt(a.value); }
        },
        emphasis: { scale: 1.5, itemStyle: { shadowBlur: 12, shadowColor: withAlpha(accent, .4) } },
        data: vals
      }]
    };
  }
  /* 魔方一组蓝、比赛一组青绿：两族数据在页面上本来就分色，图里继续分 */
  function cubeAccent(p) { return p.primary; }
  function compAccent(p) { return p.expense; }

  function renderTop(p) {
    var data = topItems(scopeRecords(), 10);
    var rows = data.map(function (d) { return { name: d.name, value: d.value }; });
    setOpt('chartTop', rankBar(p, rows, {
      fmt: function (v) { return fmtYuan(v); },
      labelWidth: 98, right: 82, barWidth: 11
    }));
    bindClick('chartTop', function (params) {
      if (params.name) jumpToDetail({ reset: true, q: params.name, label: '已搜索：' + params.name });
    });
  }

  /* 总览里的魔方板块：只读 cubeLedger_v1，跟账本 store 一丁点都不交叉。
     四张数字卡各自独立成块，两张图也各有自己的卡 —— 不再挤在一个大容器里。 */
  function cubeData() {
    if (LOCKED) {
      var s = window.QZ_CACHE && window.QZ_CACHE.cube;
      return (s && Array.isArray(s.cubes) && Array.isArray(s.competitions)) ? s : null;
    }
    try {
      var raw = localStorage.getItem('cubeLedger_v1');
      var d = raw ? JSON.parse(raw) : null;
      return (d && Array.isArray(d.cubes) && Array.isArray(d.competitions)) ? d : null;
    } catch (e) { return null; }
  }
  function cubeMoney(n) {
    return '¥' + (Number(n) || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  /* 柱尾标签用的短金额：¥983 / ¥1.2k，省掉两位小数，
     卡片被拉窄时标签才不会顶出图框 */
  function cubeMoneyShort(n) {
    var v = Number(n) || 0;
    if (Math.abs(v) >= 1000) return '¥' + (Math.round(v / 100) / 10) + 'k';
    return '¥' + Math.round(v);
  }
  /* 容器尺寸变了要重算画布：ECharts 只在 init 那一刻量一次容器，
     卡片改宽窄（拖布局、换分栏）之后它还按老尺寸画，
     轴标签和柱尾数字就跑到框外面去了。这里盯住容器，变一次 resize 一次。 */
  var _chartRO = null;
  function watchChartRO() {
    if (typeof ResizeObserver === 'undefined' || !hasEcharts) return;
    if (!_chartRO) {
      _chartRO = new ResizeObserver(function (entries) {
        entries.forEach(function (en) {
          var inst = echarts.getInstanceByDom(en.target);
          if (inst) inst.resize();
        });
      });
    }
    ['cubeYearChart', 'cubeTypeChart', 'cmChart_model', 'cmChart_brand', 'cmChart_cubeprice', 'cmChart_compyear', 'cmChart_compprov', 'cmChart_compprice'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) { try { _chartRO.observe(el); } catch (e) {} }
    });
  }
  function cubePaint(el, option) {
    if (!el || !hasEcharts) return null;
    var chart = echarts.getInstanceByDom(el) || echarts.init(el);
    /* 必须登记进统一注册表：resizeAll 只认 charts 里的实例，
       之前魔方这两张图没登记，卡片改宽窄后画布一直是旧尺寸，
       图和标签就顶着框边跑出去了。 */
    if (el.id) charts[el.id] = chart;
    chart.setOption(option, true);
    return chart;
  }
  /* 从总览跳进魔方页并带上筛选：iframe 第一次进这一页才挂载，
     消息可能比子页脚本早到，所以用重试把条件送到位。 */
  function jumpCube(filter) {
    setView('cube', filter && filter.tab);
    if (!filter) return;
    var tries = 0;
    (function send() {
      var f = $('cubeFrame'), ready = false, w = null;
      try {
        w = f && f.contentWindow;
        /* src 一挂上去就不是空的，但那时 iframe 还是 about:blank —— 消息会丢。
           等子页真的 ready 再发，工作台入口才不会停在默认标签。 */
        ready = !!(w && w.document && w.document.readyState === 'complete' &&
          /cube\.html/.test(w.location.href));
      } catch (e) { ready = false; }
      if (ready) {
        try { w.postMessage({ __ledgerCubeFilter: filter }, '*'); } catch (e) { /* noop */ }
        return;
      }
      if (tries++ < 80) setTimeout(send, 120);
    })();
  }


  /* v1.0.27：魔方子页原来的六张统计卡搬进账本总览。
     数据只读 cubeLedger_v1，和账本 store 不交叉；ECharts 没加载时照样画，
     所以放在 hasEcharts 判断之前。 */
  /* v1.0.32：六张统计卡从进度条换成真图表。
     数据仍只读 cubeLedger_v1；点图元沿用原来的 jumpCube 筛选路径。 */
  function renderCubeMiniLists(d) {
    var cubes = (d && d.cubes) || [], comps = (d && d.competitions) || [];
    var tally = function (list, pick) {
      var m = {};
      list.forEach(function (x) { var k = String(pick(x) || '').trim(); if (k) m[k] = (m[k] || 0) + 1; });
      return Object.keys(m).map(function (k) { return { k: k, n: m[k] }; })
        .sort(function (a, b) { return b.n - a.n || a.k.localeCompare(b.k, 'zh-CN'); }).slice(0, 8);
    };
    var byYear = function (list, countOnly) {
      var m = {};
      list.forEach(function (x) {
        var y = String(x.date || '').slice(0, 4);
        if (!/^\d{4}$/.test(y)) return;
        var o = m[y] || (m[y] = { n: 0, sum: 0 });
        o.n++; if (!countOnly) o.sum += Number(x.price) || 0;
      });
      return Object.keys(m).map(function (k) { return { k: k, n: m[k].n, sum: m[k].sum }; })
        .sort(function (a, b) { return a.k.localeCompare(b.k); });
    };
    /* 六张卡各算一组 {name, value}，再选一种语法：
       排名类（型号 / 厂家 / 省份）走 rankBar，年份类（购买、年度价格、
       比赛年份、比赛年度价格）走 yearBar。语法统一，参数不同。 */
    var rankRows = function (list, pick) {
      return tally(list, pick).map(function (r) { return { name: r.k, value: r.n }; });
    };
    var yearRows = function (list, countOnly) {
      return byYear(list, countOnly).map(function (r) { return { name: r.k, value: countOnly ? r.n : r.sum }; });
    };
    var yuanAxis = function (v) { return v >= 1000 ? '¥' + (v / 1000) + 'k' : '¥' + v; };
    var cnt = function (u) { return function (v) { return v + ' ' + u; }; };
    var specs = [
      { kind: 'brand', gram: 'rank', rows: rankRows(cubes, function (x) { return x.brand || '未分类'; }), fmt: cnt('条'), tab: 'cubes', key: 'brand' },
      { kind: 'cubeprice', gram: 'line', rows: yearRows(cubes, false), fmt: cubeMoneyShort, axisFmt: yuanAxis, tab: 'cubes', key: 'year' },
      { kind: 'compyear', gram: 'year', rows: yearRows(comps, true), fmt: cnt('场'), axisFmt: function (v) { return v; }, tab: 'competitions', key: 'year' },
      { kind: 'compprov', gram: 'rank', rows: rankRows(comps, function (x) { return x.province || '未填写'; }), fmt: cnt('场'), tab: 'competitions', key: 'province' },
      { kind: 'compprice', gram: 'year', rows: yearRows(comps, false), fmt: cubeMoneyShort, axisFmt: yuanAxis, tab: 'competitions', key: 'year' }
    ];
    var fallback = function (sp) {
      var host = document.querySelector('[data-cube-list="' + sp.kind + '"]'); if (!host) return;
      var max = Math.max.apply(null, [1].concat(sp.rows.map(function (r) { return r.value; })));
      host.innerHTML = sp.rows.length ? sp.rows.map(function (r) {
        return '<button type="button" class="cm-row" data-cube-jump="' + sp.tab + '" data-cube-key="' + sp.key + '" data-v="' + esc(r.name) + '">' +
          '<span class="cm-name">' + esc(r.name) + '</span><span class="cm-track"><i style="width:' + (r.value / max * 100).toFixed(1) + '%"></i></span>' +
          '<b class="cm-val">' + esc(sp.fmt(r.value)) + '</b></button>';
      }).join('') : '<div class="cm-empty">暂无数据</div>';
    };
    if (!hasEcharts) { specs.forEach(fallback); return; }
    var p = palette();
    specs.forEach(function (sp) {
      var host = document.querySelector('[data-cube-list="' + sp.kind + '"]'); if (!host) return;
      host.id = 'cmChart_' + sp.kind;
      host.className = 'cm-list cm-chart ' + (sp.gram === 'rank' ? 'is-rank' : 'is-year');
      if (!sp.rows.length) { host.innerHTML = '<div class="cm-empty">暂无数据</div>'; return; }
      var isComp = sp.tab === 'competitions';
      var accent = isComp ? compAccent(p) : cubeAccent(p);
      var opt = sp.gram === 'rank'
        ? rankBar(p, sp.rows, {
            accent: accent, accent2: isComp ? '#3fd0b0' : p.primary2,
            fmt: sp.fmt, labelWidth: 74, labelSize: 10.5, right: 54, barWidth: 9
          })
        : sp.gram === 'line'
          ? yearLine(p, sp.rows, { accent: accent, fmt: sp.fmt, axisFmt: sp.axisFmt })
          : yearBar(p, sp.rows, { accent: accent, fmt: sp.fmt, axisFmt: sp.axisFmt, barWidth: 20 });
      var chart = cubePaint(host, opt);
      if (!chart) return;
      chart.off('click');
      chart.on('click', function (params) {
        var name = params && params.name; if (!name) return;
        var filter = { tab: sp.tab }; filter[sp.key] = String(name); jumpCube(filter);
      });
    });
  }
  function renderCubeOverview() {
    var d = cubeData();
    var cubes = d ? d.cubes : [], comps = d ? d.competitions : [];
    var spend = 0, compSpend = 0;
    cubes.forEach(function (x) { spend += Number(x.price) || 0; });
    comps.forEach(function (x) { compSpend += Number(x.price) || 0; });
    var set = function (id, v) { var el = $(id); if (el) el.textContent = v; };
    set('cubeCnt', String(cubes.length));
    set('cubeSpend', cubeMoney(spend));
    set('cubeComp', String(comps.length));
    set('cubeFee', cubeMoney(compSpend));

    /* 四条小比例条：两两成对，读的是「这一项在同类里的占比」——
       收藏 vs 参赛比数量，魔方支出 vs 报名费比金额。
       不做没分母的假进度条，条子背后永远有一个说得清的分母。 */
    var bar = function (id, v) {
      var el = $(id);
      if (el) el.style.width = Math.max(2, Math.min(100, isFinite(v) ? v : 0)).toFixed(1) + '%';
    };
    var cntAll = cubes.length + comps.length;
    var cashAll = spend + compSpend;
    /* v1.0.40：四块统计砖只留数字，比例条拿掉 */
    /* 四格并在一条里：每一格都是一扇门，点进去就是筛好的魔方页 */
    var cells = document.querySelectorAll('[data-cube-filter]');
    for (var ci = 0; ci < cells.length; ci++) {
      (function (cell) {
        var kind = cell.dataset.cubeFilter;
        var go = function () {
          if (kind === 'comp' || kind === 'fee') jumpCube({ tab: 'competitions' });
          else jumpCube({ tab: 'cubes' });
        };
        cell.onclick = go;
        cell.onkeydown = function (ev) {
          if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); go(); }
        };
      })(cells[ci]);
    }

    renderCubeMiniLists(d);
    if (!hasEcharts) return;
    var p = palette();

    /* 年度购买支出：v1.0.39 改成折线。
       柱状只能比高低，走势要靠脑补；折线把斜率直接给出来，
       哪一年开始加码、哪一年收手，一眼就看得见。 */
    var years = {};
    cubes.forEach(function (x) {
      var y = String(x.date || '').slice(0, 4);
      if (/^\d{4}$/.test(y)) years[y] = (years[y] || 0) + (Number(x.price) || 0);
    });
    var yk = Object.keys(years).sort();
    var yearChart = cubePaint($('cubeYearChart'), yk.length
      ? yearLine(p, yk.map(function (y) {
          return { name: y, value: round(years[y]) };
        }), {
          accent: cubeAccent(p),
          fmt: cubeMoneyShort,
          axisFmt: function (v) { return v >= 1000 ? '¥' + (v / 1000) + 'k' : '¥' + v; }
        })
      : yearBar(p, [], {}));
    if (yearChart) {
      yearChart.off('click');
      yearChart.on('click', function (a) { jumpCube({ tab: 'cubes', year: String(a.name) }); });
    }

    /* 类型支出排行：跟「高频项目 TOP 10」同一种横向柱 —— 长名字截断、
       条长读比例、右侧挂金额，一张页面上所有排名图长得一模一样。 */
    var types = {};
    cubes.forEach(function (x) {
      var t = String(x.type || '').trim() || '未分类';
      types[t] = (types[t] || 0) + (Number(x.price) || 0);
    });
    var rows = Object.keys(types).map(function (k) { return { name: k, value: round(types[k]) }; })
      .sort(function (a, b) { return b.value - a.value; }).slice(0, 8);
    var typeChart = cubePaint($('cubeTypeChart'), rankBar(p, rows, {
      accent: cubeAccent(p), accent2: p.primary2,
      fmt: cubeMoneyShort, labelWidth: 96, right: 68, barWidth: 11
    }));
    if (typeChart) {
      typeChart.off('click');
      typeChart.on('click', function (a) { jumpCube({ tab: 'cubes', type: String(a.name) }); });
    }

    watchChartRO();
  }

  function renderCharts(view, mode) {
    if (view === 'overview') renderCubeOverview();
    if (!hasEcharts) return;
    var prevMode = RENDER_MODE;
    if (mode) RENDER_MODE = mode;
    var p = palette();
    if (view === 'overview') {
      /* 合并页：预算条三图 + 消费日历 / 分类走势 / 高频项目 */
      renderTrend(p); renderDonut(p); renderBalance(p); renderWeight(p);
      renderCalendar(p); renderStack(p); renderTop(p);
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
    var list = allRecords().filter(function (r) {
      return String(r.date).slice(0, 4) === y && inStatsScope(r);
    });
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
    var catBox = $('catRow'), subBox = $('subRow'), wrap = $('ctFilters');
    if (!catBox || !subBox) return;
    var cat = state.filters.category;
    var colors = catColors(p);
    var theme = document.documentElement.getAttribute('data-theme') || 'light';

    /* 主类：换肤或换配色才重建。筛选切换时节点保持不动，滑块真正滑过去。
       配色自定义后按钮的 --c/--ink 必须跟着变，所以颜色本身也进签名。 */
    var colSig = colors.join(',') + '|' + p.income;
    var mainSig = theme + '|' + p.primary + '|' + p.income + '|' + EXPENSE_CATS.join(',') + '|' + colSig;
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
    /* 笔数按「收支 / 金额 / 星期 / 搜索」这一层算，跟右侧金额 chip 同一口径 */
    var core = rangeRecords().filter(matchCore);
    if (cat !== 'all') {
      core.forEach(function (r) {
        if (r.category !== cat) return;
        counts[r.sub] = (counts[r.sub] || 0) + 1;
        tot++;
      });
      names = subCatNames(cat);
    }

    /* 右侧金额统计：和上方所有筛选一起联动 —— 分类 / 子类 / 收支 / 金额档 /
       星期 / 搜索全叠上之后，取当前粒度区间（年 / 月 / 周 / 日）的合计。
       收支分开算：支出绿、收入红，跟账本的配色口径一致。 */
    var expSum = 0, incSum = 0;
    rangeRecords().filter(matchFilters).forEach(function (r) {
      if (r.type === 'income') incSum += r.amount;
      else expSum += r.amount;
    });
    var sumBox = $('subSum');
    if (sumBox) {
      sumBox.hidden = false;
      var label = ({ year: '年统计', month: '月统计', week: '周统计', day: '日统计' })[state.scale] || '统计';
      var expOn = expSum > 0 || !incSum;
      var incOn = incSum > 0;
      var body = '<span class="ss-lab">' + label + '</span>';
      if (expOn) {
        body += '<b class="ss-num is-exp"><i>支</i>' + fmtBig(expSum) + '</b>';
      }
      if (incOn) {
        body += '<b class="ss-num is-inc"><i>收</i>' + fmtBig(incSum) + '</b>';
      }
      sumBox.innerHTML = body;
      sumBox.setAttribute('aria-label', label + '：支出 ' + fmtBig(expSum) + '，收入 ' + fmtBig(incSum));
    }
    /* 「全部」时子类那一行本来是空的：这段空白改成最近 5 笔，
       随手就能看见刚刚记下的账；选了具体分类就让位给子类按钮。 */
    var strip = $('recentStrip'), rlist = $('recentList');
    if (strip && rlist) {
      strip.onclick = function (e) {
        var b = e.target && e.target.closest ? e.target.closest('.rs-item') : null;
        if (b && b.dataset.day) jumpToDay(b.dataset.day);
      };
      var showRecent = (cat === 'all');
      strip.hidden = !showRecent;
      if (showRecent) {
        var recs = sortedDesc(allRecords()).slice(0, 9);
        var rsig = recs.map(function (r) {
          return [r.id, r.date, r.amount, r.category, r.sub, r.note, r.type, catColor(p, r.category)].join('|');
        }).join('~');
        if (rlist.dataset.sig !== rsig) {
          rlist.dataset.sig = rsig;
          rlist.innerHTML = recs.length ? recs.map(function (r, ri) {
            var inc = r.type === 'income';
            var newDay = ri > 0 && recs[ri - 1].date !== r.date;
            var note = String(r.note || r.sub || r.category || '').trim();
            /* 133×36 两行装：上行备注，下行「日期 · 金额」。备注因此不用被
               金额和日期挤成一团省略号，五颗并排也是齐的。 */
            var c = catColor(p, r.category);
            return '<button type="button" class="rs-item' + (newDay ? ' is-newday' : '') + '" data-day="' + esc(r.date) + '" style="--c:' + c + ';--ink:' + catInk(p, c) + '" title="' +
              esc(r.date + ' · ' + (r.category || '') + (r.sub ? ' / ' + r.sub : '') + (r.note ? ' · ' + r.note : '')) + '">' +
              '<i class="rs-dot"></i>' +
              '<span class="rs-body">' +
              '<span class="rs-note">' + esc(note) + '</span>' +
              '<span class="rs-meta">' +
              '<b class="rs-day">' + esc(String(r.date || '').slice(5)) + '</b>' +
              '<em class="rs-amt ' + (inc ? 'is-inc' : 'is-exp') + '">' + (inc ? '+' : '-') +
              esc(fmtTiny(r.amount)) + '</em>' +
              '</span></span></button>';
          }).join('') : '<span class="rs-none">还没有记录</span>';
        }
      }
    }
    var subSig = names.length ? theme + '|' + p.primary + '|' + colSig + '|' + cat + '|' + names.join(',') + '|' +
      names.map(function (n) { return counts[n] || 0; }).join(',') + '|' + tot + '|' +
      state.filters.sub + '|' + state.scale + '|' + state.filters.type :
      'all|' + state.scale + '|' + state.filters.type;
    var sumSig = state.scale + '|' + state.filters.type + '|' + cat + '|' + state.filters.sub + '|' +
      state.filters.weekday + '|' + (state.filters.amount || 'all') + '|' + state.filters.q + '|' +
      Math.round(expSum * 100) + '|' + Math.round(incSum * 100) + '|' + theme;
    if (sumBox && sumBox.dataset.sig !== sumSig) {
      sumBox.dataset.sig = sumSig;
      sumBox.classList.add('is-swap');
      setTimeout(function () { sumBox.classList.remove('is-swap'); }, 220);
    }
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
    /* 子类行只在选了具体分类之后才有内容；「全部」时整行空着，
       但行高留着 —— 工具条不跟着筛选变高变矮，棋盘不上下抖 */
    subBox.hidden = !names.length;
    if (wrap) wrap.classList.add('has-sub');
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
  /* 列表排序口径：餐饮 → 日常 → 交通 → 服饰 → 娱乐 → 收入。
     收入永远垫底，跟上面五类之间留一道隔断；同类里金额大的在前。 */
  function catRank(r) {
    if (r.type === 'income' || r.category === '收入') return EXPENSE_CATS.length;
    var i = EXPENSE_CATS.indexOf(r.category);
    return i < 0 ? EXPENSE_CATS.length : i;
  }
  function sortByCat(a, b) {
    var d = catRank(a) - catRank(b);
    return d || (b.amount - a.amount);
  }
  function groupByDate(rows) {
    var map = {};
    rows.forEach(function (r) { (map[r.date] = map[r.date] || []).push(r); });
    Object.keys(map).forEach(function (k) { map[k].sort(sortByCat); });
    return map;
  }
  function itemHTML(p, r, opts) {
    var c = r.type === 'income' ? p.income : catColor(p, r.category);
    var ink = catInk(p, c);
    var sign = r.type === 'income' ? '+' : '−';
    var label = r.note || r.sub;
    var tip = label + ' · ' + r.sub + ' · ' + fmtYuan(r.amount);
    var isNew = r.id && r.id === state.newId && Date.now() < state.newUntil;
    return '<button type="button" class="cal-item' + (r.type === 'income' ? ' is-inc' : '') +
      (isNew ? ' is-new' : '') +
      '" data-id="' + esc(r.id) + '" style="--c:' + c + ';--ink:' + ink + '" title="' + esc(tip) + '">' +
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
      /* 同类挨在一起：按分类固定顺序，同类里按金额从大到小 */
      items.sort(sortByCat);
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

  /* 天页「关于这一天」：单列竖向五张卡，全部内联 SVG / CSS，带 hover 与点击跳日。
     近 7 日支出 / 今天花得多吗 / 还剩多少 / 当日分类构成 / 体重记录。 */
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

    /* 3) 本月累计 / 今年收支：本月剩余拿近 6 个完整月的月均当参照，
       今年结余直接是当年收入减支出 —— 两个口径都写在卡片脚注里 */
    var dim = new Date(d0.getFullYear(), d0.getMonth() + 1, 0).getDate();
    var elapsed = d0.getDate(), mtd = 0, mDays = 0;
    for (var md = 0; md < elapsed; md++) {
      var dd = new Date(d0.getFullYear(), d0.getMonth(), 1 + md);
      var vv = round(byDate[dateKey(dd)] || 0);
      mtd += vv;
      if (vv > 0) mDays++;
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
    /* v1.0.40：新「本月剩余」= 本月收入 − 本月支出；
       老那一条改名「过往对比」，仍拿近 6 月月均当参照，两者不混。 */
    var mKey = yYear + '-' + ('0' + (d0.getMonth() + 1)).slice(-2);
    var mInc = 0, mExp = 0;
    allRecords().forEach(function (r) {
      if (String(r.date || '').slice(0, 7) !== mKey) return;
      if (r.type === 'income') mInc += r.amount; else mExp += r.amount;
    });
    var mNow = round(mInc - mExp);
    var mNowPct = mInc > 0 ? Math.max(0, Math.min(100, mExp / mInc * 100)) : 0;
    var mLeft = monthBudget - mtd, yLeft = round(yInc - yExp);
    var mLeftPct = monthBudget > 0 ? Math.max(0, Math.min(100, mtd / monthBudget * 100)) : 0;
    /* 年结余的进度条按"花掉收入的比例"显示，越低越省 */
    var yLeftPct = yInc > 0 ? Math.max(0, Math.min(100, yExp / yInc * 100)) : 0;

    /* 2b) 今天花得多吗：只回答一个问题——今天这笔，跟本月平常的日子比算多算少。
       一根横条把「今天」放在「本月单日最高」的刻度上，日均位置打一个刻度点，
       脚注给出本月消费日排名与最高那一天，全部是可核对的具体数。 */
    var monthDaily = mDays > 0 ? mtd / mDays : (elapsed > 0 ? mtd / elapsed : 0);
    var mdayList = [];
    for (var q = 1; q <= dim; q++) {
      var qk = dateKey(new Date(d0.getFullYear(), d0.getMonth(), q));
      mdayList.push({ k: qk, v: round(byDate[qk] || 0) });
    }
    var mPeak = mdayList.reduce(function (m, x) { return x.v > m.v ? x : m; }, { k: '', v: 0 });
    var spentDays = mdayList.filter(function (x) { return x.v > 0; });
    var higherThan = spentDays.filter(function (x) { return x.v > de; }).length;
    var mRank = de > 0 ? higherThan + 1 : 0;
    /* 刻度按「3 倍日均」封顶，不拿本月最高值当满格 ——
       一个月里只要有一天大额，其余日子就全挤在条子最左边，看着像没花 */
    var scaleMax = Math.max(monthDaily * 3, de, 1);
    var todayPct = Math.max(1.5, Math.min(100, de / scaleMax * 100));
    var avgPct = Math.max(0, Math.min(100, monthDaily / scaleMax * 100));
    var timesAvg = monthDaily > 0 ? de / monthDaily : 0;
    var todayTone = de > monthDaily * 1.05 ? 'is-up' : (de < monthDaily * .95 ? 'is-down' : '');
    var cmpCard =
      '<div class="ins-today">' +
      '<div class="it-top">' +
      '<b class="it-ratio ' + todayTone + '">' + (monthDaily > 0 ? timesAvg.toFixed(1) + '×' : '—') + '</b>' +
      '<span class="it-cap">今天 ' + fmtYuan(de) + '<br>日均 ' + fmtYuan(monthDaily) + '</span>' +
      '</div>' +
      '<div class="it-bar" data-tip="' + esc('今天 ' + fmtYuan(de) + ' · 本月日均 ' + fmtYuan(monthDaily) +
        ' · 本月单日最高 ' + fmtYuan(mPeak.v)) + '">' +
      '<i style="width:' + todayPct.toFixed(1) + '%"></i>' +
      '<u style="left:' + avgPct.toFixed(1) + '%"></u></div>' +
      '<div class="it-foot"><span>' +
      (spentDays.length ? '本月 ' + spentDays.length + ' 个消费日里第 ' + mRank + ' 多' : '本月还没有支出') +
      '</span><span>' + (mPeak.v > 0 ? '最高 ' + fmtBig(mPeak.v) : '') + '</span></div>' +
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

    /* 5) 体重记录：一条读数 + 一个变化量 + 一条迷你线。
       以前是「大数字 / 一行灰字 / 线飘在右边」三块各说各的，
       现在收成三层：读数与变化量对齐、线独占一行、底下补区间。 */
    var w = state.store.weights || {};
    var wkeys = Object.keys(w).filter(function (k) {
      return /^\d{4}-\d{2}-\d{2}$/.test(k) && isFinite(Number(w[k]));
    }).sort();
    var cur = w[key] ? Number(w[key]) : 0;
    var prevKeys = wkeys.filter(function (k) { return k < key; });
    var prev = prevKeys.length ? Number(w[prevKeys[prevKeys.length - 1]]) : 0;
    var lastKey = wkeys.length ? wkeys[wkeys.length - 1] : '';
    var show = cur || (lastKey ? Number(w[lastKey]) : 0);
    /* 变化量：今天有记录就跟上一次比；没有就跟最近两次比 */
    var delta = 0;
    if (cur && prev) delta = cur - prev;
    else if (!cur && wkeys.length > 1) delta = Number(w[lastKey]) - Number(w[wkeys[wkeys.length - 2]]);
    var wWhen = cur ? '今日' : (lastKey ? '最近一次 · ' + lastKey.slice(5).replace('-', '/') : '');
    var wLast = wkeys.slice(-7).map(function (k) { return Number(w[k]); });
    var wlo = wLast.length ? Math.min.apply(null, wLast) : 0;
    var whi = wLast.length ? Math.max.apply(null, wLast) : 1;
    /* 7 个点摊在 4 — 156 之间，纵向留 6 — 26，尾部圆点不贴边 */
    var wpts = wLast.map(function (v, i) {
      var px = 4 + i * (152 / Math.max(1, wLast.length - 1));
      var py = 26 - ((v - wlo) / Math.max(.1, whi - wlo)) * 20;
      return [px.toFixed(1), py.toFixed(1)];
    });
    var wSpark = '';
    if (wLast.length > 1) {
      var poly = wpts.map(function (q) { return q.join(','); }).join(' ');
      var tail = wpts[wpts.length - 1];
      wSpark = '<div class="iw-sparkwrap">' +
        '<svg class="iw-spark" viewBox="0 0 160 36" preserveAspectRatio="none" aria-hidden="true">' +
        '<polygon points="' + poly + ' 156,36 4,36"/>' +
        '<polyline points="' + poly + '"/>' +
        '</svg>' +
        /* 末端那颗点是 HTML 画圆的：SVG 横向拉满会把圆压成椭圆 */
        '<i class="iw-dot" style="left:' + (Number(tail[0]) / 160 * 100).toFixed(2) +
        '%;top:' + (Number(tail[1]) / 36 * 100).toFixed(2) + '%"></i>' +
        '</div>';
    }
    var dCls = Math.abs(delta) < .05 ? 'is-flat' : (delta > 0 ? 'is-up' : 'is-down');
    var weightCard = wkeys.length
      ? '<div class="ins-weight" data-focus-weight="1" title="点这里跳到体重输入框">' +
        '<div class="iw-top"><div class="iw-val"><b>' + show.toFixed(1) + '</b><i>kg</i></div>' +
        '<div class="iw-meta"><span class="iw-when">' + wWhen + '</span>' +
        (Math.abs(delta) >= .05
          ? '<em class="iw-delta ' + dCls + '">' + (delta > 0 ? '▲' : '▼') + ' ' + Math.abs(delta).toFixed(1) + '</em>'
          : '<em class="iw-delta is-flat">—</em>') +
        '</div></div>' +
        wSpark +
        '<div class="iw-foot"><span>最近 ' + wLast.length + ' 次</span>' +
        '<span>' + wlo.toFixed(1) + ' – ' + whi.toFixed(1) + ' kg</span></div>' +
        '</div>'
      : '<div class="iw-empty" data-focus-weight="1"><b>还没记过体重</b><span>点这里记第一条</span></div>';

    /* 3) 还剩多少：一行一件事。标题在左、结论在右，横条只表达"已经用掉多少"，
       下面一行写清参照与分子分母，不用再猜百分比是谁比谁。 */
    function compactY(v) {
      var n = Math.abs(v) || 0;
      return n >= 10000 ? (v / 10000).toFixed(n >= 100000 ? 0 : 1) + ' 万' : fmtChip(v);
    }
    var restCard =
      '<div class="ins-rest">' +
      '<div class="ir-line"><span>过往对比</span><b class="' + (mLeft < 0 ? 'is-over' : '') + '">' +
      (mLeft < 0 ? '超支 ' + fmtYuan(-mLeft) : fmtYuan(mLeft)) + '</b></div>' +
      '<div class="ir-bar" data-tip="' + esc('已花 ' + fmtYuan(mtd) + ' / 近 6 月月均 ' + fmtYuan(monthBudget)) +
      '"><i style="width:' + mLeftPct.toFixed(1) + '%"></i></div>' +
      '<div class="ir-note">已花 ' + fmtYuan(mtd) + ' · 近 6 月月均 ' + fmtYuan(monthBudget) + '</div>' +
      '<div class="ir-line is-now"><span>本月剩余</span><b class="' + (mNow < 0 ? 'is-over' : '') + '">' +
      (mNow < 0 ? '超支 ' + fmtYuan(-mNow) : fmtYuan(mNow)) + '</b></div>' +
      '<div class="ir-bar is-now" data-tip="' + esc('本月已花 ' + fmtYuan(mExp) + ' / 本月收 ' + fmtYuan(mInc)) +
      '"><i style="width:' + mNowPct.toFixed(1) + '%"></i></div>' +
      '<div class="ir-note">本月收 ' + fmtYuan(mInc) + ' · 支 ' + fmtYuan(mExp) + '</div>' +
      '<div class="ir-line is-year"><span>年度结余</span><b class="' + (yLeft < 0 ? 'is-over' : '') + '">' +
      (yLeft < 0 ? '超支 ' + fmtYuan(-yLeft) : fmtYuan(yLeft)) + '</b></div>' +
      '<div class="ir-bar is-year" data-tip="' + esc('今年收 ' + fmtYuan(yInc) + ' / 支 ' + fmtYuan(yExp)) +
      '"><i style="width:' + yLeftPct.toFixed(1) + '%"></i></div>' +
      '<div class="ir-note">收 ' + compactY(yInc) + ' · 支 ' + compactY(yExp) +
      ' · 存下 ' + (yInc > 0 ? Math.round((yInc - yExp) / yInc * 100) : 0) + '%</div>' +
      '</div>';

    return card('近 7 日支出', line7, 0) +
      card('今天花得多吗', cmpCard, 1) +
      card('还剩多少', restCard, 2) +
      card('当日分类构成', catCard, 3) +
      card('体重记录', weightCard, 4);
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
    if (need <= have + 1) { side.classList.remove('is-scroll'); return; }
    var k = Math.max(.72, have / need);
    inner.style.width = (100 / k).toFixed(3) + '%';
    var need2 = inner.scrollHeight || need;
    var k2 = Math.max(.72, Math.min(1, have / need2));
    inner.style.width = (100 / k2).toFixed(3) + '%';
    inner.style.transform = 'scale(' + k2.toFixed(4) + ')';
    /* 缩到 0.72 还装不下（1366×768 这种矮屏）：允许左栏自己滚，
       不然表单下半截被 overflow:hidden 直接切掉，金额和保存都摸不到 */
    var fits = inner.getBoundingClientRect().height <= have + 1;
    side.classList.toggle('is-scroll', !fits);
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
    /* 分组排序跟月/周格子同一口径：餐饮 → 日常 → 交通 → 服饰 → 娱乐 → 收入 */
    var order = Object.keys(groups).sort(function (a, b) {
      function rk(n) {
        if (n === '收入') return EXPENSE_CATS.length;
        var i = EXPENSE_CATS.indexOf(n);
        return i < 0 ? EXPENSE_CATS.length : i;
      }
      return rk(a) - rk(b);
    });
    /* v1.0.41：同一分类里按「记下的先后」排 —— 先记的在左，后记的接在后面。
       记录里没有独立时间字段，用 allRecords() 的原始下标当序号就够准：
       SEED 先入、本地新增按 added 数组顺序追加，正是写入顺序。 */
    var seqMap = {};
    allRecords().forEach(function (r, i) { if (seqMap[r.id] === undefined) seqMap[r.id] = i; });
    var catRowsHTML = order.map(function (g) {
      var gr = groups[g];
      gr.rows = gr.rows.slice().sort(function (a, b) { return (seqMap[a.id] || 0) - (seqMap[b.id] || 0); });
      var col = g === '收入' ? p.income : catColor(p, g);
      var ink = catInk(p, col);
      var chips = gr.rows.map(function (r) { return itemHTML(p, r); }).join('');
      return '<div class="dl-cat' + (g === '收入' ? ' is-inc' : '') + '" style="--c:' + col + ';--ink:' + ink + '">' +
        '<span class="dlc-bar"></span>' +
        '<div class="dlc-name"><b>' + esc(g) + '</b><i>' + gr.rows.length + ' 笔</i></div>' +
        '<div class="dlc-recs">' + chips + '</div>' +
        '<em class="dlc-total">' + (g === '收入' ? '+' : '−') + fmtYuan(gr.total) + '</em>' +
        '</div>';
    }).join('');
    if (!catRowsHTML) catRowsHTML = '<div class="day-empty"><strong>这天还没有记录</strong><span>用左侧的表单记下第一笔。</span></div>';

    quickCatManual = false;
    var qIdx = quickType === 'income' ? 1 : 0;
    var quickHTML =
      '<form class="ds-quick" id="quickEntryForm" novalidate>' +
      '<h4>＋ 记一笔 <span>' + esc(key) + '</span></h4>' +
      '<input type="hidden" id="qDate" value="' + esc(key) + '">' +
      '<div class="seg dq-seg" id="qTypeSeg" role="group" aria-label="收支类型" data-active="' + qIdx +
      '" style="--seg-n:2;--seg-i:' + qIdx + '">' +
      '<span class="seg-ind" aria-hidden="true"></span>' +
      '<button type="button" data-qtype="expense"' + (qIdx === 0 ? ' class="is-active"' : '') + '>− 支出</button>' +
      '<button type="button" data-qtype="income"' + (qIdx === 1 ? ' class="is-active"' : '') + '>＋ 收入</button>' +
      '</div>' +
      /* 顺序照他改的来：先说内容（写的时候顺手就把分类认出来了），
         分类子类其次，金额压到最后一行跟保存并排 */
      '<label class="dq-note"><span>内容</span><input type="text" id="qNote" maxlength="40" placeholder="例如：午餐、房租" autocomplete="off"></label>' +
      '<div class="dq-row">' +
      '<label><span>分类</span><select id="qCategory"></select></label>' +
      '<label><span>子类</span><select id="qSub"></select></label>' +
      '</div>' +
      '<div class="dq-bottom">' +
      '<div class="dq-amount"><i>¥</i><input type="number" id="qAmount" step="0.01" min="0.01" placeholder="0.00" required autocomplete="off" aria-label="金额"></div>' +
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
      '<div class="ds-head"><span class="ds-dow">' + WEEK_CN[d.getDay()] + '</span>' +
      '<span class="ds-ym">' + d.getFullYear() + ' 年 ' + (d.getMonth() + 1) + ' 月</span></div>' +
      '<div class="ds-big"><b>' + d.getDate() + '</b><i>日</i></div>' +
      '<div class="ds-net" style="--ds:' + (Math.abs(net) < .005 ? p.muted : net > 0 ? p.income : p.expense) + '">' +
      '<span>当日净额</span><b>' + (net >= 0 ? '+' : '−') + fmtYuan(Math.abs(net)).slice(1) + '</b></div>' +
      '<div class="ds-meta"><div><span>支出</span><b class="c-expense">' + fmtYuan(de) + '</b></div>' +
      '<div><span>收入</span><b class="c-income">' + fmtYuan(di) + '</b></div>' +
      '<div><span>笔数</span><b>' + items.length + '</b></div></div>' +
      quickHTML +
      weightHTML +
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
      '<div class="ins-title"><h3>关于这一天</h3><span>五张小图，看今天处在什么位置</span></div>' +
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
    /* v1.0.40：年历格子跟随当前分类色；「全部」保持原来的绿色 */
    var catKey = state.filters.category || 'all';
    var catHue = catKey === 'all' ? p.expense : (catKey === '收入' ? p.income : catColor(p, catKey));
    /* 一天里可能既有支出又有收入，所以两本账分开累计：
       支出染绿、收入染红，两样都有就把格子上下分色。
       早年版按筛选方向二选一，切到收入整张年历全空 —— 现在不分方向，各算各的。 */
    var de = {}, di = {}, monthDe = {}, monthDi = {}, peakE = 1, peakI = 1;
    board.forEach(function (r) {
      var inc = r.type === 'income';
      var day = inc ? di : de, mon = inc ? monthDi : monthDe;
      day[r.date] = round((day[r.date] || 0) + r.amount);
      mon[r.month] = round((mon[r.month] || 0) + r.amount);
      if (day[r.date] > (inc ? peakI : peakE)) { if (inc) peakI = day[r.date]; else peakE = day[r.date]; }
    });
    function alphaOf(v, peak) {
      var t = peak > 0 ? Math.min(1, v / peak) : 0;
      return v > 0 ? .16 + t * .74 : 0;
    }
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
        var e = de[key] || 0, inc = di[key] || 0;
        var ae = alphaOf(e, peakE), ai = alphaOf(inc, peakI);
        var bg = mixColor(p.surface3, p.surface, .45), ink = p.muted, tip = key + ' · 无记录';
        if (e && inc) {
            bg = 'linear-gradient(155deg,' + withAlpha(catHue, ae) + ' 0 47%,' +
            withAlpha(p.income, ai) + ' 53% 100%)';
          ink = Math.max(ae, ai) > .42 ? '#ffffff' : p.text2;
        } else if (e) {
          bg = withAlpha(catHue, ae);
          ink = ae > .42 ? '#ffffff' : catInk(p, catHue);
        } else if (inc) {
          bg = withAlpha(p.income, ai);
          ink = ai > .42 ? '#ffffff' : catInk(p, p.income);
        }
        if (e || inc) tip = key + ' · ' + (e ? '支 ' + fmtBig(e) : '') + (e && inc ? ' · ' : '') + (inc ? '收 ' + fmtBig(inc) : '');
        var cls = 'ym-day' + ((e || inc) ? ' has' : '') + (key === today ? ' is-today' : '') +
          (inc ? ' is-in' : '') + (e ? ' is-out' : '');
        grid += '<button type="button" class="' + cls + '" data-date="' + key +
          '" style="background:' + bg + ';color:' + ink +
          '" title="' + esc(tip) + '">' + d.getDate() + '</button>';
      }
      var mde = monthDe[m] || 0, mid = monthDi[m] || 0;
      var msum = (mde ? '<i class="c-expense">−' + fmtBig(mde).slice(1) + '</i>' : '') +
        (mid ? '<i class="c-income">+' + fmtBig(mid).slice(1) + '</i>' : '');
      html += '<article class="ym">' +
        '<button type="button" class="ym-head" data-month="' + m + '"><b>' + m + '月</b>' +
        '<span class="ym-msum">' + (msum || '<i>—</i>') + '</span></button>' +
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
    renderKpis();
    renderBoard();
    renderCharts(state.view);
  }

  /* ---------------- 视图 / 分段控件 ---------------- */
  /* 魔方统计是一个独立子应用：iframe 只在第一次进这一页时才加载，
     两边各用各的 localStorage（cubeLedger_v1 / qingzhang.*），互不读写。 */
  function cubePing() {
    var f = $('cubeFrame'), veil = $('cubeLoading');
    if (veil) veil.hidden = true;
    if (!f || !f.contentWindow) return;
    try {
      f.contentWindow.postMessage({ __ledgerTheme: state.theme, __ledgerCubeVisible: true }, '*');
    } catch (e) { /* noop */ }
  }
  function mountCube() {
    var f = $('cubeFrame');
    if (!f) return;
    if (LOCKED) return;        /* 没连仓库：iframe 连挂都不挂，子页那份数据也不落盘 */
    /* 私人仓库还在取魔方数据时先不挂 iframe —— 免得先画一屏空白再刷新 */
    if (window.__cubeDataReady === false) { setTimeout(mountCube, 120); return; }
    if (!f.getAttribute('src')) f.setAttribute('src', 'cube.html?v=' + ASSET_V);
    if (!f.__cubeBound) { f.addEventListener('load', cubePing); f.__cubeBound = true; }
    cubePing();
  }
  function bindCubeFrame() {
    document.addEventListener('click', function (e) {
      var t = e.target && e.target.closest ? e.target.closest('.cm-row') : null;
      if (!t) return;
      var filter = { tab: t.getAttribute('data-cube-jump') };
      filter[t.getAttribute('data-cube-key')] = t.getAttribute('data-v') || '';
      jumpCube(filter);
    });
    var b = $('cubeOpenBtn');
    if (b) b.addEventListener('click', function () { window.open('cube.html?v=' + ASSET_V, '_blank', 'noopener'); });
    var g = $('cubeGotoBtn');
    if (g) g.addEventListener('click', function () { setView('cube'); });
    var mini = $('cubeGotoMini');
    if (mini) mini.addEventListener('click', function () { jumpCube({ tab: 'cubes' }); });
    /* 魔方子页在另一个 localStorage 键里写数据，storage 事件同步刷新总览卡 */
    window.addEventListener('storage', function (e) {
      if (e && e.key === 'cubeLedger_v1') renderCubeOverview();
    });
  }


  /* v1.0.28：侧栏高亮是一块会走的底色，不是每项各自的背景。
     快速连点时先从 computed transform 读出当前位置冻住，再奔向新目标，
     所以不会闪回起点；缓动尾段带一点回弹。文字和图标始终不参与位移。 */
  var sideGlideState = null;
  function moveSideGlide(animate) {
    var nav = document.querySelector('.sidebar .nav'), g = document.getElementById('sideNavGlide');
    if (!nav || !g) return;
    var btn = nav.querySelector('.nav-item.is-active');
    if (!btn) { g.style.opacity = '0'; return; }
    var to = { x: btn.offsetLeft, y: btn.offsetTop, w: btn.offsetWidth, h: btn.offsetHeight };
    g.style.opacity = '1';
    if (!animate || !sideGlideState) {
      g.style.transform = 'translate3d(' + to.x + 'px,' + to.y + 'px,0)';
      g.style.width = to.w + 'px'; g.style.height = to.h + 'px';
      sideGlideState = to; return;
    }
    var cs = getComputedStyle(g), curX = to.x, curY = to.y;
    var curW = sideGlideState.w, curH = sideGlideState.h;
    try {
      var m = cs.transform.match(/matrix\(([^)]+)\)/);
      if (m) { var v = m[1].split(',').map(Number); curX = v[4]; curY = v[5]; }
      curW = parseFloat(cs.width) || curW; curH = parseFloat(cs.height) || curH;
    } catch (e) { /* noop */ }
    g.style.transition = 'none';
    g.style.width = curW + 'px'; g.style.height = curH + 'px';
    g.style.transform = 'translate3d(' + curX + 'px,' + curY + 'px,0)';
    void g.offsetWidth;
    g.style.transition = '';
    g.style.width = to.w + 'px'; g.style.height = to.h + 'px';
    g.style.transform = 'translate3d(' + to.x + 'px,' + to.y + 'px,0)';
    sideGlideState = to;
  }
  function setView(view, cubeTab) {
    if (!VIEW_META[view]) return;
    if (view !== 'cube') {
      var veil = $('cubeGlobalVeil');
      if (veil) { veil.classList.remove('is-on'); veil.hidden = true; }
    }
    softReset();
    /* 从有 title 的元素移进 iframe 时父页收不到 mouseout，提示会卡住不消失 */
    var stuckTip = $('hoverTip');
    if (stuckTip) stuckTip.hidden = true;
    state.view = view;
    var views = document.querySelectorAll('.view');
    for (var i = 0; i < views.length; i++) views[i].classList.toggle('is-active', views[i].id === 'view-' + view);
    var navs = document.querySelectorAll('.nav-item');
    for (var j = 0; j < navs.length; j++) {
      var item = navs[j], isCube = !!item.dataset.cubeTab;
      var on = view === 'cube'
        ? (item.dataset.view === 'cube' && item.dataset.cubeTab === (cubeTab || 'cubes'))
        : (item.dataset.view === view && !isCube);
      item.classList.toggle('is-active', on);
    }
    moveSideGlide(!!sideGlideState);
    /* 日历页要锁一整屏，正文底距归零，否则那 56px 会把日历顶出一截 */
    var main = document.querySelector('.main');
    if (main) main.classList.toggle('is-calendar', view === 'calendar');
    writeRoute(view, false);
    if (view === 'calendar') renderBoard();
    if (view === 'cube') mountCube();
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
    calendar: 'calendar', week: 'calendar', month: 'calendar', year: 'calendar', day: 'calendar',
    cube: 'cube', '魔方': 'cube'
  };
  var ROUTE_CANON = { overview: 'home', calendar: 'calendar', cube: 'cube' };

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

  /* v1.0.41：分段控件改成「按住拖过去就能选」，滑块跟手；
     按钮每次现取，后来才填进来的年份条也能直接用。 */
  function bindSeg(el, attr, handler) {
    if (!el) return;
    var last = null;
    function btns() { return [].slice.call(el.querySelectorAll('button[' + attr + ']')); }
    function apply(b, fire) {
      if (!b || b.parentNode !== el) return;
      var v = b.getAttribute(attr);
      btns().forEach(function (x) { x.classList.toggle('is-active', x === b); });
      var idx = btns().indexOf(b);
      el.dataset.active = String(idx);
      el.style.setProperty('--seg-n', String(btns().length || 1));
      el.style.setProperty('--seg-i', String(idx));
      if (fire && v !== last) { last = v; handler(v); }
    }
    var active = el.querySelector('button.' + 'is-active[' + attr + ']');
    if (active) last = active.getAttribute(attr);
    el.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('button[' + attr + ']') : null;
      apply(b, true);
    });
    el.addEventListener('pointerdown', function (e) {
      var b = e.target.closest ? e.target.closest('button[' + attr + ']') : null;
      if (!b) return;
      el.dataset.segDrag = '1';
      apply(b, true);
    });
    el.addEventListener('pointermove', function (e) {
      if (el.dataset.segDrag !== '1') return;
      var t = document.elementFromPoint(e.clientX, e.clientY);
      var b = t && t.closest ? t.closest('button[' + attr + ']') : null;
      if (b) apply(b, true);
    });
    document.addEventListener('pointerup', function () { el.dataset.segDrag = '0'; });
    document.addEventListener('pointercancel', function () { el.dataset.segDrag = '0'; });
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

  /* ---------------- Toast ----------------
     v1.0.38：加两档。
       opts.center —— 「已记下」那颗走屏幕正中、字号放大，记账是这一天的正事，
                      缩在右下角太像个通知。
       opts.sub    —— 第二行放这条记录本身（备注 · 分类 / 子类 · 日期），
                      刚存完就能核对，不用再翻列表。
     其余提示维持右下角小条，不抢戏。 */
  function toast(msg, kind, opts) {
    var stack = $('toastStack');
    if (!stack) return;
    opts = opts || {};
    var el = document.createElement('div');
    el.className = 'toast' + (kind ? ' ' + kind : '') + (opts.center ? ' is-center' : '') + (opts.low ? ' is-low' : '');
    /* 正中那颗带一个勾：一眼是「成了」，不是「有事」。其余提示还是小圆点。 */
    var mark = opts.center
      ? '<i class="t-ico" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none">' +
        '<path d="m5 12.5 4.5 4.5L19 7.5" stroke="currentColor" stroke-width="3" ' +
        'stroke-linecap="round" stroke-linejoin="round"/></svg></i>'
      : '<i></i>';
    el.innerHTML = mark + '<span class="t-main">' + esc(msg) + '</span>' +
      (opts.sub ? '<span class="t-sub">' + esc(opts.sub) + '</span>' : '');
    stack.appendChild(el);
    var life = opts.ms || (opts.center ? 2100 : 2600);
    setTimeout(function () {
      el.classList.add('is-out');
      setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 360);
    }, life);
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
    /* 格子弹窗里日期收成标题下一颗胶囊：点的就是那一格，不用再占一行 */
    var chip = $('modalChip');
    if (chip && s) {
      var mm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
      chip.textContent = mm ? (Number(mm[1]) + ' 年 ' + Number(mm[2]) + ' 月 ' + Number(mm[3]) + ' 日 · ' + weekLabel(s))
        : (s + ' · ' + weekLabel(s));
    }
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

  /* ---------------- 通用日期浮层（报销卡） ----------------
     记账弹窗那颗 #datePop 是绑死在 #dateField 上的，报销卡里有 N 个日期框
     （添加行一个、列表每行一个），所以另起一颗可移动的浮层：
     样式整套沿用 .date-pop / .dp-*，只是挂到 body 上按锚点定位。
     点日期 = 选中并关闭；点「完成」只关不选；Esc / 点外面都关。 */
  var gp = { el: null, open: false, view: 'days', year: 0, month: 0, value: '', anchor: null, onPick: null };

  function gpBuild() {
    if (gp.el) return gp.el;
    var el = document.createElement('div');
    el.className = 'date-pop gp-pop';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', '选择日期');
    el.hidden = true;
    el.innerHTML =
      '<div class="dp-head">' +
      '<button type="button" class="dp-nav" data-gp="prev" aria-label="上一页">' +
      '<svg viewBox="0 0 24 24" fill="none"><path d="m15 6-6 6 6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>' +
      '<button type="button" class="dp-title" data-gp="title" aria-label="切换月份选择">—</button>' +
      '<button type="button" class="dp-nav" data-gp="next" aria-label="下一页">' +
      '<svg viewBox="0 0 24 24" fill="none"><path d="m9 6 6 6-6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>' +
      '</div>' +
      '<div class="dp-week"><span>日</span><span>一</span><span>二</span><span>三</span><span>四</span><span>五</span><span>六</span></div>' +
      '<div class="dp-view" data-gp="days"><div class="dp-grid" data-gp="grid"></div></div>' +
      '<div class="dp-view dp-months" data-gp="months" hidden></div>' +
      '<div class="dp-foot"><button type="button" class="link-btn" data-gp="today">回到今天</button>' +
      '<button type="button" class="dp-close" data-gp="close">完成</button></div>';
    document.body.appendChild(el);
    gp.el = el;
    el.addEventListener('click', gpOnClick);
    document.addEventListener('click', function (e) {
      if (!gp.open) return;
      if (el.contains(e.target)) return;
      if (e.target.closest && e.target.closest('.ri-date-btn, .pr-date')) return;
      gpClose();
    });
    document.addEventListener('keydown', function (e) { if (gp.open && e.key === 'Escape') gpClose(); });
    window.addEventListener('resize', function () { if (gp.open) gpPlace(); });
    return el;
  }
  function gpRender() {
    var el = gp.el;
    if (!el) return;
    var title = el.querySelector('[data-gp="title"]');
    var daysBox = el.querySelector('[data-gp="days"]');
    var monthsBox = el.querySelector('[data-gp="months"]');
    var grid = el.querySelector('[data-gp="grid"]');
    title.textContent = gp.view === 'days' ? (gp.year + '年 ' + gp.month + '月') : (gp.year + '年 · 选择月份');
    daysBox.hidden = gp.view !== 'days';
    monthsBox.hidden = gp.view !== 'months';
    if (gp.view === 'months') {
      monthsBox.innerHTML = MONTH_CN.map(function (n, i) {
        return '<button type="button" class="dp-month' + (i + 1 === gp.month ? ' is-active' : '') +
          '" data-gp-month="' + (i + 1) + '">' + n + '</button>';
      }).join('');
      return;
    }
    var first = new Date(gp.year, gp.month - 1, 1);
    var offset = first.getDay();
    var daysInMonth = new Date(gp.year, gp.month, 0).getDate();
    var count = Math.ceil((offset + daysInMonth) / 7) * 7;
    var today = todayStr();
    var html = '';
    for (var i = 0; i < count; i++) {
      var d = new Date(gp.year, gp.month - 1, 1 - offset + i);
      var key = dateKey(d);
      var cls = 'dp-day';
      if (d.getMonth() !== gp.month - 1) cls += ' is-other';
      if (key === today) cls += ' is-today';
      if (key === gp.value) cls += ' is-selected';
      html += '<button type="button" class="' + cls + '" data-gp-day="' + key + '" aria-label="' + key + '">' + d.getDate() + '</button>';
    }
    grid.innerHTML = html;
  }
  function gpPlace() {
    var el = gp.el, a = gp.anchor;
    if (!el || !a) return;
    var r = a.getBoundingClientRect();
    var w = el.offsetWidth || 302, h = el.offsetHeight || 360;
    var left = Math.min(Math.max(10, r.left), Math.max(10, window.innerWidth - w - 10));
    var top = r.bottom + 8;
    if (top + h > window.innerHeight - 10) top = Math.max(10, r.top - h - 8);
    el.style.left = Math.round(left) + 'px';
    el.style.top = Math.round(top) + 'px';
  }
  function gpShift(delta) {
    if (gp.view === 'months') gp.year += delta;
    else {
      gp.month += delta;
      if (gp.month < 1) { gp.month = 12; gp.year -= 1; }
      else if (gp.month > 12) { gp.month = 1; gp.year += 1; }
    }
    gpRender();
  }
  function gpOnClick(e) {
    var t = e.target.closest ? e.target : null;
    if (!t) return;
    if (t.closest('[data-gp="prev"]')) { gpShift(-1); return; }
    if (t.closest('[data-gp="next"]')) { gpShift(1); return; }
    if (t.closest('[data-gp="title"]')) { gp.view = gp.view === 'days' ? 'months' : 'days'; gpRender(); return; }
    var mBtn = t.closest('[data-gp-month]');
    if (mBtn) { gp.month = Number(mBtn.getAttribute('data-gp-month')); gp.view = 'days'; gpRender(); return; }
    if (t.closest('[data-gp="today"]')) { gpPick(todayStr()); return; }
    if (t.closest('[data-gp="close"]')) { gpClose(); return; }
    var day = t.closest('[data-gp-day]');
    if (day) gpPick(day.getAttribute('data-gp-day'));
  }
  function gpPick(key) {
    var cb = gp.onPick;
    gpClose();
    if (cb) cb(key);
  }
  function gpOpen(anchor, value, onPick) {
    gpBuild();
    gp.anchor = anchor;
    gp.onPick = onPick || null;
    gp.value = /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) ? String(value) : '';
    var m = /^(\d{4})-(\d{2})/.exec(gp.value);
    var d = new Date();
    gp.year = m ? Number(m[1]) : d.getFullYear();
    gp.month = m ? Number(m[2]) : (d.getMonth() + 1);
    gp.view = 'days';
    gp.open = true;
    gp.el.hidden = false;
    gp.el.classList.add('is-open');
    gpRender();
    gpPlace();
    if (anchor && anchor.classList) anchor.classList.add('is-open');
  }
  function gpClose() {
    if (!gp.el || !gp.open) return;
    gp.open = false;
    gp.el.hidden = true;
    gp.el.classList.remove('is-open');
    if (gp.anchor && gp.anchor.classList) gp.anchor.classList.remove('is-open');
    gp.anchor = null;
  }


  /* ---------------- 弹窗：记账 ---------------- */
  /* 天页内嵌记账表单：与弹窗共用一套落库逻辑，只是字段前缀不同。
     用独立前缀避免和弹窗的 id 撞车，两个入口可以同时存在于 DOM 里。 */
  var quickType = 'expense';
  /* 手动改过分类就别再被自动识别抢回去；两个入口各记一份 */
  var modalCatManual = false, quickCatManual = false;
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
    if (!c) {
      sel.style.color = ''; sel.style.backgroundColor = ''; sel.style.borderColor = '';
      if (window.UISelect) { try { UISelect.syncAll(); } catch (e) {} }
      return;
    }
    var p = palette();
    sel.style.color = catInk(p, c);
    sel.style.backgroundColor = mixColor(c, p.surface, .9);
    sel.style.borderColor = mixColor(c, p.border, .55);
    /* 原生 select 已经隐身了，颜色只有同步到自绘 trigger 上才看得见 */
    if (window.UISelect) { try { UISelect.syncAll(); } catch (e) {} }
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
  /* 子类留空时，实时回显"会被归到哪"——不选也能看见结果。
     没命中就说清兜底规则，不再假报一个「其它」。 */
  function updateSubHint() {
    var sel = $('fSub'), note = $('fSubNote');
    if (!sel || !note) return;
    if (sel.value) {
      note.textContent = '已手动指定';
      note.classList.remove('is-auto');
      return;
    }
    var cat = ($('fCategory') && $('fCategory').value) || '餐饮';
    var txt = (($('fNote') && $('fNote').value) || '').trim();
    var hit = txt ? guessSubHit(cat, txt) : '';
    note.textContent = hit
      ? ('将自动归入「' + hit + '」')
      : ('留空按内容归类，认不出记「' + guessSub(cat, '') + '」');
    note.classList.add('is-auto');
  }
  function setEntryType(t) {
    state.entryType = t === 'income' ? 'income' : 'expense';
    var box = $('typeToggle');
    if (box) {
      var bs = box.querySelectorAll('button[data-type]');
      for (var i = 0; i < bs.length; i++) bs[i].classList.toggle('is-active', bs[i].dataset.type === state.entryType);
      /* 滑块靠 --seg-i 平移，和日历顶栏那几组分段控件同一套机制 */
      var idx = state.entryType === 'income' ? 1 : 0;
      box.dataset.active = String(idx);
      box.style.setProperty('--seg-i', String(idx));
      resetSegInd(box);
    }
    fillCategoryOptions();
  }
  /* v1.0.40：取消记一笔的输入记忆。
     上一笔的备注 / 分类 / 金额不再跟到下一笔；这里只留一个清道夫，
     把老版本写进 localStorage 的草稿删掉，免得升级后第一次打开还回填旧值。 */
  var ENTRY_DRAFT_KEY = 'qingzhang.entryDraft.v1';
  function clearEntryDraft() { try { localStorage.removeItem(ENTRY_DRAFT_KEY); } catch (e) {} }
  function openModal(record, prefillDate, mode) {
    /* 没连私有仓库就不给记账口子：写了也没地方去，还会在本机留痕 */
    if (LOCKED) { showLockGate(true); return; }
    /* 手机上记账浮层弹出前先收起筛选区，别让那一排按钮压在表单上 */
    collapseFiltersOnMobile();
    lastFocused = document.activeElement;
    state.editingId = record ? record.id : null;
    if ($('modalTitle')) $('modalTitle').textContent = record ? '编辑记录' : '记一笔';
    if ($('modalDesc')) $('modalDesc').textContent = record ? '修改后即时更新所有图表与统计。' : '记录一条新的收支流水';
    if ($('modalSave')) $('modalSave').textContent = '保存';
    if ($('modalDelete')) $('modalDelete').hidden = !record;
    /* cell：从月历 / 周历格子弹出来的，用天页那套「内容在上、金额在下」的排布；
       default：侧栏「记一笔」，保持原来的顺序 */
    document.body.classList.toggle('modal-cell', mode === 'cell');
    if ($('modalChip')) $('modalChip').hidden = mode !== 'cell';
    modalCatManual = false;
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
    if (!record) clearEntryDraft();
    var back = $('modalBackdrop');
    if (back) { clearTimeout(modalCloseTimer); back.classList.remove('is-closing'); back.hidden = false; }
    setTimeout(function () {
      var first = (mode === 'cell' && $('fNote')) ? $('fNote') : $('fAmount');
      if (first) first.focus();
    }, 120);
  }
  var modalCloseTimer = 0;
  function closeModal(reason) {
    if (reason === 'esc' && !state.editingId) clearEntryDraft();
    var back = $('modalBackdrop');
    closeDp();
    document.body.classList.remove('modal-cell');
    if (back && !back.hidden) {
      clearTimeout(modalCloseTimer);
      back.classList.add('is-closing');
      modalCloseTimer = setTimeout(function () {
        back.hidden = true;
        back.classList.remove('is-closing');
        modalCloseTimer = 0;
      }, 240);
    }
    state.editingId = null;
    if ($('modalDelete')) $('modalDelete').hidden = true;
    if (lastFocused && typeof lastFocused.focus === 'function') lastFocused.focus();
    lastFocused = null;
  }
  /* 记完之后「哪一笔是刚记的」必须一眼看见。
     分三步：先给记录打上 is-new 的身份证（重绘也不会丢），
     再确认那一行真的在当前视图里（不在就先把日历挪过去），
     最后把那一行滚到眼前。4.2 秒后自动摘牌，不留下永久高亮。 */
  function focusNewRecord(rec) {
    var sel = '.cal-item[data-id="' + rec.id + '"]';
    var el = document.querySelector(sel);
    if (!el) {
      var b = rangeBounds();
      var out = !(rec.date >= dateKey(b.from) && rec.date <= dateKey(b.to));
      if (out || state.scale === 'year') {
        var d = new Date(rec.date + 'T00:00:00');
        if (state.scale === 'year') { state.scale = 'month'; setSegActive($('scaleSeg'), 'data-scale', 'month'); }
        setAnchor(d);
        renderBoard();
        renderCharts('calendar');
        el = document.querySelector(sel);
      }
    }
    if (!el) return;
    el.classList.add('is-new');
    try { el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (e) {}
    setTimeout(function () {
      if (el.classList.contains('is-new')) el.classList.remove('is-new');
    }, 4300);
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
      /* 刚记的这笔带上身份证：接下来 4 秒内，它那一行会闪一下、亮一框 */
      state.newId = rec.id;
      state.newUntil = Date.now() + 4200;
      /* 正中那颗大字气泡，副标题把这一笔自己交代清楚：
         备注 · 分类/子类 · 日期 —— 存完抬头看一眼就知道记对了没有 */
      toast('已记下 ' + fmtYuan(rec.amount), 'success', {
        center: true, low: true,
        sub: [rec.note,
              rec.category + (rec.sub ? ' / ' + rec.sub : ''),
              rec.date].filter(Boolean).join('   ·   ')
      });
    }
    saveStore();
    renderAll();
    if (!v.editingId) focusNewRecord(rec);
    else {
      var edited = document.querySelector('.cal-item[data-id="' + rec.id + '"]');
      if (edited) { edited.classList.add('is-new'); setTimeout(function () { edited.classList.remove('is-new'); }, 3200); }
    }
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
    if ($('confirmDesc') && rec) $('confirmDesc').textContent = rec.date + ' · ' + rec.note + ' · ' + fmtYuan(rec.amount) + '，删除后 3 秒内可以撤销。';
    var back = $('confirmBackdrop');
    if (back) back.hidden = false;
  }
  function closeConfirm() {
    var back = $('confirmBackdrop');
    if (back) back.hidden = true;
    state.pendingDeleteId = null;
  }

  /* ---------------- 撤销删除：底部悬浮条 + 3 秒倒计时 ---------------- */
  var undoStack = [], undoTimer = 0;   /* v1.0.40：保留最近 3 次删除 */
  function snapshotStore() {
    return JSON.stringify({
      added: state.store.added,
      edited: state.store.edited,
      deleted: state.store.deleted
    });
  }
  function hideUndo(keep) {
    clearTimeout(undoTimer);
    undoTimer = 0;
    var bar = $('undoBar');
    if (bar) {
      if (keep) { bar.hidden = true; bar.classList.remove('is-out'); undoStack = []; return; }
      bar.classList.add('is-out');
      setTimeout(function () { if (bar.classList.contains('is-out')) { bar.hidden = true; bar.classList.remove('is-out'); } }, 240);
    }
    undoStack = [];
  }
  /* 展示栈顶：一条倒计时归零后弹出它，下面还有就接着显示（重新给 3 秒） */
  function paintUndo() {
    var bar = $('undoBar'), txt = $('undoText'), prog = $('undoProg');
    var top = undoStack[undoStack.length - 1];
    if (!top) { hideUndo(); return; }
    if (bar) { bar.hidden = false; bar.classList.remove('is-out'); }
    if (txt) txt.textContent = top.label + (undoStack.length > 1 ? ' · 还可撤销 ' + (undoStack.length - 1) + ' 项' : '');
    if (prog) { prog.style.animation = 'none'; void prog.offsetWidth; prog.style.animation = ''; }
    clearTimeout(undoTimer);
    undoTimer = setTimeout(function () {
      undoStack.pop(); undoTimer = 0;
      if (undoStack.length) paintUndo(); else hideUndo();
    }, 3000);
  }
  function showUndo(label, snap, id) {
    undoStack.push({ label: label, snap: snap, id: id });
    if (undoStack.length > 3) undoStack.shift();
    paintUndo();
  }
  function doUndo() {
    var top = undoStack.pop();
    if (!top) return;
    var back = JSON.parse(top.snap);
    state.store.added = back.added;
    state.store.edited = back.edited;
    state.store.deleted = back.deleted;
    saveStore();
    renderAll();
    highlightRestored(top.id);
    toast('已恢复', 'success', { low: true });
    if (undoStack.length) paintUndo(); else hideUndo();
  }

  /* 撤销恢复：只亮这一条，不把整份快照里的其他记录一起点亮 */
  function highlightRestored(id) {
    if (!id) return;
    var row = document.querySelector('.cal-item[data-id="' + id + '"]') ||
      document.querySelector('[data-id="' + id + '"]');
    if (!row) return;
    row.classList.add('is-restored');
    setTimeout(function () { row.classList.remove('is-restored'); }, 1800);
  }

  /* ---------------- 粒子湮灭：删掉的那一行被左风向右吹散 ----------------
     行一消失，账就已经从数据里没了；留在屏幕上的是它的「灰」。
     v1.0.39 改了三件事：
       1) 风向 —— 以前是从中线向四周炸开（像爆），现在统一从左往右吹（像风）。
          每颗粒子起点往左偏一点，落点右移 70~320px，纵向按行高的 1.3 倍散开，
          末段再往上飘 20px，读起来就是「被一阵风带走」。
       2) 密度 —— 粒子数按面积算，从 30~72 提到 64~170；
          尺寸也分了大中小三档，密而不糊。
       3) 节奏 —— 时长 900~1460ms（以前 520~800），起步缓、中途加速、末端收尾，
          消散范围随之变大，眼睛来得及跟着看完。 */
  function dissolveNode(node, wait) {
    wait = wait || 0;   /* v1.0.41：弹窗先退场，粒子晚 0.3—0.5s 再起飞 */
    if (!node || !node.getBoundingClientRect) return false;
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return false;
    var r = node.getBoundingClientRect();
    if (r.width < 6 || r.height < 4) return false;
    if (r.bottom < -40 || r.top > window.innerHeight + 40) return false;

    var p = palette();
    var cs = getComputedStyle(node);
    var nodeBg = cs.backgroundColor && cs.backgroundColor !== 'rgba(0, 0, 0, 0)' ? cs.backgroundColor : p.surface2;
    var accent = (cs.getPropertyValue('--c') || '').trim() || p.primary;
    /* v1.0.40：粒子一律从这一行自己的颜色派生，不再混进全局蓝色 */
    var tints = [accent, accent, mixColor(accent, '#ffffff', .24), mixColor(accent, p.text, .18),
                 mixColor(accent, '#ffffff', .46), nodeBg];

    var layer = document.createElement('div');
    layer.className = 'dissolve-layer';
    if (wait) layer.style.animationDelay = wait + 'ms';
    layer.style.left = r.left + 'px';
    layer.style.top = r.top + 'px';
    layer.style.width = r.width + 'px';
    layer.style.height = r.height + 'px';

    var flash = document.createElement('i');
    flash.className = 'dissolve-flash';
    layer.appendChild(flash);

    var area = r.width * r.height;
    var count = Math.max(120, Math.min(320, Math.round(area / 165)));
    var spreadY = r.height * 1.3 + 96;      /* 纵向散开范围：比行高再多一截 */

    for (var i = 0; i < count; i++) {
      var dot = document.createElement('b');
      /* 三档粒径：细沙 / 碎屑 / 小块，混着撒才不像筛子 */
      var tier = Math.random();
      var size = tier < .62 ? .9 + Math.random() * 1.3 : (tier < .92 ? 2.1 + Math.random() * 1.4 : 3.5 + Math.random() * 1.8);
      var x = Math.random() * r.width;
      var y = Math.random() * r.height;
      dot.style.cssText = 'left:' + x.toFixed(1) + 'px;top:' + y.toFixed(1) + 'px;' +
        'width:' + size.toFixed(1) + 'px;height:' + size.toFixed(1) + 'px;' +
        'background:' + tints[(Math.random() * tints.length) | 0] + ';' +
        'border-radius:' + (Math.random() < .45 ? '50%' : '1.5px') + ';';
      layer.appendChild(dot);
      if (!dot.animate) { dot.style.opacity = '0'; continue; }

      /* 左 -> 右：起点再往左拽 4~14px（像被风先把灰压过去一点），
         落点全部在右侧；越靠右的粒子被吹得越远（风道效应） */
      var lane = x / Math.max(1, r.width);
      var dx = 70 + Math.random() * 150 + lane * (r.width * .55 + 90);
      var dy = (Math.random() - .5) * spreadY - 10 - Math.random() * 26;
      var dur = 900 + Math.random() * 560;
      dot.animate([
        { transform: 'translate3d(-' + (4 + Math.random() * 10).toFixed(1) + 'px,0,0) scale(1)', opacity: .96, offset: 0 },
        { transform: 'translate3d(' + (dx * .38).toFixed(1) + 'px,' + (dy * .42).toFixed(1) + 'px,0) scale(.82)', opacity: .78, offset: .42 },
        { transform: 'translate3d(' + (dx * .86).toFixed(1) + 'px,' + (dy * .9).toFixed(1) + 'px,0) scale(.34)', opacity: .34, offset: .82 },
        { transform: 'translate3d(' + dx.toFixed(1) + 'px,' + (dy - 6).toFixed(1) + 'px,0) scale(.05)', opacity: 0, offset: 1 }
      ], {
        duration: dur,
        delay: wait + Math.random() * 170,
        easing: 'cubic-bezier(.42,.06,.48,.94)',
        fill: 'forwards'
      });
    }
    document.body.appendChild(layer);
    setTimeout(function () { if (layer.parentNode) layer.parentNode.removeChild(layer); }, 1760 + wait);
    return true;
  }

  function confirmDelete() {
    var id = state.pendingDeleteId;
    if (!id) return;
    var snap = snapshotStore();
    var rec = allRecords().filter(function (r) { return r.id === id; })[0] || {};
    var label = '已删除「' + (rec.note || rec.category || '这条记录') + '」 ' + fmtYuan(Math.abs(Number(rec.amount) || 0));
    /* 先抓 DOM 再动数据：renderAll 一跑，那一行就没了，粒子得从它还活着的位置起飞 */
    var node = document.querySelector('.cal-item[data-id="' + id + '"]') ||
      document.querySelector('[data-id="' + id + '"]');
    dissolveNode(node, 100);

    if (state.store.deleted.indexOf(id) === -1) state.store.deleted.push(id);
    state.store.added = state.store.added.filter(function (r) { return r.id !== id; });
    if (state.store.edited[id]) delete state.store.edited[id];
    saveStore();
    closeConfirm();
    closeModal();
    renderAll();
    showUndo(label, snap, id);
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
    try { localStorage.setItem(THEME_KEY, t); } catch (e) { /* noop */ }
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', t === 'dark' ? '#0d121c' : '#f5f7fa');
    var root = document.documentElement;
    /* v1.0.43：不再走 startViewTransition。
       那条管线会把旧帧拍成快照再和新帧交叉淡入，浅切成深的那一下整屏先亮起来，
       就是他说的「闪、刺眼」。现在直接换 token，只在换色的这两帧按住全站过渡
       （几十个控件各自补间 220ms，屏幕上就是一层从旧配色化过去的抖动）。 */
    root.classList.add('theme-snap');
    root.setAttribute('data-theme', t);
    if (!deferCharts) renderCharts(state.view, 'instant');
    /* 让 iframe 同一帧换色；子页自己会 repaint 行底色与图表 */
    var f = $('cubeFrame');
    if (f && f.contentWindow) { try { f.contentWindow.postMessage({ __ledgerTheme: t }, '*'); } catch (e) {} }
    requestAnimationFrame(function () {
      requestAnimationFrame(function () { root.classList.remove('theme-snap'); });
    });
  }

  /* 换肤：光晕已取消。只做一次 token + 图表配色的同步替换，
     不生成覆盖层、不读写布局、不设切换锁，连点也能立刻响应。
     底色与卡面本来就没有 background-color 过渡，所以是干净的一帧切换。 */
  function setTheme(t) {
    if (t === state.theme) return;
    applyTheme(t, true);
    /* 筛选胶囊的 --c / --ink 是渲染时按主题算好写死在内联样式里的，
       只重绘图表不会动它们 —— 必须连同筛选区一起重画，否则文字要等下一次点击才跟上。
       筛选区在日历页，切主题时人可能正停在总览，所以这里直接无条件重排一遍。 */
    renderCatBar(palette());
    refreshAfterColor();
    cubePing();
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

  /* ---------------- 工资与五险一金 ----------------
     一张可改的计算表：基数、工资、每项比例都是输入框，缴费金额跟着算，
     改完全部落在 localStorage（qingzhang.pay.v1）。右边是报销台账，
     一条一条加、一条一条删，顶部给合计。 */
  var PAY_KEY = 'qingzhang.pay.v1';
  var pay = null;
  function payDefaults() {
    return {
      base: 8477, wage: 6400, perf: 2425, subsidy: 550, gap: 32.075,
      rows: [
        { name: '养老金', p: 8, c: 0 },
        { name: '公积金', p: 7, c: 7 },
        { name: '医保金', p: 2, c: 8.08 },
        { name: '失业保险', p: 0.5, c: 0 },
        { name: '补充公积金', p: 2, c: 2 }
      ],
      reimb: []
    };
  }
  /* 把一份（可能缺字段的）pay 洗成能直接渲染的形状：缺的用出厂值补，
     rows 空着就回落到五行，金额 / 日期不合规的条目丢掉。 */
  function payOrDefaults(o) {
    var d = payDefaults();
    if (!o || typeof o !== 'object') return d;
    ['base', 'wage', 'perf', 'subsidy', 'gap'].forEach(function (k) {
      var v = Number(o[k]);
      if (isFinite(v)) d[k] = v;
    });
    if (Array.isArray(o.rows) && o.rows.length) {
      var rows = o.rows.filter(function (r) { return r && r.name; }).map(function (r) {
        return { name: String(r.name), p: Number(r.p) || 0, c: Number(r.c) || 0 };
      });
      if (rows.length) d.rows = rows;
    }
    if (Array.isArray(o.reimb)) {
      d.reimb = o.reimb.filter(function (r) { return r && isFinite(Number(r.amount)) && Number(r.amount) > 0; }).map(function (r) {
        return { id: String(r.id || ''), note: String(r.note || ''), amount: round(r.amount), date: String(r.date || '') };
      });
      d.reimb.sort(function (a, b) { return a.date === b.date ? 0 : (a.date < b.date ? 1 : -1); });
    }
    return d;
  }
  /* 数据从哪来：① store（云端 / 上次落盘）优先；② 老版本只存 localStorage，
     读出来当场接管，之后跟着云同步一起走 —— 一次性的搬家。
     门禁没过就没有 ① 也没有 ②：社保、报销一并归零，页面上不出现任何数字。 */
  function loadPay() {
    if (LOCKED) { pay = payOrDefaults(null); return; }
    var src = (state.store && state.store.pay) ? cleanPay(state.store.pay) : null;
    var fromLocal = false;
    if (!src) {
      try {
        var raw = JSON.parse(localStorage.getItem(PAY_KEY));
        if (raw && typeof raw === 'object') { src = raw; fromLocal = true; }
      } catch (e) { /* 坏数据就退回默认 */ }
    }
    pay = payOrDefaults(src);
    if (fromLocal) savePay();          /* 搬家：写进 store，下一次同步就带上云 */
  }
  /* 只写 store（→ 密屉）。明文那份不再落盘。 */
  function savePay() {
    if (LOCKED) return;
    try { localStorage.removeItem(PAY_KEY); } catch (e) { /* noop */ }
    if (!state.store) return;
    state.store.pay = cleanPay({
      base: pay.base, wage: pay.wage, perf: pay.perf, subsidy: pay.subsidy, gap: pay.gap,
      rows: pay.rows, reimb: pay.reimb
    });
    saveStore();
  }
  function payVal(id, fallback) {
    var el = $(id);
    var v = el ? Number(el.value) : NaN;
    return isFinite(v) ? v : (fallback || 0);
  }
  function buildPayRows() {
    var box = $('payRows');
    if (!box) return;
    box.innerHTML = pay.rows.map(function (r, i) {
      return '<tr data-row="' + i + '">' +
        '<th>' + esc(r.name) + '</th>' +
        /* 比例格里再包一层：td 一旦改成 flex 就不再是表格单元格，列宽会塌 */
        '<td class="pay-rate-cell"><div class="pay-rate">' +
        '<label><input type="number" data-i="' + i + '" data-k="p" step="0.01" min="0" value="' + r.p + '" aria-label="' + esc(r.name) + '个人比例"><i>%</i></label>' +
        '<label><input type="number" data-i="' + i + '" data-k="c" step="0.01" min="0" value="' + r.c + '" aria-label="' + esc(r.name) + '公司比例"><i>%</i></label>' +
        '</div></td>' +
        '<td class="pay-ip" data-cell="ip">—</td>' +
        '<td class="pay-ic" data-cell="ic">—</td>' +
        '<td class="pay-sum" data-cell="sum">—</td>' +
        '</tr>';
    }).join('');
  }
  function payFillInputs() {
    if ($('payBase')) $('payBase').value = pay.base;
    if ($('payWage')) $('payWage').value = pay.wage;
    if ($('payPerf')) $('payPerf').value = pay.perf;
    if ($('paySubsidy')) $('paySubsidy').value = pay.subsidy;
    if ($('payGap')) $('payGap').value = pay.gap;
  }
  /* 只刷数字格，不重建 DOM —— 边打字边算，焦点不会被抢走 */
  function renderPayNumbers() {
    var base = payVal('payBase', pay.base);
    var ip = 0, ic = 0;
    pay.rows.forEach(function (r, i) {
      var tr = document.querySelector('#payRows tr[data-row="' + i + '"]');
      if (!tr) return;
      var a = base * r.p / 100, b = base * r.c / 100;
      ip += a; ic += b;
      tr.querySelector('[data-cell="ip"]').textContent = a ? fmtYuan(a) : '—';
      tr.querySelector('[data-cell="ic"]').textContent = b ? fmtYuan(b) : '—';
      tr.querySelector('[data-cell="sum"]').textContent = fmtYuan(a + b);
    });
    var wage = payVal('payWage', pay.wage);
    var gap = payVal('payGap', pay.gap);
    var gross = wage - ip;
    var net = gross - gap;
    /* 合计不再挤在表格最后一行（六列宽里数字会被截断），
       单独做一条三格摘要：个人 / 公司 / 应发，再加上实发那一格横幅。 */
    var foot = $('payFoot');
    if (foot) {
      foot.innerHTML =
        '<div class="ps-cell"><span>个人合计</span><b class="is-exp">' + fmtYuan(ip) + '</b></div>' +
        '<div class="ps-cell"><span>公司合计</span><b>' + fmtYuan(ic) + '</b></div>' +
        '<div class="ps-cell"><span>缴费共计</span><b>' + fmtYuan(ip + ic) + '</b></div>' +
        '<div class="ps-cell is-gross"><span>应发</span><b>' + fmtYuan(gross) + '</b><i>工资 − 个人缴费</i></div>' +
        '<div class="ps-cell is-net"><span>实发</span><b>' + fmtYuan(net) + '</b>' +
        '<i>应发 − 差距 ' + fmtYuan(gap) + ' · 绩效 ' + fmtYuan(payVal('payPerf', pay.perf)) +
        ' · 补贴 ' + fmtYuan(payVal('paySubsidy', pay.subsidy)) + '</i></div>';
    }
    /* 卡头只留一句结论：每月到底到手多少 */
    var sub = $('paySub');
    if (sub) {
      sub.textContent = '每年合计 ' + fmtYuan(net * 12) + ' · 本月到手 ' + fmtYuan(net);
    }
  }
  function sortReimb() {
    /* 日期倒序，同一天保持先来后到 */
    pay.reimb.sort(function (a, b) { return a.date === b.date ? 0 : (a.date < b.date ? 1 : -1); });
  }
  /* 添加行那颗日期按钮：显示完整日期，点开是同一套日历浮层 */
  function paintReimbDate() {
    var hid = $('payReimbDate'), txt = $('payReimbDateText'), btn = $('payReimbDateBtn');
    var v = (hid && hid.value) || '';
    var ok = /^\d{4}-\d{2}-\d{2}$/.test(v);
    if (txt) txt.textContent = ok ? v : '选择日期';
    if (btn) btn.title = ok ? (v + ' · ' + weekLabel(v)) : '选择日期';
  }
  function renderReimb() {
    var list = $('payReimbList'), hint = $('payReimbHint'), total = $('payReimbTotal');
    if (!list) return;
    var sum = 0;
    pay.reimb.forEach(function (r) { sum += Number(r.amount) || 0; });
    list.innerHTML = pay.reimb.map(function (r) {
      return '<li data-rid="' + esc(r.id) + '">' +
        '<span class="pr-note">' + esc(r.note || '报销') + '</span>' +
        '<em class="pr-amt">' + fmtYuan(r.amount) + '</em>' +
        /* 每行自带日期：点开日历改，改完立刻重排 */
        '<button type="button" class="pr-date" data-reimb-date="' + esc(r.id) + '"' +
        ' title="改日期 · ' + esc(r.date || '') + '" aria-label="' + esc(r.note || '报销') + '的日期">' +
        '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="3" stroke="currentColor" stroke-width="1.8"/>' +
        '<path d="M3 10h18M8 3v4M16 3v4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>' +
        '<b>' + esc(r.date || '选日期') + '</b></button>' +
        '<button type="button" class="pr-del" data-reimb-del="' + esc(r.id) + '" title="删除这条" aria-label="删除 ' + esc(r.note || '报销') + '">×</button>' +
        '</li>';
    }).join('');
    list.hidden = !pay.reimb.length;
    if (hint) hint.hidden = !!pay.reimb.length;
    if (total) total.textContent = fmtYuan(sum);
    var sub = $('payReimbSub');
    if (sub) {
      sub.textContent = pay.reimb.length
        ? pay.reimb.length + ' 条 · 合计 ' + fmtYuan(sum) + ' · 日期可点开改'
        : '垫出去的钱、回来的钱，一条一条记';
    }
  }
  function renderPay() {
    if (!pay) return;
    payFillInputs();
    buildPayRows();
    renderPayNumbers();
    renderReimb();
  }
  function addReimb(e) {
    e.preventDefault();
    var note = ($('payReimbNote') && $('payReimbNote').value || '').trim();
    var amt = Number($('payReimbAmount') && $('payReimbAmount').value);
    var day = ($('payReimbDate') && $('payReimbDate').value) || '';
    if (!isFinite(amt) || amt <= 0) { toast('报销金额要大于 0', 'warn'); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) day = todayStr();
    pay.reimb.unshift({
      id: 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
      note: note || '报销',
      amount: round(amt),
      date: day
    });
    /* 新的排在最上面：按日期倒序，同一天按记的顺序 */
    sortReimb();
    savePay();
    if ($('payReimbNote')) $('payReimbNote').value = '';
    if ($('payReimbAmount')) $('payReimbAmount').value = '';
    renderReimb();
    toast('已记一笔报销 ' + fmtYuan(amt), 'success');
  }
  function initPay() {
    loadPay();
    renderPay();
    if ($('payReimbDate') && !$('payReimbDate').value) $('payReimbDate').value = todayStr();
    paintReimbDate();
    var wrap = document.querySelector('.pay-card');
    /* 社保卡：所有输入都委托在一个口子上，改比例立刻重算，改基数/工资也一样 */
    if (wrap) wrap.addEventListener('input', function (e) {
      var t = e.target;
      if (!t) return;
      if (t.dataset && t.dataset.i !== undefined) {
        var i = Number(t.dataset.i), k = t.dataset.k;
        if (pay.rows[i]) pay.rows[i][k] = Number(t.value) || 0;
      } else if (t.id === 'payBase') pay.base = Number(t.value) || 0;
      else if (t.id === 'payWage') pay.wage = Number(t.value) || 0;
      else if (t.id === 'payPerf') pay.perf = Number(t.value) || 0;
      else if (t.id === 'paySubsidy') pay.subsidy = Number(t.value) || 0;
      else if (t.id === 'payGap') pay.gap = Number(t.value) || 0;
      savePay();
      renderPayNumbers();
    });
    if (wrap) wrap.addEventListener('click', function (e) {
      if (e.target.closest && e.target.closest('#payReset')) {
        pay = payDefaults();
        savePay();
        renderPay();
        if ($('payReimbDate') && !$('payReimbDate').value) $('payReimbDate').value = todayStr();
        toast('已恢复默认数字', 'info');
      }
    });
    /* 报销卡：删除、改日期都是自己的口子，和社保互不干扰。
       日期一律走 gpOpen 那颗通用日历浮层 —— 添加行和列表每行共用一套。 */
    var rbox = document.querySelector('.reimb-card');
    if ($('payReimbDateBtn')) $('payReimbDateBtn').addEventListener('click', function () {
      var btn = this;
      gpOpen(btn, ($('payReimbDate') && $('payReimbDate').value) || todayStr(), function (v) {
        if ($('payReimbDate')) $('payReimbDate').value = v;
        paintReimbDate();
      });
    });
    if (rbox) rbox.addEventListener('click', function (e) {
      var del = e.target.closest && e.target.closest('[data-reimb-del]');
      if (del) {
        var did = del.getAttribute('data-reimb-del');
        pay.reimb = pay.reimb.filter(function (r) { return r.id !== did; });
        savePay();
        renderReimb();
        return;
      }
      var dt = e.target.closest && e.target.closest('[data-reimb-date]');
      if (!dt) return;
      var rid = dt.getAttribute('data-reimb-date');
      var rec = pay.reimb.filter(function (r) { return r.id === rid; })[0];
      gpOpen(dt, (rec && rec.date) || todayStr(), function (v) {
        pay.reimb.forEach(function (r) { if (r.id === rid) r.date = v; });
        sortReimb();
        savePay();
        renderReimb();
        toast('日期已改到 ' + v, 'info');
      });
    });
    var form = $('payReimbForm');
    if (form) form.addEventListener('submit', addReimb);
  }

  function bindEvents() {
    window.addEventListener('resize', function () { moveSideGlide(false); });
    var navs = document.querySelectorAll('.nav-item');
    for (var i = 0; i < navs.length; i++) {
      navs[i].addEventListener('click', function () {
        var tab = this.dataset.cubeTab;
        if (tab) jumpCube({ tab: tab });
        else setView(this.dataset.view);
      });
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
    /* 消费日历的年份按钮跟着数据走：补进 2022 / 2023 之后不能再写死三年 */
    (function () {
      var box = $('calendarYear');
      if (!box) return;
      var want = YEARS.slice();
      var have = [].map.call(box.querySelectorAll('button'), function (b) { return Number(b.getAttribute('data-cy')); });
      if (want.length === have.length && want.every(function (y, i) { return y === have[i]; })) return;
      var ind = box.querySelector('.seg-ind');
      box.innerHTML = '';
      if (ind) box.appendChild(ind);
      want.forEach(function (y) {
        var b = document.createElement('button');
        b.type = 'button';
        b.setAttribute('data-cy', String(y));
        b.textContent = String(y);
        if (y === state.calendarYear) b.className = 'is-active';
        box.appendChild(b);
      });
    })();
    bindSeg($('calendarYear'), 'data-cy', function (v) {
      state.calendarYear = Number(v);
      renderCalendar(palette());
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
    /* 支出 / 收入滑块：和日历那几组同款，按住鼠标能一路拖过去。
       拖动时它自己点中间的按钮，走的还是上面那条 setEntryType 链路。 */
    enableSegDrag($('typeToggle'));
    if ($('fCategory')) $('fCategory').addEventListener('change', function () {
      modalCatManual = true;
      paintSelect($('fCategory'));
      fillSubOptions();
    });
    if ($('fSub')) $('fSub').addEventListener('change', updateSubHint);
    if ($('fNote')) $('fNote').addEventListener('input', function () {
      /* 边打边认：连收支方向一起认 —— 写「工资」自动切收入，
         写「午饭」自动切回支出并选餐饮。自己手点过分类之后只锁分类，方向照认 */
      var hit = guessEntry(this.value);
      if (hit) {
        if (hit.type !== state.entryType) setEntryType(hit.type);
        var sel2 = $('fCategory');
        if (!modalCatManual && sel2 && sel2.value !== hit.cat) {
          sel2.value = hit.cat;
          paintSelect(sel2);
          fillSubOptions();
          return;
        }
      }
      updateSubHint();
    });
    if ($('modalClose')) $('modalClose').addEventListener('click', closeModal);
    if ($('modalCancel')) $('modalCancel').addEventListener('click', closeModal);
    if ($('modalDelete')) $('modalDelete').addEventListener('click', function () {
      if (state.editingId) openConfirm(state.editingId);
    });
    /* v1.0.38 · 只有「在遮罩上按下、又在遮罩上松手」才算点空白处。
       以前只判 click 的 target：在弹窗里按住鼠标往外一拖，松手时浏览器把 click
       派给两者的共同祖先（也就是遮罩），弹窗就这么被误关了。
       现在按下那一刻记住起手位置，松手位置对不上就不关。 */
    function backdropDismiss(back, onClose) {
      if (!back) return;
      var downOnBack = false;
      back.addEventListener('mousedown', function (e) { downOnBack = (e.target === back); });
      back.addEventListener('pointerdown', function (e) { downOnBack = (e.target === back); });
      back.addEventListener('click', function (e) {
        if (e.target === back && downOnBack) { downOnBack = false; onClose(); return; }
        downOnBack = false;
      });
    }
    backdropDismiss($('modalBackdrop'), closeModal);
    if ($('confirmCancel')) $('confirmCancel').addEventListener('click', function () { closeConfirm(); });
    if ($('confirmOk')) $('confirmOk').addEventListener('click', confirmDelete);
    backdropDismiss($('confirmBackdrop'), closeConfirm);
    if ($('undoBtn')) $('undoBtn').addEventListener('click', doUndo);
    bindDonutYear();
    bindSeg($('weightYear'), 'data-wy', function (v) {
      state.weightYear = v;
      renderCharts('overview', 'instant');
    });
    /* v1.0.40：魔方子页在 iframe 里开弹窗时，父页这一层也跟着糊起来。
       v1.0.43：这一层改成整屏一张、中间给 iframe 挖洞。
       子页是透明的（html.is-embed），整屏铺过去会和他自己那张 42% / 7px
       叠成两层，左右两侧的虚化就深浅不一。洞的位置按 iframe 真实矩形写。 */
    var veil = $('cubeGlobalVeil');
    function veilBand() {
      if (!veil || veil.hidden) return;
      var f = $('cubeFrame');
      if (!f) return;
      var r = f.getBoundingClientRect();
      if (!r.width || !r.height) return;
      var W = Math.round(window.innerWidth), H = Math.round(window.innerHeight);
      var x = Math.round(r.left), y = Math.round(r.top);
      var w = Math.round(r.width), h = Math.round(r.height);
      /* 外圈顺时针、内圈逆时针：nonzero 规则下内圈就是一个洞 */
      veil.style.clipPath = 'path("M0 0H' + W + 'V' + H + 'H0Z ' +
        'M' + x + ' ' + y + 'V' + (y + h) + 'H' + (x + w) + 'V' + y + 'Z")';
      veil.style.webkitClipPath = veil.style.clipPath;
    }
    function cubeCloseFrameModal() {
      var f = $('cubeFrame');
      if (f && f.contentWindow) { try { f.contentWindow.postMessage({ __cubeModalClose: true }, '*'); } catch (e) {} }
    }
    if (veil) {
      veil.addEventListener('click', function () { cubeCloseFrameModal(); });
      window.addEventListener('resize', veilBand);
    }
    window.addEventListener('message', function (e) {
      var d = e && e.data; if (!d || !d.__cubeModal) return;
      var veil = $('cubeGlobalVeil'); if (!veil) return;
      if (d.open) {
        veil.hidden = false;
        veilBand();
        requestAnimationFrame(function () { veil.classList.add('is-on'); veilBand(); });
      } else {
        veil.classList.remove('is-on');
        setTimeout(function () { veil.hidden = true; }, 240);
      }
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        if (dp.open) { closeDp(); return; }
        if (cmpOpen) { closeCmp(); return; }
        /* 魔方 / 比赛弹窗在 iframe 里：焦点留在父页时父页先接到这个键，
           直接转给子页走它的顶层优先路径（确认框 → 编辑弹窗 → 目录弹窗） */
        if (veil && !veil.hidden) { cubeCloseFrameModal(); return; }
        if (!$('confirmBackdrop').hidden) { closeConfirm(); return; }
        closeModal('esc');
        return;
      }
      /* ← → 翻页：年 / 月 / 周 / 天 四种粒度都走 softStep，
         和两颗箭头、滚轮同一套出入动效 */
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        if (state.view !== 'calendar') return;
        if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
        if (dp.open || cmpOpen || !$('modalBackdrop').hidden || !$('confirmBackdrop').hidden) return;
        var t = e.target;
        if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || ''))) return;
        e.preventDefault();
        softStep(e.key === 'ArrowLeft' ? -1 : 1);
      }
    });

    /* 日历：粒度 / 步进 / 筛选 / 交互 */
    bindSeg($('scaleSeg'), 'data-scale', function (v) { setScale(v); });
    bindWheelPaging();
    if ($('calPrev')) $('calPrev').addEventListener('click', function () { softStep(-1); });
    if ($('calNext')) $('calNext').addEventListener('click', function () { softStep(1); });
    if ($('calToday')) $('calToday').addEventListener('click', function () {
      var d = new Date();
      setAnchor(d);
      state.focusDate = '';
      renderBoard(); renderCharts('calendar');
    });
    /* 工具条里不再重复放一个"记一笔"：顶栏那个一直都在，
       在日历页时把它的默认日期接到当前视图上 */
    if ($('addBtn')) $('addBtn').addEventListener('click', function () {
      /* v1.0.35：站在魔方工作台里时，「记一笔」跟着当前子页走：
         魔方统计 -> 新增购买记录；比赛记录 -> 新增比赛；其余 -> 原来的记一笔。 */
      if (state.view === 'cube') {
        var f = $('cubeFrame');
        var tab = 'cubes';
        try {
          var d = f && f.contentWindow && f.contentWindow.document;
          var active = d && d.querySelector('.panel.active');
          if (active) tab = active.id;
        } catch (e) { /* 跨域/未加载就按魔方统计处理 */ }
        if (tab === 'cubes' || tab === 'competitions') {
          var sent = false;
          try { sent = !!(f && f.contentWindow && (f.contentWindow.postMessage({ __cubeAdd: tab }, '*'), true)); } catch (e) {}
          if (sent) return;
        }
      }
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
      state.filters = { q: '', type: 'all', category: 'all', sub: 'all', weekday: 'all', amount: 'all' };
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
      if (add) { openModal(null, add.dataset.add, 'cell'); return; }

      var item = e.target.closest('[data-id]');
      if (item) {
        /* 点具体某一笔（月历 / 周历 / 日页都一样）直接开编辑弹窗，
           不再把人甩到当天的页面 —— 只是想改个数，不该丢上下文。
           想看当日明细走别的入口：双击格子、或格子右上角的「+N」。 */
        var rec = allRecords().filter(function (r) { return r.id === item.dataset.id; })[0];
        if (rec) openModal(rec);
        return;
      }

      var cell = e.target.closest('.cal-cell[data-date]');
      if (cell && cell.dataset.other === '0') { queueCellAdd(cell.dataset.date); return; }

      var wk = e.target.closest('.wk-col[data-date]');
      if (wk) queueCellAdd(wk.dataset.date);
    });

    /* 双击格子 = 进当日明细。双击的前一下已经在队列里排了个「记一笔」，
       这里先把它撤掉（慢双击连已经弹出的框一起收回），再跳转。 */
    if (boardEl) boardEl.addEventListener('dblclick', function (e) {
      var cell = e.target.closest('.cal-cell[data-date], .wk-col[data-date]');
      if (!cell || cell.dataset.other === '1') return;
      absorbDoubleTap(cell.dataset.date);
      jumpToDay(cell.dataset.date);
    });

    /* 判定窗内第二下按下去 = 一次双击正在进行：立刻撤掉挂起的弹框，
       不用等 dblclick 事件到（这样快双击全程都不会闪出浮层）。 */
    if (boardEl) boardEl.addEventListener('pointerdown', function () {
      if (cellTapTimer) cancelCellAdd();
    }, true);

    /* 天页内嵌表单是每次重绘都重建的，事件只能委托在稳定的 .cal-board 上 */
    if (boardEl) {
      boardEl.addEventListener('submit', function (e) {
        if (e.target && e.target.id === 'quickEntryForm') submitQuick(e);
        if (e.target && e.target.id === 'weightForm') submitWeight(e);
      });
      boardEl.addEventListener('input', function (e) {
        if (!e.target || e.target.id !== 'qNote') return;
        /* 天页表单同理：认方向 + 认分类，手选过分类就不再覆盖分类 */
        var hit = guessEntry(e.target.value);
        if (hit) {
          if (hit.type !== quickType) {
            quickType = hit.type;
            var seg = $('qTypeSeg');
            if (seg) {
              var qi = quickType === 'income' ? 1 : 0;
              seg.dataset.active = String(qi);
              seg.style.setProperty('--seg-i', String(qi));
              resetSegInd(seg);
            }
            fillQuickCats();
          }
          if (!quickCatManual) {
            var sel = $('qCategory');
            if (sel && sel.value !== hit.cat) { sel.value = hit.cat; paintSelect(sel); fillQuickSubs(); }
          }
        }
      });
      boardEl.addEventListener('change', function (e) {
        if (e.target && e.target.id === 'qCategory') { quickCatManual = true; paintSelect($('qCategory')); fillQuickSubs(); }
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

  /* 单击格子 = 就地记一笔（弹出框，日期预填），双击格子 = 进当日明细。
     判窗压到 110ms —— 比一帧慢、比一次双击的间隔快，手指抬起后弹框基本同时到。
     真正的双击靠两处兜住：第二次 pointerdown 一落就直接撤掉挂起的弹框（快双击不闪），
     以及 dblclick 里把「刚刚就是这一格弹出来的」框收回（慢双击也不留残影）。 */
  var CELL_TAP_MS = 110;
  var CELL_TAP_FRESH = 450;
  var cellTapTimer = 0, openByTap = { key: '', t: 0 };
  function queueCellAdd(key) {
    if (cellTapTimer) clearTimeout(cellTapTimer);
    cellTapTimer = setTimeout(function () {
      cellTapTimer = 0;
      openByTap = { key: key, t: Date.now() };
      openModal(null, key, 'cell');
    }, CELL_TAP_MS);
  }
  function cancelCellAdd() {
    if (cellTapTimer) { clearTimeout(cellTapTimer); cellTapTimer = 0; }
  }
  /* 双击落地：撤挂起项，顺手把可能已经弹出来的那一格收回，再跳日 */
  function absorbDoubleTap(key) {
    cancelCellAdd();
    var bd = $('modalBackdrop');
    if (bd && !bd.hidden && openByTap.key === key && Date.now() - openByTap.t < CELL_TAP_FRESH) closeModal();
    openByTap = { key: '', t: 0 };
  }

  /* ---------------- 翻页：整页推走，下一页跟着顶进来 ----------------
     v1.0.44 那版是「淡出 130ms → 换内容 → 淡入 240ms」：位移只有 30px，
     观感就是滑了一点点、内容忽然没了、又忽然出来 —— 你说的「闪一下」。
     现在是真翻页：旧页连内容一起做成一张绝对定位的副本（ghost）压在原位，
     新内容先渲染在屏幕外，然后两层同一时长、同一条缓动、同时平移一整页高度
     （年历 / 月历竖着推，周历 / 天横着推）。中途没有任何透明度变化、
     没有内容交换的瞬间，所以不存在闪。 */
  var TURN_MS = 420;            /* 一整页滑完的时长，期间不再接新的翻页 */
  var TURN_EASE = 'cubic-bezier(.4,0,.2,1)';
  var WHEEL_TRIGGER = 80;       /* 滚轮攒够这么多像素算一格 */
  var turnLock = 0, turnTimer = 0, ptGhost = null;
  var wheelAcc = 0, wheelDir = 0, wheelQuiet = 0;

  function softTarget() {
    var s = state.scale;
    return s === 'year' ? $('calYearBoard')
      : s === 'month' ? $('calGrid')
      : s === 'week' ? $('calWeekGrid') : $('calDayBoard');
  }

  /* 把翻页留下的东西全收掉：ghost 摘掉、内联位移清空、旧类名也擦一遍
     （换粒度那一瞬间，正在动的可能是上一块棋盘）。 */
  function ptSettle(el) {
    if (ptGhost && ptGhost.parentNode) ptGhost.parentNode.removeChild(ptGhost);
    ptGhost = null;
    [el, $('calGrid'), $('calWeekGrid'), $('calDayBoard'), $('calYearBoard')].forEach(function (n) {
      if (!n) return;
      n.classList.remove('pt-out', 'pt-in');
      n.style.transition = '';
      n.style.transform = '';
      n.style.willChange = '';
      n.style.removeProperty('--pt-x');
      n.style.removeProperty('--pt-y');
    });
  }

  function softReset() {
    if (turnTimer) { clearTimeout(turnTimer); turnTimer = 0; }
    if (wheelQuiet) { clearTimeout(wheelQuiet); wheelQuiet = 0; }
    turnLock = 0; wheelAcc = 0; wheelDir = 0;
    ptSettle(softTarget());
  }

  /* 一次翻页：旧页整块推出去，新页从另一头滑进来。
     dir > 0 是往后翻（下一月 / 下一周）。轴按粒度分：
     年历 / 月历竖着推，周历 / 天横着拨。 */
  function turnVertical() {
    return state.scale === 'year' || state.scale === 'month';
  }

  function pageTurn(dir) {
    var el = softTarget();
    if (!el) { shiftCalStep(dir); return; }
    if (turnTimer) { clearTimeout(turnTimer); turnTimer = 0; }
    ptSettle(el);

    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) { shiftCalStep(dir); return; }

    var vert = turnVertical();
    var w = el.offsetWidth, h = el.offsetHeight;
    var size = vert ? h : w;
    if (!size) { shiftCalStep(dir); return; }

    /* 旧页副本：绝对定位盖在原位，接着自己滑走 */
    var host = el.offsetParent || el.parentNode;
    var ghost = el.cloneNode(true);
    ghost.removeAttribute('id');
    ghost.removeAttribute('hidden');
    Array.prototype.forEach.call(ghost.querySelectorAll('[id]'), function (n) { n.removeAttribute('id'); });
    ghost.setAttribute('aria-hidden', 'true');
    ghost.className = el.className + ' pt-ghost';
    ghost.style.cssText = 'position:absolute;left:' + el.offsetLeft + 'px;top:' + el.offsetTop + 'px;' +
      'width:' + w + 'px;height:' + h + 'px;margin:0;pointer-events:none;z-index:1;' +
      'transform:translate3d(0,0,0);will-change:transform;';
    host.appendChild(ghost);
    ptGhost = ghost;

    /* 终点：旧页 = ±一整页；新页起点 = 反方向一整页（此刻屏外，看不见） */
    var out = dir > 0 ? -size : size;
    var push = function (px) { return vert ? 'translate3d(0,' + px + 'px,0)' : 'translate3d(' + px + 'px,0,0)'; };

    el.style.transition = 'none';
    el.style.willChange = 'transform';
    el.style.transform = push(-out);
    void el.offsetWidth;

    /* 新内容在屏幕外渲染好 —— 换内容这一步不留任何视觉痕迹 */
    shiftCalStep(dir);

    var run = function () {
      var tf = 'transform ' + TURN_MS + 'ms ' + TURN_EASE;
      ghost.style.transition = tf;
      el.style.transition = tf;
      ghost.style.transform = push(out);
      el.style.transform = 'translate3d(0,0,0)';
      turnTimer = setTimeout(function () {
        turnTimer = 0;
        ptSettle(el);
      }, TURN_MS + 60);
    };
    if (window.requestAnimationFrame) {
      requestAnimationFrame(function () { requestAnimationFrame(run); });
    } else {
      run();
    }
  }

  /* 箭头 / ← →：一次点击就是一次翻页 */
  function softStep(dir) {
    closeCmp();
    if (turnLock && Date.now() < turnLock) return;
    turnLock = Date.now() + TURN_MS;
    pageTurn(dir);
  }

  /* 滚轮：攒够一格翻一次。翻页那 300ms 里再来的滚轮直接丢掉 ——
     一次手势就是一页；长按着滚也只是一页页翻完，绝不叠着跳。 */
  function softWheel(d) {
    if (!d) return;
    var dir = d > 0 ? 1 : -1;
    if (wheelDir && dir !== wheelDir) wheelAcc = 0;
    wheelDir = dir;
    wheelAcc += d;
    if (wheelQuiet) clearTimeout(wheelQuiet);
    wheelQuiet = setTimeout(function () { wheelQuiet = 0; wheelAcc = 0; wheelDir = 0; }, 240);
    if (Math.abs(wheelAcc) < WHEEL_TRIGGER) return;
    wheelAcc = 0;
    if (turnLock && Date.now() < turnLock) return;
    turnLock = Date.now() + TURN_MS;
    pageTurn(dir);
  }

  function bindWheelPaging() {
    [
      { el: $('calGrid'), skip: '' },
      { el: $('calWeekGrid'), skip: '' },
      { el: $('calDayBoard'), skip: '.day-side' },  /* 左栏表单自己要能滚，不抢它的滚轮 */
      { el: $('calYearBoard'), skip: '' }           /* 年历：滚轮直接换年份 */
    ].forEach(function (z) {
      if (!z.el) return;
      z.el.addEventListener('wheel', function (e) {
        if (state.view !== 'calendar') return;
        if (!$('modalBackdrop').hidden || !$('confirmBackdrop').hidden) return;
        if (dp.open || cmpOpen || (window.QZ && window.QZ.pickOpen && window.QZ.pickOpen())) return;
        if (z.skip && e.target.closest && e.target.closest(z.skip)) return;
        /* 横着滚认横、竖着滚认竖：鼠标滚轮和触控板两个方向都吃得下 */
        var raw = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
        if (!raw) return;
        e.preventDefault();
        /* 统一成像素：按行滚的老设备 ×16，按页滚的 ×320 */
        var d = raw;
        if (e.deltaMode === 1) d = raw * 16;
        else if (e.deltaMode === 2) d = raw * 320;
        softWheel(d);
      }, { passive: false });
    });
  }


  function jumpFromKpi(kind) {
    if (kind === 'income') { jumpToDetail({ reset: true, type: 'income', label: '已筛选：全部收入' }); return; }
    if (kind === 'expense') { jumpToDetail({ reset: true, type: 'expense', label: '已筛选：全部支出' }); return; }
    if (kind === 'rate') { setView('overview'); toast('已打开总览', 'info'); return; }
    jumpToDetail({ reset: true, label: '已跳转日历' });
  }

  /* ---------------- 手机筛选折叠 ---------------- */
  function collapseFiltersOnMobile() {
    var box = $('ctFilters'), btn = $('ctFilterToggle');
    if (!box || !btn || !window.matchMedia || !window.matchMedia('(max-width: 760px)').matches) return;
    box.classList.add('is-collapsed');
    btn.setAttribute('aria-expanded', 'false');
    btn.classList.remove('is-on');
  }
  function bindFilterCollapse() {
    var box = $('ctFilters'), btn = $('ctFilterToggle');
    if (!box || !btn) return;
    var mq = window.matchMedia ? window.matchMedia('(max-width: 760px)') : null;
    function set(collapsed) {
      box.classList.toggle('is-collapsed', !!collapsed);
      btn.setAttribute('aria-expanded', String(!collapsed));
      btn.classList.toggle('is-on', !collapsed);
      requestAnimationFrame(resizeAll);
    }
    set(!!(mq && mq.matches));
    btn.addEventListener('click', function () { set(!box.classList.contains('is-collapsed')); });
    if (mq) {
      if (mq.addEventListener) mq.addEventListener('change', function (e) { set(e.matches); });
      else if (mq.addListener) mq.addListener(function (e) { set(e.matches); });
    }
  }

  /* ---------------- 启动 ---------------- */
  /* 未连接时的整屏门禁：主内容区一块说明，按钮直接开云同步面板。
     页面结构上不是「数据藏起来了」，而是根本没有数据可渲染。 */
  var lockShown = false;
  function showLockGate(pulse) {
    var el = $('lockGate');
    if (!el) return;
    if (!lockShown) {
      lockShown = true;
      el.hidden = false;
      requestAnimationFrame(function () { el.classList.add('is-on'); });
      var b = $('lockConnect');
      if (b) b.addEventListener('click', function () {
        var s = $('syncBtn');
        if (s) { s.click(); return; }
        if (window.QZSync && window.QZSync.open) window.QZSync.open();
      });
    }
    if (pulse) {
      el.classList.remove('is-nudge');
      void el.offsetWidth;
      el.classList.add('is-nudge');
    }
  }
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
  /* 默认布局：2026-11-16 按发来的 JSON 定版（v3 原值照抄，版本号顶到 4
     让所有旧记录自动作废）。消费日历提到第二位，下面三张图并排，
     社保 / 报销各占半宽 —— 分享给别人打开就是这一张。 */
  var DEFAULT_LAYOUT = {
    v: 9,
    order: ['kpi', 'calheat', 'trend', 'donut', 'balance', 'weight', 'stack', 'top',
      'cubestats', 'cubeyear', 'cubetype',
      'cubebrand', 'cubeprice', 'compyear', 'compprov', 'compprice',
      'salary', 'reimb'],
    spans: {
      kpi: [12, 3], calheat: [12, 7], trend: [5, 6], donut: [3, 6], balance: [4, 6],
      weight: [5, 5], stack: [4, 5], top: [3, 5],
      cubestats: [12, 3],
      cubeyear: [6, 5], cubetype: [6, 5],
      cubebrand: [4, 5], cubeprice: [4, 5], compyear: [4, 5],
      compprov: [6, 5], compprice: [6, 5],
      salary: [6, 11], reimb: [6, 8]
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
    return 'p' + Math.random().toString(36).slice(2, 7);
  }
  function ovTitleOf(el) {
    var h = el.querySelector('h3, h2');
    if (h) return h.textContent.trim();
    if (el.classList.contains('stat-strip')) return '收支总览';
    return '板块';
  }
  function validLayout(L) {
    return !!(L && L.v === 9 && Array.isArray(L.order) && L.spans && typeof L.spans === 'object');
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
    var L = { v: 8, order: [], spans: {} };
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
      /* 存下来的旧布局里没有这个板块时，退回注册表里的默认尺寸，
         而不是一律 [12,6] —— 否则新板块第一次出现会被压扁 */
      var sp = (L.spans && L.spans[el.dataset.ovId]) ||
        (DEFAULT_LAYOUT.spans && DEFAULT_LAYOUT.spans[el.dataset.ovId]) || [12, 6];
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
    /* 私人数据门禁：没连到主人仓库就是空账本；连上了先读完私有仓库
       再启动渲染，否则图表会先按空数据画一遍，再整体重画。 */
    var ready = (window.BILL_READY && typeof window.BILL_READY.then === 'function')
      ? window.BILL_READY : Promise.resolve(window.BILL_DATA || {});
    Promise.resolve(ready).then(function (d) { applyDataset(d); startApp(); },
      function () { applyDataset({}); startApp(); });
  }
  function startApp() {
    var pv = window.QZPrivate && window.QZPrivate.status && window.QZPrivate.status();
    if (pv && pv.error) toast('私人数据未载入：' + pv.error + '（当前显示空账本）', 'warn');
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
    bindFilterCollapse();
    bindCubeFrame();
    bindDatePicker();
    bindHoverTip();
    state.layout = readLayout();
    initOverviewLayout();
    initPay();
    syncFilterUI();
    setSegActive($('scaleSeg'), 'data-scale', state.scale);
    renderAll();
    enableSegDragAll();

    /* 默认打开日历；地址栏带深链（含旧的 #/analysis）则优先深链 */
    var initialRoute = parseRoute() || 'calendar';
    bindRoute();
    setView(initialRoute);

    /* 门禁没过：整块内容换成「未解锁」，不给看也不给记 */
    if (LOCKED) showLockGate(false);

    if (!hasEcharts) toast('ECharts 未加载，图表不可用', 'warn');
    /* 魔方页在后台先热起来：点导航时不再等 iframe 加载 + 图表首绘 */
    setTimeout(mountCube, 700);
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
        pay: state.store.pay || null,
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
        weightCleared: cleanWeightCleared(s.weightCleared),
        pay: cleanPay(s.pay)
      };
      state.store = next;
      mergeSeedWeights();
      var changed = JSON.stringify(next) !== before;
      /* 社保 / 报销也跟着 store 走了：远端那份和本地不一样就重画两张卡。
         值相同就不动 DOM —— 每分钟轮询不会把正在编辑的输入框重建掉。 */
      var inPay = next.pay ? JSON.stringify(payOrDefaults(next.pay)) : '';
      if (inPay && pay && inPay !== JSON.stringify(pay)) {
        pay = payOrDefaults(next.pay);
        renderPay();
        paintReimbDate();
      }
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
    pickOpen: function () { return !!gp.open; },
    toast: toast
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
