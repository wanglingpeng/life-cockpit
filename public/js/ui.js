/* ===== v54 设计系统 · DOM 组件工厂（js/ui.js） =====
 * 依据 docs/revamp-2026-10-11/02-设计系统组件化.md §2.2，配套 public/css/components.css。
 * 约定：
 *  - 全部返回 DOM 节点；用户数据只走 textContent，绝不 innerHTML 拼接（防 XSS 与现状一致）
 *  - 唯一的 innerHTML 出口是显式命名的 html 参数，仅供页内可信常量（如内置 SVG 图标）
 *  - 按钮类组件内置 ≥44px 触控高度，焦点环由 theme/ 全局 :focus-visible 提供
 *  - 确认框不在此重复造：uiConfirm 委托 common.js 的 confirmModal（Promise + 焦点圈 + Esc）
 * 依赖：common.js 需先于本文件加载（uiConfirm 用到 confirmModal）。
 */
(function (global) {
    'use strict';

    function el(tag, cls) {
        const n = document.createElement(tag);
        if (cls) n.className = cls;
        return n;
    }

    /* 把内容装进容器：Node | Node[] | 可信 html 字符串（仅限页内常量，禁止接用户数据） */
    function fillContent(host, body) {
        if (body == null) return;
        if (typeof body === 'string') { host.innerHTML = body; return; } /* 可信内部标记 */
        if (Array.isArray(body)) body.forEach(n => { if (n instanceof Node) host.appendChild(n); });
        else if (body instanceof Node) host.appendChild(body);
    }

    /* ---------- 弹窗 uiModal ----------
     * uiModal({ title, body, actions:[{label, kind:'primary'|'danger'|'ghost', onClick({close}), autofocus}],
     *           size:'sm'|'lg', esc:true, dismissable:true, onClose })
     * 立即打开；返回 { root, card, close }。
     */
    function uiModal(opts) {
        opts = opts || {};
        const lastFocus = document.activeElement;
        const mask = el('div', 'c-modal-mask');
        const card = el('div', 'c-modal-card' + (opts.size === 'sm' ? ' c-modal-sm' : opts.size === 'lg' ? ' c-modal-lg' : ''));
        card.setAttribute('role', 'dialog');
        card.setAttribute('aria-modal', 'true');
        const titleId = 'c-modal-title-' + Date.now() + '-' + Math.floor(Math.random() * 1e6);
        card.setAttribute('aria-labelledby', titleId);

        const head = el('div', 'c-modal-head');
        const h = el('h3', 'c-modal-title');
        h.id = titleId;
        h.textContent = opts.title || '';
        const x = el('button', 'c-modal-x');
        x.type = 'button';
        x.setAttribute('aria-label', '关闭');
        x.textContent = '×';
        head.appendChild(h); head.appendChild(x);
        card.appendChild(head);

        const body = el('div', 'c-modal-body');
        fillContent(body, opts.body);
        card.appendChild(body);

        let autofocusBtn = null;
        const actions = opts.actions || [];
        if (actions.length) {
            const foot = el('div', 'c-modal-foot');
            for (const a of actions) {
                const b = el('button', 'c-btn' + (a.kind && a.kind !== 'ghost' ? ' c-btn-' + a.kind : ''));
                b.type = 'button';
                b.textContent = a.label || '确定';
                b.addEventListener('click', () => { if (a.onClick) a.onClick({ close }); else close(); });
                if (a.autofocus) autofocusBtn = b;
                foot.appendChild(b);
            }
            card.appendChild(foot);
        }
        mask.appendChild(card);

        let settled = false;
        function close() {
            if (settled) return;
            settled = true;
            document.removeEventListener('keydown', onKey, true);
            mask.remove();
            if (lastFocus && typeof lastFocus.focus === 'function' && document.contains(lastFocus)) {
                try { lastFocus.focus(); } catch (e) { /* 焦点还原失败不阻塞 */ }
            }
            if (typeof opts.onClose === 'function') opts.onClose();
        }
        function onKey(e) {
            if (e.key === 'Escape' && opts.esc !== false) { e.preventDefault(); e.stopPropagation(); close(); return; }
            if (e.key === 'Tab') { /* 焦点圈在弹窗内 */
                const f = [...card.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
                    .filter(n => !n.disabled && n.offsetParent !== null);
                if (!f.length) { e.preventDefault(); return; }
                const first = f[0], last = f[f.length - 1];
                if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
                else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
            }
        }
        x.addEventListener('click', close);
        mask.addEventListener('mousedown', e => { if (e.target === mask && opts.dismissable !== false) close(); });
        document.addEventListener('keydown', onKey, true);

        document.body.appendChild(mask);
        const target = autofocusBtn || card.querySelector('.c-btn') || x;
        setTimeout(() => { try { target.focus(); } catch (e) { /* 初始聚焦失败不阻塞 */ } }, 40);
        return { root: mask, card, close };
    }

    /* ---------- 确认框 uiConfirm：委托 common.js confirmModal（不重复实现） ---------- */
    function uiConfirm(msg, opts) {
        if (typeof confirmModal !== 'function') throw new Error('uiConfirm 依赖 common.js 的 confirmModal，请先加载 common.js');
        const o = typeof msg === 'string' ? Object.assign({}, opts || {}, { message: msg }) : Object.assign({}, msg, opts);
        return confirmModal(o);
    }

    /* ---------- 空态 uiEmpty ----------
     * uiEmpty({ icon, title, text | html(可信), action:{ href, text, onClick, kind }, size }) → 节点
     *   size 省略     行内空态：图标 + 一句话 + 文字链，用于列表某行 / 字段下方
     *   size:'block'  块级空态：图标圆底 + 标题 + 描述 + 按钮，用于卡片正文整块为空
     *   action.kind   仅 block 生效：'ghost' 次要按钮，其余按主按钮
     * 两种形态的取舍见 components.css 里 c-empty-block 的注释。
     */
    function uiEmpty(opts) {
        opts = opts || {};
        const block = opts.size === 'block';
        const box = el('div', block ? 'c-empty c-empty-block' : 'c-empty');
        if (opts.icon != null) {
            const ic = el('span', 'c-empty-icon');
            if (typeof opts.icon === 'string') ic.innerHTML = opts.icon; /* 可信内部 SVG/emoji */
            else if (opts.icon instanceof Node) ic.appendChild(opts.icon);
            box.appendChild(ic);
        }
        if (block && opts.title != null) {
            const h = el('span', 'c-empty-title');
            h.textContent = opts.title;
            box.appendChild(h);
        }
        if (opts.text != null) {
            const t = el('span', 'c-empty-text');
            t.textContent = opts.text;
            box.appendChild(t);
        } else if (opts.html != null) {
            const t = el('span', 'c-empty-text');
            t.innerHTML = opts.html; /* 可信内部标记（含图标 SVG） */
            box.appendChild(t);
        }
        const act = opts.action;
        if (act) {
            /* 块级复用 .c-btn，避免第三套按钮样式；行内仍用轻量文字链 */
            const cls = !block ? 'c-empty-action'
                : act.kind === 'ghost' ? 'c-btn' : 'c-btn c-btn-primary';
            const a = act.href ? el('a', cls) : el('button', cls);
            if (act.href) a.href = act.href; else a.type = 'button';
            a.textContent = act.text || '去处理';
            if (act.onClick) a.addEventListener('click', act.onClick);
            box.appendChild(a);
        }
        return box;
    }

    /* ---------- 标签 chip：uiChip(text, { onClose }) ---------- */
    function uiChip(text, opts) {
        opts = opts || {};
        const chip = el('span', 'c-chip');
        const t = el('span', 'c-chip-text');
        t.textContent = text == null ? '' : String(text);
        chip.appendChild(t);
        if (typeof opts.onClose === 'function') {
            const x = el('button', 'c-chip-x');
            x.type = 'button';
            x.setAttribute('aria-label', '移除' + (text ? '「' + text + '」' : ''));
            x.textContent = '×';
            x.addEventListener('click', e => { e.stopPropagation(); opts.onClose(); });
            chip.appendChild(x);
        }
        return chip;
    }

    /* ---------- 统计卡 uiStat({ label, value, delta, tone:'up'|'down'|'flat' }) ---------- */
    function uiStat(opts) {
        opts = opts || {};
        const s = el('div', 'c-stat');
        if (opts.label != null) {
            const l = el('span', 'c-stat-label');
            l.textContent = opts.label;
            s.appendChild(l);
        }
        if (opts.value != null) {
            const v = el('span', 'c-stat-num');
            v.textContent = String(opts.value);
            s.appendChild(v);
        }
        if (opts.delta != null) {
            const d = el('span', 'c-stat-delta ' + (opts.tone === 'up' ? 'c-up' : opts.tone === 'down' ? 'c-down' : 'c-flat'));
            d.textContent = String(opts.delta);
            s.appendChild(d);
        }
        return s;
    }

    global.uiModal = uiModal;
    global.uiConfirm = uiConfirm;
    global.uiEmpty = uiEmpty;
    global.uiChip = uiChip;
    global.uiStat = uiStat;

    /* ---------- 日期选择器 uiDatepicker（PC 端升级原生 input[type=date]） ----------
     * 照搬设计稿：readonly 代理框 + 下拉日历面板（«上一年 ‹上月 年月 下月› 下一年»、周一起始、
     * 当日描边、选中高亮、邻月灰显、min/max 禁用），底部 清空/此刻/确定。
     * 原生 input 隐藏但保留作真实值载体（.c-dp-native），写回后派发 input+change（bubbles）
     * 保证页面现有 onchange / 监听全兼容，页面零改动。
     * 仅 ≥769px 升级；≤768px 移动端保留原生日历（matchMedia 变化时自动升级/还原）。
     * 本文件加载后自动升级全站现有节点，MutationObserver 兜底动态插入的表单。
     */
    const Datepicker = (function () {
        const mq = window.matchMedia('(min-width: 769px)');
        const PAD = n => (n < 10 ? '0' + n : '' + n);
        const isoOf = (y, m, d) => y + '-' + PAD(m + 1) + '-' + PAD(d);
        const WEEK = ['一', '二', '三', '四', '五', '六', '日'];
        const ICON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>';

        const refs = new WeakMap();  /* input → { wrap, fake, ico } */
        let open = null;             /* 当前打开的面板状态 */

        function parseIso(s) {
            const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
            return m ? { y: +m[1], m: +m[2] - 1, d: +m[3] } : null;
        }

        function syncFake(input, fake) {
            const v = input.value || '';
            fake.value = v || '请选择日期';
            if (v) fake.removeAttribute('data-empty'); else fake.setAttribute('data-empty', '1');
        }

        function disabledBy(min, max, s) {
            return (min && s < min) || (max && s > max);
        }

        /* ---- 面板渲染（每次导航/选择整体重绘，全部 textContent，无用户数据入 innerHTML） ---- */
        function renderPop(st) {
            const pop = st.pop;
            pop.textContent = '';

            const head = el('div', 'c-dp-head');
            const mkNav = (txt, label) => {
                const b = el('button', 'c-dp-nav');
                b.type = 'button'; b.textContent = txt; b.setAttribute('aria-label', label);
                return b;
            };
            const bPY = mkNav('«', '上一年'), bPM = mkNav('‹', '上个月');
            const title = el('div', 'c-dp-title');
            title.textContent = st.view.y + '年' + PAD(st.view.m + 1) + '月';
            const bNM = mkNav('›', '下个月'), bNY = mkNav('»', '下一年');
            head.appendChild(bPY); head.appendChild(bPM); head.appendChild(title); head.appendChild(bNM); head.appendChild(bNY);
            pop.appendChild(head);

            const week = el('div', 'c-dp-week');
            for (const w of WEEK) { const s = el('span'); s.textContent = w; week.appendChild(s); }
            pop.appendChild(week);

            const grid = el('div', 'c-dp-grid');
            const lead = (new Date(st.view.y, st.view.m, 1).getDay() + 6) % 7; /* 周一起始 */
            const start = new Date(st.view.y, st.view.m, 1 - lead);
            const now = new Date();
            const todayIso = isoOf(now.getFullYear(), now.getMonth(), now.getDate());
            for (let i = 0; i < 42; i++) {
                const dt = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
                const y = dt.getFullYear(), m = dt.getMonth(), d = dt.getDate();
                const s = isoOf(y, m, d);
                const b = el('button', 'c-dp-day');
                b.type = 'button';
                b.textContent = String(d);
                b.setAttribute('aria-label', y + '年' + (m + 1) + '月' + d + '日');
                if (m !== st.view.m) b.classList.add('out');
                if (s === todayIso) { b.classList.add('today'); b.setAttribute('aria-current', 'date'); }
                if (s === st.sel) b.classList.add('sel');
                if (disabledBy(st.min, st.max, s)) b.disabled = true;
                else b.addEventListener('click', () => { st.sel = s; renderPop(st); });
                grid.appendChild(b);
            }
            pop.appendChild(grid);

            const foot = el('div', 'c-dp-foot');
            const mkBtn = (txt, cls) => {
                const b = el('button', cls);
                b.type = 'button'; b.textContent = txt;
                return b;
            };
            const bClear = mkBtn('清空', 'c-dp-btn');
            bClear.addEventListener('click', () => commit(st, ''));
            const bNow = mkBtn('此刻', 'c-dp-btn');
            if (disabledBy(st.min, st.max, todayIso)) bNow.disabled = true;
            else bNow.addEventListener('click', () => { st.sel = todayIso; renderPop(st); });
            const bOk = mkBtn('确定', 'c-dp-btn c-dp-ok');
            bOk.addEventListener('click', () => commit(st, st.sel || ''));
            foot.appendChild(bClear); foot.appendChild(bNow); foot.appendChild(bOk);
            pop.appendChild(foot);

            bPY.addEventListener('click', () => { st.view.y--; renderPop(st); });
            bPM.addEventListener('click', () => { st.view.m--; if (st.view.m < 0) { st.view.m = 11; st.view.y--; } renderPop(st); });
            bNM.addEventListener('click', () => { st.view.m++; if (st.view.m > 11) { st.view.m = 0; st.view.y++; } renderPop(st); });
            bNY.addEventListener('click', () => { st.view.y++; renderPop(st); });
        }

        /* ---- 值写回：原生 input 为唯一事实源，派发 input+change（bubbles）全兼容 ---- */
        function commit(st, v) {
            if (st.input.value !== v) {
                st.input.value = v;
                st.input.dispatchEvent(new Event('input', { bubbles: true }));
                st.input.dispatchEvent(new Event('change', { bubbles: true }));
            }
            close(true); /* 焦点还给代理框，键盘用户不丢焦点 */
        }

        function close(restoreFocus) {
            const st = open;
            if (!st) return;
            open = null;
            document.removeEventListener('mousedown', st.onDocDown, true);
            window.removeEventListener('keydown', st.onKey, true);
            window.removeEventListener('scroll', st.onScroll, true);
            window.removeEventListener('resize', st.onResize);
            st.pop.remove();
            st.fake.setAttribute('aria-expanded', 'false');
            if (restoreFocus) { try { st.fake.focus(); } catch (e) { /* 焦点还原失败不阻塞 */ } }
        }

        function openPop(input, fake, ico) {
            if (open) close(false); /* 键盘切换到另一输入框时先关旧面板（无 mousedown 途经） */
            if (input.disabled || input.readOnly) return;
            const now = new Date();
            const base = parseIso(input.value);
            const st = {
                input, fake, ico,
                min: /^\d{4}-\d{2}-\d{2}$/.test(input.min || '') ? input.min : '',
                max: /^\d{4}-\d{2}-\d{2}$/.test(input.max || '') ? input.max : '',
                sel: parseIso(input.value) ? input.value : null,
                view: { y: base ? base.y : now.getFullYear(), m: base ? base.m : now.getMonth() }
            };
            syncFake(input, fake);
            st.pop = el('div', 'c-dp-pop');
            st.pop.setAttribute('role', 'dialog');
            st.pop.setAttribute('aria-label', '选择日期');
            st.pop.tabIndex = -1;
            renderPop(st);
            document.body.appendChild(st.pop);

            /* 定位：默认贴输入框下方，放不下则上方，水平夹在视口内 */
            st.pop.style.visibility = 'hidden';
            const r = fake.getBoundingClientRect();
            const pw = st.pop.offsetWidth, ph = st.pop.offsetHeight;
            let top = r.bottom + 6;
            if (top + ph > window.innerHeight - 8) top = Math.max(8, r.top - ph - 6);
            let left = Math.max(8, Math.min(r.left, window.innerWidth - pw - 8));
            st.pop.style.top = top + 'px';
            st.pop.style.left = left + 'px';
            st.pop.style.visibility = '';
            fake.setAttribute('aria-expanded', 'true');

            st.onDocDown = e => {
                if (!st.pop.contains(e.target) && e.target !== fake && !fake.contains(e.target)
                    && e.target !== ico && !ico.contains(e.target)) close(false);
            };
            /* 挂 window 捕获：先于 uiModal 的 document 捕获，Esc 只关最上层的日历 */
            st.onKey = e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); } };
            st.onScroll = () => close(false);
            st.onResize = () => close(false);
            document.addEventListener('mousedown', st.onDocDown, true);
            window.addEventListener('keydown', st.onKey, true);
            window.addEventListener('scroll', st.onScroll, true);
            window.addEventListener('resize', st.onResize);
            open = st;

            const focusTarget = st.pop.querySelector('.c-dp-day.sel') || st.pop.querySelector('.c-dp-day.today') || st.pop;
            try { focusTarget.focus(); } catch (e) { /* 聚焦失败不阻塞 */ }
        }

        /* ---- 升级单个原生 date input：wrap 拷贝其 class/style 以保持原布局角色 ---- */
        function enhance(input) {
            if (!mq.matches || refs.has(input) || !document.contains(input)) return;
            if (input.tagName !== 'INPUT' || input.type !== 'date') return;
            /* UI 评审 P1-4：带 data-no-dp 的隐藏日期载体由调用方自己用 showPicker()
               唤起（如「记一下」的基准日期胶囊），不要把它升级成可见的代理输入框。 */
            if (input.hasAttribute('data-no-dp')) return;

            const wrap = el('span', 'c-dp-wrap');
            const cls = input.getAttribute('class');
            if (cls) cls.split(/\s+/).filter(Boolean).forEach(c => wrap.classList.add(c));
            const stl = input.getAttribute('style');
            if (stl) wrap.setAttribute('style', stl);

            const fake = el('input', 'c-dp-fake');
            fake.type = 'text';
            fake.readOnly = true;
            fake.disabled = input.disabled;
            fake.setAttribute('aria-haspopup', 'dialog');
            fake.setAttribute('aria-expanded', 'false');
            fake.setAttribute('autocomplete', 'off');
            const al = input.getAttribute('aria-label');
            if (al) fake.setAttribute('aria-label', al);
            const ti = input.getAttribute('title');
            if (ti) fake.setAttribute('title', ti);

            const ico = el('button', 'c-dp-ico');
            ico.type = 'button';
            ico.setAttribute('aria-label', '打开日历');
            fillContent(ico, ICON_SVG); /* 页内可信 SVG 常量 */

            const ref = { wrap, fake, ico };
            refs.set(input, ref);
            syncFake(input, fake);

            const toggle = () => { if (open && open.input === input) close(false); else openPop(input, fake, ico); };
            fake.addEventListener('click', toggle);
            fake.addEventListener('keydown', e => {
                if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') { e.preventDefault(); toggle(); }
            });
            ico.addEventListener('click', toggle);
            /* 页面代码以原生 change 同步值时（如移动端切回桌面），刷新代理框显示 */
            input.addEventListener('change', () => { if (refs.get(input) === ref) syncFake(input, fake); });

            input.classList.add('c-dp-native');
            input.insertAdjacentElement('afterend', wrap);
            wrap.appendChild(fake);
            wrap.appendChild(ico);
        }

        function unenhance(input) {
            const ref = refs.get(input);
            if (!ref) return;
            refs.delete(input);
            if (open && open.input === input) close(false);
            ref.wrap.remove();
            input.classList.remove('c-dp-native');
        }

        function sync(input) {
            const ref = refs.get(input);
            if (ref) syncFake(input, ref.fake);
        }
        function syncAll() { trackedEach(sync); }

        /* ---- 自动升级：DOM ready + 动态插入（MutationObserver，60ms 去抖） ---- */
        function auto(root) {
            if (!mq.matches) return;
            const scope = root && root.querySelectorAll ? root : document;
            if (root && root.tagName === 'INPUT') { enhance(root); return; }
            scope.querySelectorAll('input[type="date"]').forEach(enhance);
        }

        function trackedEach(fn) {
            document.querySelectorAll('input.c-dp-native').forEach(fn);
        }

        const pendSet = new Set();
        let pendT = 0;
        function schedule(n) {
            pendSet.add(n);
            if (!pendT) pendT = setTimeout(() => {
                pendT = 0;
                const list = [...pendSet];
                pendSet.clear();
                list.forEach(x => { if (document.contains(x)) (x.type === 'date' && mq.matches ? enhance : unenhance)(x); });
            }, 60);
        }
        const mo = new MutationObserver(muts => {
            for (const m of muts) {
                if (m.type === 'attributes') {
                    const t = m.target;
                    if (t.tagName !== 'INPUT') continue;
                    if (m.attributeName === 'type') { schedule(t); continue; } /* 双向：变 date 升级 / 变走还原 */
                    if (m.attributeName === 'disabled') { const ref = refs.get(t); if (ref) ref.fake.disabled = t.disabled; }
                    continue;
                }
                m.addedNodes.forEach(n => {
                    if (n.nodeType !== 1) return;
                    if (n.matches && n.matches('input[type="date"]')) schedule(n);
                    if (n.querySelectorAll) n.querySelectorAll('input[type="date"]').forEach(schedule);
                });
            }
        });
        mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['type', 'disabled'] });

        /* 断点切换：升桌面补升级，回移动全还原 */
        const onMq = e => {
            if (e.matches) auto();
            else trackedEach(unenhance);
        };
        if (mq.addEventListener) mq.addEventListener('change', onMq); else mq.addListener(onMq);

        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => auto());
        else auto();

        return { auto, enhance, unenhance, sync, syncAll };
    })();

    global.uiDatepicker = Datepicker;
})(window);
