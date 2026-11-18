/* ============================================================
   UI Select v3 — 自绘可搜索下拉（账本 index.html 与魔方 cube.html 共用）
   ------------------------------------------------------------
   原生 <select> 的弹出层归操作系统画、样式改不了；这里保留原生元素
   负责「值」与表单提交，上面盖一层自绘 trigger + 面板。

   v3 相对 v2：
   1. 省市表补全 —— 34 个省级区划 × 全部地级行政区（含地区 / 盟 / 自治州），
      黑龙江省 13 个（12 地级市 + 大兴安岭地区）一个不少；反查表由同源数据
      自动派生，城市不可能挂到别的省。
   2. 颜色跟着值走 —— 原生 select 上那层内联底色（分类色）以前只画在看不见的
      原生元素上，现在 sync 时抄到 trigger，颜色回来了。
   3. hydrate() —— 弹窗里新建的省市字段按记录现场对齐一次，任何历史脏数据
      都不会显示成「山东省 · 郑州」。
   ============================================================ */
(function () {
  'use strict';

  /* ---------------- 省市全表 ----------------
     键是「xx省 / xx市 / xx自治区 / xx特别行政区」，与 COMP_PROVINCES 完全一致；
     值里的城市统一不带后缀（哈尔滨、大兴安岭），和账本 / 魔方已有数据同一口径。 */
  var PROVINCE_CITY_MAP = {
    '北京市': ['北京'],
    '天津市': ['天津'],
    '上海市': ['上海'],
    '重庆市': ['重庆'],

    '河北省': ['石家庄', '唐山', '秦皇岛', '邯郸', '邢台', '保定', '张家口', '承德', '沧州', '廊坊', '衡水'],
    '山西省': ['太原', '大同', '阳泉', '长治', '晋城', '朔州', '晋中', '运城', '忻州', '临汾', '吕梁'],
    '内蒙古自治区': ['呼和浩特', '包头', '乌海', '赤峰', '通辽', '鄂尔多斯', '呼伦贝尔', '巴彦淖尔', '乌兰察布', '兴安盟', '锡林郭勒盟', '阿拉善盟'],
    '辽宁省': ['沈阳', '大连', '鞍山', '抚顺', '本溪', '丹东', '锦州', '营口', '阜新', '辽阳', '盘锦', '铁岭', '朝阳', '葫芦岛'],
    '吉林省': ['长春', '吉林', '四平', '辽源', '通化', '白山', '松原', '白城', '延边'],
    '黑龙江省': ['哈尔滨', '齐齐哈尔', '鸡西', '鹤岗', '双鸭山', '大庆', '伊春', '佳木斯', '七台河', '牡丹江', '黑河', '绥化', '大兴安岭'],

    '江苏省': ['南京', '无锡', '徐州', '常州', '苏州', '南通', '连云港', '淮安', '盐城', '扬州', '镇江', '泰州', '宿迁'],
    '浙江省': ['杭州', '宁波', '温州', '嘉兴', '湖州', '绍兴', '金华', '衢州', '舟山', '台州', '丽水'],
    '安徽省': ['合肥', '芜湖', '蚌埠', '淮南', '马鞍山', '淮北', '铜陵', '安庆', '黄山', '滁州', '阜阳', '宿州', '六安', '亳州', '池州', '宣城'],
    '福建省': ['福州', '厦门', '莆田', '三明', '泉州', '漳州', '南平', '龙岩', '宁德'],
    '江西省': ['南昌', '景德镇', '萍乡', '九江', '新余', '鹰潭', '赣州', '吉安', '宜春', '抚州', '上饶'],
    '山东省': ['济南', '青岛', '淄博', '枣庄', '东营', '烟台', '潍坊', '济宁', '泰安', '威海', '日照', '临沂', '德州', '聊城', '滨州', '菏泽', '莱芜'],

    '河南省': ['郑州', '开封', '洛阳', '平顶山', '安阳', '鹤壁', '新乡', '焦作', '濮阳', '许昌', '漯河', '三门峡', '南阳', '商丘', '信阳', '周口', '驻马店', '济源'],
    '湖北省': ['武汉', '黄石', '十堰', '宜昌', '襄阳', '鄂州', '荆门', '孝感', '荆州', '黄冈', '咸宁', '随州', '恩施', '仙桃', '潜江', '天门', '神农架'],
    '湖南省': ['长沙', '株洲', '湘潭', '衡阳', '邵阳', '岳阳', '常德', '张家界', '益阳', '郴州', '永州', '怀化', '娄底', '湘西'],
    '广东省': ['广州', '深圳', '珠海', '汕头', '佛山', '韶关', '湛江', '肇庆', '江门', '茂名', '惠州', '梅州', '汕尾', '河源', '阳江', '清远', '东莞', '中山', '潮州', '揭阳', '云浮'],
    '广西壮族自治区': ['南宁', '柳州', '桂林', '梧州', '北海', '防城港', '钦州', '贵港', '玉林', '百色', '贺州', '河池', '来宾', '崇左'],
    '海南省': ['海口', '三亚', '三沙', '儋州', '琼海', '文昌', '万宁', '东方', '五指山'],

    '四川省': ['成都', '自贡', '攀枝花', '泸州', '德阳', '绵阳', '广元', '遂宁', '内江', '乐山', '南充', '眉山', '宜宾', '广安', '达州', '雅安', '巴中', '资阳', '阿坝', '甘孜', '凉山'],
    '贵州省': ['贵阳', '六盘水', '遵义', '安顺', '毕节', '铜仁', '黔西南', '黔东南', '黔南'],
    '云南省': ['昆明', '曲靖', '玉溪', '保山', '昭通', '丽江', '普洱', '临沧', '楚雄', '红河', '文山', '西双版纳', '大理', '德宏', '怒江', '迪庆'],
    '西藏自治区': ['拉萨', '日喀则', '昌都', '林芝', '山南', '那曲', '阿里'],
    '陕西省': ['西安', '铜川', '宝鸡', '咸阳', '渭南', '延安', '汉中', '榆林', '安康', '商洛'],
    '甘肃省': ['兰州', '嘉峪关', '金昌', '白银', '天水', '武威', '张掖', '平凉', '酒泉', '庆阳', '定西', '陇南', '临夏', '甘南'],
    '青海省': ['西宁', '海东', '海北', '黄南', '海南州', '果洛', '玉树', '海西'],
    '宁夏回族自治区': ['银川', '石嘴山', '吴忠', '固原', '中卫'],
    '新疆维吾尔自治区': ['乌鲁木齐', '克拉玛依', '吐鲁番', '哈密', '昌吉', '博尔塔拉', '巴音郭楞', '阿克苏', '克孜勒苏', '喀什', '和田', '伊犁', '塔城', '阿勒泰', '石河子'],
    '香港特别行政区': ['香港'],
    '澳门特别行政区': ['澳门'],
    '台湾省': ['台北', '新北', '桃园', '台中', '台南', '高雄', '基隆', '新竹', '嘉义', '花莲', '台东', '澎湖']
  };

  /* 反查表：城市 -> 省份。由上面那张表派生，手工维护的第二份数据才是错配的根源。 */
  var CITY_PROVINCE_MAP = (function () {
    var m = {};
    Object.keys(PROVINCE_CITY_MAP).forEach(function (p) {
      PROVINCE_CITY_MAP[p].forEach(function (c) { if (!m[c]) m[c] = p; });
    });
    return m;
  })();
  var ALL_CITIES = Object.keys(CITY_PROVINCE_MAP);

  var openSel = null, openPanel = null, openTrigger = null,
      openInput = null, openList = null, openItems = [], activeIdx = -1,
      uidSeq = 0;

  /* ---------------- 搜索是「申请制」，默认不给 ----------------
     以前 trigger 里那枚 input 一开就变可编辑：点开任意一个下拉，
     键盘焦点落进搜索框，输一个字就整表过滤。分类、子类、年份、页码
     这些三五项的短列表根本不需要——手指点一下就选完了，多一个可用
     输入态只带来两个毛病：面板里打字会把「当前值」顶掉，
     点第二下时又因为焦点在输入框里、闭不上。
     现在只有显式写了 data-ui-search 的元素才开搜索（比赛的省 / 市），
     其余全部退化成「点一下开、再点一下收」的纯按钮行为。 */
  function isSearch(sel) {
    return !!(sel && sel.hasAttribute && sel.hasAttribute('data-ui-search'));
  }
  /* 首字母跳转：不给搜索框，也不让键盘白按 —— 按 s 跳到第一条 s 开头的 */
  function jumpToLetter(ch) {
    if (!openItems.length) return;
    ch = String(ch || '').toLowerCase();
    for (var i = 0; i < openItems.length; i++) {
      var t = String(openItems[i].el.textContent || '').toLowerCase();
      if (t.indexOf(ch) === 0) { setActive(i); return; }
    }
    for (var j = 0; j < openItems.length; j++) {
      var u = String(openItems[j].el.textContent || '').toLowerCase();
      if (u.indexOf(ch) >= 0) { setActive(j); return; }
    }
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function labelText(sel) {
    var o = sel.options[sel.selectedIndex];
    return o ? o.textContent : (sel.getAttribute('data-placeholder') || '请选择');
  }
  function triggerOf(sel) {
    var t = sel.nextElementSibling;
    return (t && t.classList && t.classList.contains('ui-sel-trigger')) ? t : null;
  }

  /* ---------------- 装饰：select 后面插一个 trigger ---------------- */
  function decorate(sel) {
    if (!sel || sel.dataset.uiDecorated === '1') return;
    /* v1.0.39：藏起来的 select 不装饰。
       第二行的类型 / 项目格把原来的下拉留作「值容器」，用 hidden 收起来；
       以前这里照样给它插 trigger —— 那枚 trigger 不受 hidden 约束，
       于是在筛选栏底下又长出一条空白的「全部项目」。 */
    if (sel.hidden || sel.getAttribute('aria-hidden') === 'true') {
      sel.dataset.uiDecorated = '1';
      sel.dataset.uiHiddenSkip = '1';
      return;
    }
    sel.dataset.uiDecorated = '1';
    sel.classList.add('ui-native-select');
    if (!sel.id) sel.id = 'uiSel' + (++uidSeq);
    var t = document.createElement('div');
    var search = sel.hasAttribute('data-ui-search');
    t.className = 'ui-sel-trigger' + (search ? ' is-search' : '');
    t.dataset.search = search ? '1' : '0';
    t.tabIndex = 0;
    t.setAttribute('role', 'combobox');
    t.setAttribute('aria-haspopup', 'listbox');
    t.setAttribute('aria-expanded', 'false');
    t.innerHTML =
      '<input class="ui-sel-input" type="text" readonly' + (search ? '' : ' tabindex="-1"') +
      ' autocomplete="off" spellcheck="false" aria-autocomplete="list">' +
      '<svg class="ui-sel-caret" viewBox="0 0 20 20" aria-hidden="true">' +
      '<path d="M5 7.5l5 5 5-5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    sel.parentNode.insertBefore(t, sel.nextSibling);
    bindTrigger(sel, t);
    sync(sel);
  }

  /* ---------------- 同步：原生值 -> trigger 文本 + 颜色 ---------------- */
  function sync(sel) {
    var t = triggerOf(sel);
    if (!t) return;
    var inp = t.querySelector('.ui-sel-input');
    if (!inp) return;
    t.classList.toggle('is-disabled', !!sel.disabled);
    t.setAttribute('aria-disabled', sel.disabled ? 'true' : 'false');
    t.tabIndex = sel.disabled ? -1 : 0;
    inp.disabled = !!sel.disabled;

    /* 分类色是 paintSelect() 写在原生 select 上的内联样式。原生元素现在
       是 1px 的隐身件，颜色只有抄到 trigger 上才看得见。 */
    var bg = sel.style.backgroundColor || '';
    t.classList.toggle('has-tint', !!bg);
    if (bg) {
      t.style.backgroundColor = bg;
      t.style.color = sel.style.color || '';
      t.style.borderColor = sel.style.borderColor || '';
    } else {
      t.style.backgroundColor = '';
      t.style.color = '';
      t.style.borderColor = '';
    }

    /* 面板开着且正是这一枚，用户正在输入：别把查询词覆盖掉 */
    if (openSel === sel && openPanel) return;
    var lab = labelText(sel);
    if (inp.value !== lab) inp.value = lab;
    inp.placeholder = '';
    t.classList.toggle('is-placeholder', !sel.value);
  }
  function syncAll() {
    document.querySelectorAll('select.ui-native-select').forEach(sync);
  }

  /* ---------------- 面板 ---------------- */
  function close() {
    var trig = openTrigger, sel = openSel;
    if (openPanel) { openPanel.remove(); openPanel = null; }
    if (trig) {
      trig.classList.remove('is-open');
      trig.setAttribute('aria-expanded', 'false');
      trig.removeAttribute('aria-activedescendant');
      var inp = trig.querySelector('.ui-sel-input');
      if (inp) {
        inp.readOnly = true;
        inp.placeholder = '';
        /* 关掉就把查询词丢掉，显示回当前值——不然半截关键词会留在框里 */
        if (sel) inp.value = labelText(sel);
      }
      if (sel) trig.classList.toggle('is-placeholder', !sel.value);
    }
    openSel = null; openTrigger = null; openInput = null;
    openList = null; openItems = []; activeIdx = -1;
  }

  function place() {
    if (!openPanel || !openTrigger) return;
    var r = openTrigger.getBoundingClientRect();
    var panel = openPanel;
    panel.style.minWidth = Math.max(r.width, 160) + 'px';
    panel.style.visibility = 'hidden';
    var pw = panel.offsetWidth, ph = panel.offsetHeight;
    var left = r.left, top = r.bottom + 6;
    if (left + pw > window.innerWidth - 10) left = Math.max(10, window.innerWidth - pw - 10);
    if (top + ph > window.innerHeight - 10) top = Math.max(10, r.top - ph - 6);
    panel.style.left = Math.round(left) + 'px';
    panel.style.top = Math.round(top) + 'px';
    panel.style.visibility = '';
  }

  function setActive(i, scroll) {
    if (!openItems.length) { activeIdx = -1; return; }
    if (i < 0) i = 0;
    if (i > openItems.length - 1) i = openItems.length - 1;
    for (var k = 0; k < openItems.length; k++) {
      openItems[k].el.classList.toggle('is-active', k === i);
    }
    activeIdx = i;
    var el = openItems[i].el;
    if (openTrigger) openTrigger.setAttribute('aria-activedescendant', el.id);
    if (scroll !== false && openList) {
      var top = el.offsetTop, bottom = top + el.offsetHeight;
      if (top < openList.scrollTop) openList.scrollTop = Math.max(0, top - 2);
      else if (bottom > openList.scrollTop + openList.clientHeight) {
        openList.scrollTop = bottom - openList.clientHeight + 2;
      }
    }
  }

  function paint(q) {
    if (!openList || !openSel) return;
    q = String(q == null ? '' : q).trim().toLowerCase();
    openList.innerHTML = '';
    openItems = [];
    activeIdx = -1;
    var all = [].slice.call(openSel.options);
    var arr = q ? all.filter(function (o) {
      return String(o.textContent || '').toLowerCase().indexOf(q) >= 0;
    }) : all;
    if (!arr.length) {
      var empty = document.createElement('div');
      empty.className = 'ui-sel-empty';
      empty.textContent = '没有匹配项';
      openList.appendChild(empty);
      if (openTrigger) openTrigger.removeAttribute('aria-activedescendant');
      return;
    }
    arr.forEach(function (o, i) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'ui-sel-option';
      b.id = openPanel.id + '-o' + i;
      b.setAttribute('role', 'option');
      b.setAttribute('aria-selected', o.selected ? 'true' : 'false');
      if (o.selected) b.classList.add('is-selected');
      b.textContent = o.textContent;
      b.addEventListener('mousedown', function (e) { e.preventDefault(); });
      b.addEventListener('mousemove', function () { setActive(i, false); });
      b.addEventListener('click', function (e) { e.preventDefault(); commit(i); });
      openList.appendChild(b);
      openItems.push({ el: b, o: o });
    });
    /* 打开时高亮当前值，没有当前值就落在第一条 */
    var sel = -1;
    for (var j = 0; j < openItems.length; j++) if (openItems[j].o.selected) { sel = j; break; }
    if (q) sel = 0;
    if (sel >= 0) setActive(sel);
  }

  function commit(i) {
    var it = openItems[i];
    if (!it || !openSel) return;
    var sel = openSel, trig = openTrigger;
    if (sel.value !== it.o.value) {
      sel.value = it.o.value;
      sel.dispatchEvent(new Event('input', { bubbles: true }));
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }
    sync(sel);
    close();
    try { if (trig) trig.focus(); } catch (e) {}
  }

  function open(sel, trigger) {
    if (!sel || !trigger || sel.disabled) return;
    close();
    openSel = sel; openTrigger = trigger;
    openInput = trigger.querySelector('.ui-sel-input');
    trigger.classList.add('is-open');
    trigger.setAttribute('aria-expanded', 'true');
    if (!sel.id) sel.id = 'uiSel' + (++uidSeq);
    var panel = document.createElement('div');
    panel.className = 'ui-sel-panel';
    panel.id = sel.id + '-panel';
    panel.setAttribute('role', 'listbox');
    var list = document.createElement('div');
    list.className = 'ui-sel-options';
    panel.appendChild(list);
    document.body.appendChild(panel);
    openPanel = panel; openList = list;
    trigger.setAttribute('aria-controls', panel.id);
    var searchable = isSearch(sel);
    if (openInput) {
      if (searchable) {
        openInput.readOnly = false;
        openInput.value = '';
        openInput.placeholder = labelText(sel);
      } else {
        /* 不可搜索：那枚 input 只是一行字，永远只读、不抢焦点 */
        openInput.readOnly = true;
        openInput.value = labelText(sel);
        openInput.placeholder = '';
      }
    }
    paint('');
    place();
    /* 弹窗本身还在播 260ms 的入场动画，trigger 的位置会继续移动；
       开面板那一刻量的坐标会偏，所以下一帧和动画结束后各再对一次。 */
    if (window.requestAnimationFrame) requestAnimationFrame(place);
    setTimeout(place, 200);
    if (searchable && openInput) setTimeout(function () { try { openInput.focus(); } catch (e) {} }, 0);
  }

  /* ---------------- 键盘 ---------------- */
  function bindTrigger(sel, t) {
    var inp = t.querySelector('.ui-sel-input');
    /* 打字即过滤只给 data-ui-search 的下拉：点开之后 trigger 就是搜索框，
       没有第二个搜索框。其余下拉的输入框全程只读，这些监听干脆不挂。 */
    if (inp && isSearch(sel)) {
      inp.addEventListener('input', function () {
        if (openTrigger !== t || !openPanel) return;
        paint(inp.value);
        if (openItems.length) setActive(0, false);
      });
      inp.addEventListener('blur', function () {
        setTimeout(function () {
          if (!openPanel || openTrigger !== t) return;
          var a = document.activeElement;
          if (a && (openPanel.contains(a) || t.contains(a))) return;
          close();
        }, 0);
      });
    }
    t.addEventListener('keydown', function (e) {
      if (openTrigger === t && openPanel) {
        var k = e.key;
        if (k === 'ArrowDown') { e.preventDefault(); setActive(activeIdx + 1); return; }
        if (k === 'ArrowUp') { e.preventDefault(); setActive(activeIdx < 0 ? openItems.length - 1 : activeIdx - 1); return; }
        if (k === 'PageDown') { e.preventDefault(); setActive(activeIdx < 0 ? 5 : activeIdx + 6); return; }
        if (k === 'PageUp') { e.preventDefault(); setActive(activeIdx < 0 ? 0 : activeIdx - 6); return; }
        if (k === 'Home') { e.preventDefault(); setActive(0); return; }
        if (k === 'End') { e.preventDefault(); setActive(openItems.length - 1); return; }
        if (k === 'Enter') {
          e.preventDefault();
          if (activeIdx >= 0) commit(activeIdx);
          else if (openItems.length === 1) commit(0);
          else close();
          return;
        }
        if (k === 'Tab') { close(); return; }
        if (!isSearch(sel) && k && k.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          e.preventDefault();
          jumpToLetter(k);
          return;
        }
        return; /* 其余按键交给输入框：打字即过滤 */
      }
      if (e.target !== t && e.target !== t.querySelector('.ui-sel-input')) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' ||
          e.key === ' ' || e.key === 'Spacebar') {
        e.preventDefault();
        open(sel, t);
        return;
      }
      if (e.key && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        var ch = e.key;
        open(sel, t);
        setTimeout(function () {
          if (isSearch(sel)) {
            if (openInput) { openInput.value = ch; paint(ch); setActive(0); }
          } else {
            jumpToLetter(ch);
          }
        }, 0);
      }
    });
  }

  /* ---------------- 联动：省 -> 市；市 -> 省 ---------------- */
  function citiesOf(prov) {
    if (!prov) return ALL_CITIES.slice();
    return (PROVINCE_CITY_MAP[prov] || []).slice();
  }
  function provinceOf(city) {
    return CITY_PROVINCE_MAP[String(city || '').trim()] || '';
  }
  function fillCity(city, prov, keep) {
    var list = citiesOf(prov);
    city.innerHTML = '<option value="">请选择城市</option>' +
      list.map(function (c) { return '<option value="' + esc(c) + '">' + esc(c) + '</option>'; }).join('');
    city.dataset.cascadeFor = prov || '*';
    city.value = (keep && list.indexOf(keep) >= 0) ? keep : '';
    city.disabled = false;
    sync(city);
    return list;
  }
  function refreshCities(root, prov, keep) {
    var city = root.querySelector('select[data-ui-cascade="city"]');
    if (!city) return null;
    fillCity(city, prov, keep);
    return city;
  }
  function cascadeChanged(sel, forceProv) {
    var kind = sel.getAttribute('data-ui-cascade');
    if (!kind) return;
    var root = sel.closest('form') || (sel.closest('.field') && sel.closest('.field').parentElement) || document;
    if (kind === 'province') {
      var form = sel.closest('form');
      var keepCity = form ? ((form.querySelector('select[data-ui-cascade="city"]') || {}).value || '') : '';
      refreshCities(root, forceProv !== undefined ? forceProv : sel.value, keepCity);
    } else if (kind === 'city') {
      var city = sel.value;
      var prov = provinceOf(city);
      var ps = root.querySelector('select[data-ui-cascade="province"]');
      if (!ps) return;
      if (!city) return;
      if (!prov) { sel.value = ''; sync(sel); return; }
      if (ps.value !== prov) {
        refreshCities(root, prov, city);   /* 先把城市列表收窄到该省并保住已选城市 */
        ps.value = prov;                   /* 再回填省份 */
        sync(ps);
      }
    }
  }

  /* ---------------- hydrate：把一对省市字段对齐 ----------------
     记录里的省份和城市是两次写入的，历史数据里出现过「山东省 · 郑州」。
     这里按「城市更具体」判断：城市能反查到省就以城市为准，查不到就清空城市，
     顺便把城市下拉收窄到该省。每次弹窗打开都会跑一遍，脏数据不可能被显示出来。 */
  function hydrateOne(prov) {
    if (!prov) return;
    var box = prov.closest('form') ||
      (prov.closest('.field') && prov.closest('.field').parentElement) || document;
    var city = box.querySelector ? box.querySelector('select[data-ui-cascade="city"]') : null;
    if (!city) return;

    var p = prov.value || '';
    var c = city.value || '';

    if (!p && c) {
      var owner = provinceOf(c);
      if (owner) { p = owner; prov.value = owner; sync(prov); }
    }
    if (p && c && (PROVINCE_CITY_MAP[p] || []).indexOf(c) < 0) {
      var own = provinceOf(c);
      if (own && own !== p) { p = own; prov.value = own; sync(prov); }
      else c = '';
    }
    var list = citiesOf(p);
    if (city.dataset.cascadeFor !== (p || '*') || city.options.length !== list.length + 1) {
      fillCity(city, p, c);
    } else if (c && city.value !== c) {
      city.value = c;
      sync(city);
    } else if (!c && city.value) {
      city.value = '';
      sync(city);
    }
  }
  function hydrate(root) {
    root = root || document;
    if (!root.querySelectorAll) return;
    root.querySelectorAll('select[data-ui-cascade="province"]').forEach(hydrateOne);
  }
  function hydrateAll(root) { hydrate(root || document); }

  /* ---------------- 全局事件 ---------------- */
  var inited = false;
  function init() {
    document.querySelectorAll('select').forEach(decorate);
    if (inited) return;
    inited = true;

    document.addEventListener('click', function (e) {
      var t = e.target && e.target.closest ? e.target.closest('.ui-sel-trigger') : null;
      if (t) {
        var sel = t.previousElementSibling;
        if (!sel || sel.tagName !== 'SELECT' || sel.disabled) return;
        /* 面板已经开着：再点一下就是「收回」。
           可搜索的下拉要分两个落点——点箭头收，点输入框只挪光标；
           其余下拉没有输入态，点哪儿都收。 */
        if (openTrigger === t) {
          if (isSearch(sel)) {
            if (e.target && e.target.closest && e.target.closest('.ui-sel-caret')) {
              e.preventDefault(); e.stopPropagation(); close(); return;
            }
            if (e.target && e.target.classList && e.target.classList.contains('ui-sel-input')) {
              e.preventDefault(); e.stopPropagation();
              return;
            }
          }
          e.preventDefault(); e.stopPropagation(); close(); return;
        }
        e.preventDefault(); e.stopPropagation();
        open(sel, t);
        return;
      }
      if (openPanel && !(e.target.closest && e.target.closest('.ui-sel-panel'))) close();
    }, true);

    /* Esc 只收下拉，不要顺手把弹窗关了 */
    document.addEventListener('keydown', function (e) {
      if (!openPanel) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        try { e.stopImmediatePropagation(); } catch (err) {}
        close();
      }
    }, true);

    document.addEventListener('change', function (e) {
      if (e.target && e.target.tagName === 'SELECT') { cascadeChanged(e.target); sync(e.target); }
    }, true);
    document.addEventListener('input', function (e) {
      if (e.target && e.target.tagName === 'SELECT') sync(e.target);
    }, true);
    document.addEventListener('scroll', function () { if (openPanel) place(); }, true);
    window.addEventListener('resize', function () { if (openPanel) place(); else close(); });

    var mo = new MutationObserver(function () {
      mo.disconnect();
      try {
        document.querySelectorAll('select:not([data-ui-decorated="1"])').forEach(decorate);
        syncAll();
        hydrateAll();
      } catch (e) {}
      finally { setTimeout(function () { mo.observe(document.documentElement, { childList: true, subtree: true }); }, 0); }
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });

    /* 联动初值：编辑已有记录时按省份刷一次市列表 */
    hydrateAll();
  }

  window.UISelect = {
    init: init,
    syncAll: syncAll,
    close: close,
    hydrate: hydrate,
    hydrateAll: hydrateAll,
    cities: citiesOf,
    provinces: function () { return Object.keys(PROVINCE_CITY_MAP); },
    provinceOf: provinceOf,
    cityMap: function () { return PROVINCE_CITY_MAP; },
    refresh: function () {
      document.querySelectorAll('select').forEach(decorate);
      hydrateAll();
      syncAll();
    }
  };
})();
