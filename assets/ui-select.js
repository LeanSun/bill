/* ============================================================
   UI Select v2 — 自绘可搜索下拉（账本 index.html 与魔方 cube.html 共用）
   ------------------------------------------------------------
   原生 <select> 的弹出层归操作系统画、样式改不了；这里保留原生元素
   负责「值」与表单提交，上面盖一层自绘 trigger + 面板。

   v2 相对 v1 的三处改动：
   1. 搜索不再占用面板里的独立输入框 —— trigger 自己就是一个输入框，
      点它即开面板，直接敲字就过滤；关闭时它退回只读，显示当前选项。
   2. 键盘导航：↑ ↓ 移动、PgUp/PgDn 翻页、Enter 选中、Esc 收起、
      Tab 收起、闭合状态下直接敲字母即开面板并筛选。
   3. 面板选项不再被 flex 压扁（v1 在 35 个省份时把 35px 行压成 16px，
      文字叠在一起）。
   ============================================================ */
(function () {
  'use strict';

  var PROVINCE_CITY_MAP = {
    '北京市': ['北京'], '上海市': ['上海'], '天津市': ['天津'], '重庆市': ['重庆'],
    '广东省': ['广州', '深圳'], '浙江省': ['杭州', '宁波'], '江苏省': ['南京', '苏州'],
    '四川省': ['成都'], '湖北省': ['武汉'], '陕西省': ['西安'], '山东省': ['济南', '青岛'],
    '安徽省': ['合肥'], '贵州省': ['贵阳'], '云南省': ['昆明'], '湖南省': ['长沙'],
    '河南省': ['郑州'], '福建省': ['福州', '厦门'], '辽宁省': ['沈阳', '大连'],
    '江西省': ['南昌'], '广西壮族自治区': ['南宁'], '海南省': ['海口'], '甘肃省': ['兰州'],
    '宁夏回族自治区': ['银川'], '新疆维吾尔自治区': ['乌鲁木齐'], '西藏自治区': ['拉萨'],
    '内蒙古自治区': ['呼和浩特'], '香港特别行政区': ['香港'], '澳门特别行政区': ['澳门'],
    '台湾省': ['台北'], '吉林省': ['长春'], '黑龙江省': ['哈尔滨'],
    '河北省': ['石家庄'], '山西省': ['太原']
  };
  var CITY_PROVINCE_MAP = (function () {
    var m = {};
    Object.keys(PROVINCE_CITY_MAP).forEach(function (p) {
      PROVINCE_CITY_MAP[p].forEach(function (c) { m[c] = p; });
    });
    return m;
  })();

  var openSel = null, openPanel = null, openTrigger = null,
      openInput = null, openList = null, openItems = [], activeIdx = -1,
      uidSeq = 0;

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
    sel.dataset.uiDecorated = '1';
    sel.classList.add('ui-native-select');
    if (!sel.id) sel.id = 'uiSel' + (++uidSeq);
    var t = document.createElement('div');
    t.className = 'ui-sel-trigger';
    t.tabIndex = 0;
    t.setAttribute('role', 'combobox');
    t.setAttribute('aria-haspopup', 'listbox');
    t.setAttribute('aria-expanded', 'false');
    t.innerHTML =
      '<input class="ui-sel-input" type="text" readonly autocomplete="off" spellcheck="false" aria-autocomplete="list">' +
      '<svg class="ui-sel-caret" viewBox="0 0 20 20" aria-hidden="true">' +
      '<path d="M5 7.5l5 5 5-5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    sel.parentNode.insertBefore(t, sel.nextSibling);
    bindTrigger(sel, t);
    sync(sel);
  }

  /* ---------------- 同步：原生值 -> trigger 文本 ---------------- */
  function sync(sel) {
    var t = triggerOf(sel);
    if (!t) return;
    var inp = t.querySelector('.ui-sel-input');
    if (!inp) return;
    t.classList.toggle('is-disabled', !!sel.disabled);
    t.setAttribute('aria-disabled', sel.disabled ? 'true' : 'false');
    t.tabIndex = sel.disabled ? -1 : 0;
    inp.disabled = !!sel.disabled;
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
    if (openInput) {
      openInput.readOnly = false;
      openInput.value = '';
      openInput.placeholder = labelText(sel);
    }
    paint('');
    place();
    /* 弹窗本身还在播 260ms 的入场动画，trigger 的位置会继续移动；
       开面板那一刻量的坐标会偏，所以下一帧和动画结束后各再对一次。 */
    if (window.requestAnimationFrame) requestAnimationFrame(place);
    setTimeout(place, 200);
    if (openInput) setTimeout(function () { try { openInput.focus(); } catch (e) {} }, 0);
  }

  /* ---------------- 键盘 ---------------- */
  function bindTrigger(sel, t) {
    var inp = t.querySelector('.ui-sel-input');
    /* 打字即过滤：点开之后 trigger 就是一个输入框，没有第二个搜索框 */
    if (inp) {
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
        if (k === 'Enter') {
          e.preventDefault();
          if (activeIdx >= 0) commit(activeIdx);
          else if (openItems.length === 1) commit(0);
          else close();
          return;
        }
        if (k === 'Tab') { close(); return; }
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
          if (openInput) { openInput.value = ch; paint(ch); setActive(0); }
        }, 0);
      }
    });
  }

  /* ---------------- 联动：省 -> 市；市 -> 省 ---------------- */
  function refreshCities(root, prov, keep) {
    var city = root.querySelector('select[data-ui-cascade="city"]');
    if (!city) return null;
    var cities = prov ? (PROVINCE_CITY_MAP[prov] || []) : Object.keys(CITY_PROVINCE_MAP);
    city.innerHTML = '<option value="">请选择城市</option>' +
      cities.map(function (c) { return '<option value="' + esc(c) + '">' + esc(c) + '</option>'; }).join('');
    if (keep && cities.indexOf(keep) >= 0) city.value = keep; else city.value = '';
    city.disabled = false;
    sync(city);
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
      var prov = CITY_PROVINCE_MAP[city];
      var ps = root.querySelector('select[data-ui-cascade="province"]');
      if (!ps || !prov) return;
      if (ps.value !== prov) {
        refreshCities(root, prov, city);   /* 先把城市列表收窄到该省并保住已选城市 */
        ps.value = prov;                   /* 再回填省份 */
        sync(ps);
      }
    }
  }

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
        /* 面板已经开着：点箭头收起；点输入框只挪光标，别收 */
        if (openTrigger === t) {
          if (e.target && e.target.closest && e.target.closest('.ui-sel-caret')) {
            e.preventDefault(); e.stopPropagation(); close(); return;
          }
          if (e.target && e.target.classList && e.target.classList.contains('ui-sel-input')) {
            e.preventDefault(); e.stopPropagation();
            return;
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
      } catch (e) {}
      finally { setTimeout(function () { mo.observe(document.documentElement, { childList: true, subtree: true }); }, 0); }
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });

    /* 联动初值：编辑已有记录时按省份刷一次市列表 */
    document.querySelectorAll('select[data-ui-cascade="province"]').forEach(function (s) {
      if (s.value) cascadeChanged(s);
    });
  }

  window.UISelect = {
    init: init,
    syncAll: syncAll,
    close: close,
    refresh: function () {
      document.querySelectorAll('select').forEach(decorate);
      syncAll();
    }
  };
})();
