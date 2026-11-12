/* 足迹回顾页脚本（v47 多图层 + 填色图 + 时间轴回放 + 照片点位）
 *
 * 2026-10-23 从 footprint.html 内联 <script> 整块外提（§11.1 第 4 项）：
 * 内容逐字搬迁，一行未改——行为零变化由冒烟测试兜底验证。
 * 外主动机：139 KB 内联脚本是 HTML 每次导航的必传字节，且不进 arch:size
 * 预算视野；独立文件后可被浏览器缓存（?v= 变更即新键），也被预算覆盖。
 * 依赖：common.js / lunar.js / voice.js / telemetry.js / ui.js 先于本文件加载
 *（footprint.html 的 <script> 顺序即依赖顺序，调整顺序会破坏启动时序）。 */

        let fp = null, members = [], mapKey = '', map = null, mapReady = false, mapTried = false;
        /* 空态图标（可信内部 SVG，走 uiEmpty 的 icon 参数） */
        const EMPTY_ICO = {
            pin: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>',
            chart: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="20" x2="12" y2="10"/><line x1="18" y1="20" x2="18" y2="4"/><line x1="6" y1="20" x2="6" y2="16"/></svg>'
        };
        let markerLayer = null, labelLayer = null, selectedCity = '';
        /* 多图层改造：明细点图层（每个有 lat/lng 的点单画）+ 图层模式 + 底图模式 */
        let pointLayer = null, pointLabelLayer = null;
        let layerMode = 'city';       // city（城市聚合，默认，保持老行为）| point（打卡点明细）| both（两层同显）
        let baseMode = 'road';        // road（矢量）| satellite（卫星）| traffic（路况叠加）—— 走腾讯 GL 原生 setBaseMap
        /* 照片数据（v47）：独立于轨迹的拍摄点位层——不生成轨迹、不参与城市聚合/图层模式/时间轴回放，
           单独一层（默认黄色），有独立显示开关与颜色配置（db.settings.footprintPhotoCfg） */
        let photoPts = [], photoLayer = null, photoInfoWin = null;
        let photoCfg = { visible: true, color: '#eab308' };
        /* 时间轴回放状态（四·补）：单 MultiMarker 复用 + setGeometries 递增投放 */
        let tlPts = [], tlShownPts = [], tlLayer = null, tlTimer = null, tlPlaying = false;
        let tlIdx = 0, tlPos = 0, tlSpeed = 1, tlSampled = false;
        let myPos = null;   // 手动点亮选中的城市
        /* 任务 #16：高德对标聚合数据源与视图状态 */
        let allPts = [];                 // /api/tracks/all-points 明细（含 time/address），供日历/地点聚合
        let calYM = '';                  // 当前日历月份 'YYYY-MM'（空 = 跟随数据最新月 / 本月）
        let calSelDay = '';              // 当前展开的日期 'YYYY-MM-DD'
        let placesOpen = '';             // 当前展开的地点名（地点时间线）
        const CAL_MOOD_KEY = 'fp_cal_mood';                          // 心情文案 localStorage 键
        const CAL_MOOD_DEFAULT = '地图上的光点是我们重叠的脚印';      // 默认文案

        const CITY_PALETTE = ['#3b82f6', '#3b82f6', '#3b82f6', '#3b82f6', '#3b82f6', '#f59e0b'];

        /* ============ G1/G3/G4 省份填色图 + 年份视图 + 省份下钻（高德对标 · 纯本地 SVG，零外部依赖） ============
           数据：/js/cn-provinces.json（34 省级 + 九段线要素，坐标瘦身 2 位小数）。
           投影：等距圆柱 + 纬度 1.25 视觉拉伸（接近标准中国全图比例）；主图裁剪线 17.5°N
           —— 海南本岛（≥18°N）保留在主图，西沙/南沙及九段线整体进右下角「南海诸岛」角标框（标准全图画法）。
           视图：填色图（默认，无需地图 Key）⇄ 光点图（原腾讯 GL 底图）；年份切片为纯前端过滤。 */
        let cnGeo = null, cnMapBuilt = false, cnView = 'choro', cnYear = 'all';
        let cnLitCache = null, cnLitCacheYear = null, cnLitCacheFp = null;
        const CN_MAIN_LAT = 17.5;        // 主图 / 角标拆分纬线
        const CN_PROJ_KY = 1.25;        // 纬度视觉拉伸系数

        function escapeHtml(s) {
            return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
        }
        function dateCN(s) {
            if (!s) return '—';
            const p = String(s).slice(0, 10).split('-');
            return p.length === 3 ? (p[0] + '年' + (+p[1]) + '月' + (+p[2]) + '日') : s;
        }
        function fmtDist(m) {
            m = +m || 0;
            if (m < 1000) return m + ' m';
            if (m < 100000) return (m / 1000).toFixed(1) + ' km';
            return Math.round(m / 1000) + ' km';
        }
        function shortCity(c) { return String(c || '').replace(/(市|地区|盟|自治州|特别行政区|自治区|省)$/, '').replace(/(朝鲜族|蒙古族|回族|藏族|维吾尔族|苗族|彝族|壮族|布依族|侗族|瑶族|白族|土家族|哈尼族|哈萨克族|傣族|黎族|傈僳族|羌族)+$/, ''); }

        /* ============ 数据 ============ */
        async function loadAll() {
            const [r, ap, pr] = await Promise.all([apiGet('/api/footprint'), apiGet('/api/tracks/all-points'), apiGet('/api/photo-points')]);
            if (r.code !== 200) return showToast(r.message || '加载失败', 'error');
            fp = r.data;
            /* 任务 #16：A/B 需要 time/address 等明细字段（/api/footprint.points 仅 lat/lng/city/date/name），
               故并行取 all-points 明细作为聚合数据源（数据同源，口径一致）。失败则退化为 fp.points。 */
            allPts = ((ap && ap.code === 200 && ap.data) || []).slice();
            /* 照片数据：失败则清空并沿用默认配置，不阻塞主数据 */
            photoPts = (pr && pr.code === 200 && pr.data && pr.data.list) || [];
            if (pr && pr.code === 200 && pr.data && pr.data.cfg) photoCfg = pr.data.cfg;
            syncPhotoCtl();
            renderStats(); renderProvinces(); renderCities(); renderAch(); renderCards(); renderCalendar(); renderPlaces(); renderCnAll(); renderMapData();
        }
        function renderStats() {
            document.getElementById('stCities').textContent = fp.litCityCount;
            document.getElementById('stProvs').textContent = fp.litProvinceCount;
            document.getElementById('stPoints').textContent = fp.stats.pointCount;
            document.getElementById('stDist').textContent = fmtDist(fp.stats.totalDistance);
            document.getElementById('stDays').textContent = fp.stats.dayCount;
        }
        function renderProvinces() {
            document.getElementById('provCount').textContent = fp.litProvinceCount + ' / ' + fp.provinceTotal;
            document.getElementById('provBar').style.width = Math.round(fp.litProvinceCount / fp.provinceTotal * 100) + '%';
            const lit = {};
            fp.provinces.forEach(p => { lit[p.province] = p; });
            document.getElementById('provGrid').innerHTML = PROV_LIST.map(name => {
                const o = lit[name];
                return '<div class="prov-chip' + (o ? ' lit' : '') + '" title="' + escapeHtml(name) + '">'
                    + '<span>' + escapeHtml(shortCity(name)) + '</span>'
                    + (o ? '<span class="n">' + o.cityCount + '</span>' : '') + '</div>';
            }).join('');
        }
        function renderCities() {
            document.getElementById('cityCount').textContent = fp.litCityCount + ' 座';
            if (!fp.cities.length) {
                const cityBox = document.getElementById('cityList');
                cityBox.innerHTML = '';
                cityBox.appendChild(uiEmpty({
                    size: 'block', icon: EMPTY_ICO.pin,
                    title: '还没有点亮城市',
                    text: '去「轨迹记录」记录打卡，或点上方「+ 点亮城市」手动补记'
                }));
                return;
            }
            const groups = {};
            fp.cities.forEach(c => { const k = c.province || '未归类'; (groups[k] = groups[k] || []).push(c); });
            const order = Object.keys(groups).sort((a, b) => groups[b].length - groups[a].length);
            document.getElementById('cityList').innerHTML = order.map(prov => {
                const list = groups[prov].sort((a, b) => (b.firstDate || '').localeCompare(a.firstDate || ''));
                return '<div class="fp-prov-group"><div class="fp-prov-title"><span class="dot"></span>' + escapeHtml(prov)
                    + '<span style="font-weight:400;">（' + list.length + '）</span></div>'
                    + list.map(c => {
                        const meta = []
                            .concat(c.firstDate ? ['首达 ' + c.firstDate.slice(2).replace(/-/g, '/')] : [])
                            .concat(c.pointCount ? [c.pointCount + ' 个打卡点'] : [])
                            .concat(c.dayCount > 1 ? [c.dayCount + ' 天'] : [])
                            .concat(c.photoCount ? [c.photoCount + ' 张照片'] : []);
                        return '<div class="fp-city' + (selectedCity === c.city ? ' active' : '') + '" data-city="' + escapeHtml(c.city) + '" onclick="focusCity(\'' + escapeHtml(c.city).replace(/'/g, "\\'") + '\')">'
                            + '<div class="fp-city-top"><span class="fp-city-name">' + escapeHtml(shortCity(c.city)) + '</span>'
                            + (c.manual ? '<span class="fp-city-flag">手动</span>' : '')
                            + (c.manualId ? '<button class="icon-btn danger" style="margin-left:auto;" title="取消点亮" onclick="event.stopPropagation();delManual(' + c.manualId + ')"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg></button>' : '')
                            + '</div>'
                            + '<div class="fp-city-meta">' + (meta.length ? meta.map(m => '<span>' + escapeHtml(m) + '</span>').join('') : '<span>手动点亮</span>') + '</div>'
                            + (c.coverUrl ? '<img class="fp-city-cover" src="' + c.coverUrl + '" alt="' + escapeHtml(c.city) + '照片" loading="lazy">' : '')
                            + '</div>';
                    }).join('') + '</div>';
            }).join('');
        }
        const PROV_LIST = ['北京市', '天津市', '河北省', '山西省', '内蒙古自治区', '辽宁省', '吉林省', '黑龙江省', '上海市', '江苏省',
            '浙江省', '安徽省', '福建省', '江西省', '山东省', '河南省', '湖北省', '湖南省', '广东省', '广西壮族自治区',
            '海南省', '重庆市', '四川省', '贵州省', '云南省', '西藏自治区', '陕西省', '甘肃省', '青海省', '宁夏回族自治区',
            '新疆维吾尔自治区', '台湾省', '香港特别行政区', '澳门特别行政区'];
        function renderAch() {
            document.getElementById('achCount').textContent = fp.doneAchievements + ' / ' + fp.achievements.length;
            document.getElementById('achGrid').innerHTML = fp.achievements.map(a =>
                '<div class="ach' + (a.done ? ' done' : '') + '">'
                + '<div class="ach-top"><span class="ach-ico">' + a.icon + '</span><span class="ach-name">' + escapeHtml(a.name) + '</span></div>'
                + '<div class="ach-desc">' + escapeHtml(a.desc) + '</div>'
                + (a.done ? '<div class="ach-prog">已达成 <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg></div>'
                    : '<div class="ach-prog" style="color:var(--text-secondary);">' + Math.min(a.cur, a.need) + ' / ' + a.need + '</div>')
                + '</div>').join('');
        }

        /* ============ 任务 #16：高德对标三区块（A 高光日历 / B 地点时间线 / C 城市卡片网格） ============
           数据口径：统一用 allPts（/api/tracks/all-points 明细）做纯前端聚合；C 卡片用 fp.cities。
           时间字段统一 'YYYY-MM-DD HH:mm:ss'；展示用 MM.DD / HH:mm 短格式。全部零依赖、无副作用。 */

        /* 短格式工具：'YYYY-MM-DD HH:mm:ss' → MM.DD / HH:mm；'YYYY-MM-DD' → MM.DD */
        function fpMD(t) { const s = String(t || '').slice(5, 10); return s ? s.replace('-', '.') : '—'; }
        function fpHM(t) { return String(t || '').slice(11, 16); }
        /* 归一化：把一条点的时间取值（time 优先，date 兜底） */
        function fpPointTime(p) { return String((p && (p.time || p.date)) || ''); }
        /* 有效点：含 time（前 10 位可组成日期）的点；日历/地点聚合都以此为准，避免空日期污染 */
        function fpDatedPts() { return (allPts || []).filter(p => /^\d{4}-\d{2}-\d{2}/.test(fpPointTime(p))); }

        /* ---------- C 城市卡片网格 ---------- */
        /* 城市 → 稳定色相：同名城市恒定色相（不用随机，避免重渲染跳动） */
        function fpCityHue(city) {
            let h = 0; const s = String(city || '');
            for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
            return h;
        }
        /* v1.48.37：白字压 hsl(h 62% 46%) 在黄绿色相上只有 ~2.0，固定白字行不通。
           按色相在「白字+深药丸」与「深墨+浅药丸」两档里选更稳的一档；两档都不够时
           （黄→青之间的中间调死区，双档都只有 ~4.0）再把亮度逐档压暗，直到达标。
           实测 360 个色相最差 4.50：165 个色相保持原亮度 46%，其余压到 28–44%。 */
        function fpCardInk(hue) {
            var INK = [17, 24, 39], W = [255, 255, 255];
            function toRgb(h, s, l) {
                s /= 100; l /= 100;
                var k = function (n) { return (n + h / 30) % 12; };
                var a = s * Math.min(l, 1 - l);
                var f = function (n) { return l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1))); };
                return [f(0) * 255, f(8) * 255, f(4) * 255];
            }
            function lum(c) {
                var v = c.map(function (x) { x /= 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); });
                return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
            }
            function ratio(a, b) { var x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }
            function mix(c, over, al) { return c.map(function (v, i) { return v * al + over[i] * (1 - al); }); }
            var OPTS = [
                { fg: '#ffffff', rgb: W, pill: 'rgba(0,0,0,.24)', prgb: [0, 0, 0], al: 0.24 },
                { fg: '#111827', rgb: INK, pill: 'rgba(255,255,255,.58)', prgb: W, al: 0.58 }
            ];
            function evalAt(L) {
                var s1 = toRgb(hue, 62, L), s2 = toRgb((hue + 42) % 360, 58, Math.max(18, L - 12));
                var best = null;
                OPTS.forEach(function (o) {
                    var w = Math.min(
                        ratio(o.rgb, s1), ratio(o.rgb, s2),
                        ratio(o.rgb, mix(o.prgb, s1, o.al)), ratio(o.rgb, mix(o.prgb, s2, o.al))
                    );
                    if (!best || w > best.worst) best = { fg: o.fg, pill: o.pill, worst: w };
                });
                return best;
            }
            for (var L = 46; L >= 24; L -= 2) {
                var r = evalAt(L);
                if (r.worst >= 4.5) { r.L = L; return r; }
            }
            var last = evalAt(24);
            last.L = 24;
            return last;
        }
        function renderCards() {
            const box = document.getElementById('cityCards');
            const cnt = document.getElementById('cardCount');
            if (!box) return;
            const cities = (fp && fp.cities) || [];
            if (cnt) cnt.textContent = cities.length + ' 座';
            if (!cities.length) {
                box.innerHTML = '<div class="fp-empty-mini">还没有点亮的城市<br>记录打卡或手动点亮一座城市后，这里会排开城市卡片</div>';
                return;
            }
            /* 按首达日期倒序（与城市列表一致）；补点数：优先 buildFootprint 的 pointCount，缺则按 points 计数 */
            const ordered = cities.slice().sort((a, b) => (b.firstDate || '').localeCompare(a.firstDate || ''));
            const ptCountByCity = {};
            ((fp && fp.points) || []).forEach(p => { if (p.city) ptCountByCity[p.city] = (ptCountByCity[p.city] || 0) + 1; });
            box.innerHTML = ordered.map(c => {
                const hue = fpCityHue(c.city);
                const n = (c.pointCount != null ? c.pointCount : (ptCountByCity[c.city] || 0));
                const initial = escapeHtml(shortCity(c.city).slice(0, 1) || '·');
                const ink = fpCardInk(hue);
                const bg = 'linear-gradient(135deg, hsl(' + hue + ' 62% ' + ink.L + '%), hsl(' + ((hue + 42) % 360) + ' 58% ' + Math.max(18, ink.L - 12) + '%))';
                const prov = c.province ? shortCity(c.province) : '';
                return '<div class="fp-card" data-city="' + escapeHtml(c.city) + '" style="background:' + bg + ';--fp-fg:' + ink.fg + ';--fp-pill:' + ink.pill + ';" '
                    + 'onclick="focusCity(\'' + escapeHtml(c.city).replace(/'/g, "\\'") + '\')" '
                    + 'title="' + escapeHtml(c.city) + '">'
                    + '<div class="c-initial">' + initial + '</div>'
                    + '<div class="c-name">' + escapeHtml(shortCity(c.city)) + '</div>'
                    + (prov ? '<div class="c-prov">' + escapeHtml(prov) + '</div>' : '<div class="c-prov">足迹</div>')
                    + '<div class="c-meta"><span><b>' + n + '</b> 个打卡点</span>'
                    + '<span>' + (c.firstDate ? '首达 ' + fpMD(c.firstDate) : '手动点亮') + '</span></div>'
                    + '</div>';
            }).join('');
        }

        /* ---------- A 高光日历 ---------- */
        function calDayMap() {
            const map = {};   // 'YYYY-MM-DD' -> [点...]
            fpDatedPts().forEach(p => {
                const d = fpPointTime(p).slice(0, 10);
                (map[d] = map[d] || []).push(p);
            });
            return map;
        }
        function calInitYM(dayMap) {
            if (calYM) return calYM;
            const months = Object.keys(dayMap).map(d => d.slice(0, 7)).sort();
            const today = todayStr().slice(0, 7);
            /* 优先本月；本月无数据则取数据最新月；都无则本月 */
            if (months.indexOf(today) >= 0) calYM = today;
            else calYM = months.length ? months[months.length - 1] : today;
            return calYM;
        }
        function renderCalendar() {
            const grid = document.getElementById('calGrid');
            const dow = document.getElementById('calDow');
            const title = document.getElementById('calTitle');
            const cntEl = document.getElementById('calCount');
            const listEl = document.getElementById('calDayList');
            if (!grid) return;
            const dayMap = calDayMap();
            const ym = calInitYM(dayMap);
            const [Y, M] = ym.split('-').map(Number);
            const monthPts = fpDatedPts().filter(p => fpPointTime(p).slice(0, 7) === ym);
            if (title) title.innerHTML = Y + ' 年 ' + M + ' 月<small>' + monthPts.length + ' 个打卡</small>';
            if (cntEl) cntEl.textContent = '本月 ' + monthPts.length + ' 个打卡点';
            /* 表头（周一为始，与 location.html 一致） */
            if (dow && !dow.dataset.done) {
                dow.innerHTML = ['一', '二', '三', '四', '五', '六', '日'].map(w => '<div class="fc-dow">' + w + '</div>').join('');
                dow.dataset.done = '1';
            }
            /* 网格：周一为第一列 */
            const first = new Date(Y, M - 1, 1);
            const startPad = (first.getDay() + 6) % 7;         // 周一=0
            const daysInMonth = new Date(Y, M, 0).getDate();
            const today = todayStr().slice(0, 10);
            let html = '';
            for (let i = 0; i < startPad; i++) html += '<div class="fc-day pad"></div>';
            for (let d = 1; d <= daysInMonth; d++) {
                const ds = ym + '-' + String(d).padStart(2, '0');
                const n = (dayMap[ds] || []).length;
                const cls = ['fc-day'];
                if (n) cls.push('has', n >= 4 ? 'h3' : (n >= 2 ? 'h2' : 'h1'));
                if (ds === today) cls.push('today');
                if (ds === calSelDay) cls.push('sel');
                html += '<div class="' + cls.join(' ') + '"' + (n ? ' data-day="' + ds + '" onclick="calPickDay(\'' + ds + '\')"' : '') + ' title="' + ds + (n ? ' · ' + n + ' 个打卡点' : '') + '">'
                    + (n ? '<span class="badge">' + n + '</span>' : '')
                    + '<span class="n">' + d + '</span>'
                    + (n ? '<span class="dot"></span>' : '')
                    + '</div>';
            }
            grid.innerHTML = html;
            /* 底部当日列表：默认展示「最新有记录的一天」或已选日 */
            if (!calSelDay || calSelDay.slice(0, 7) !== ym) {
                const inMonth = Object.keys(dayMap).filter(d => d.slice(0, 7) === ym).sort();
                calSelDay = inMonth.length ? inMonth[inMonth.length - 1] : '';
            }
            renderCalDayList(dayMap);
        }
        function calShift(delta) {
            const [Y, M] = calInitYM(calDayMap()).split('-').map(Number);
            const nd = new Date(Y, M - 1 + delta, 1);
            calYM = nd.getFullYear() + '-' + String(nd.getMonth() + 1).padStart(2, '0');
            calSelDay = '';
            renderCalendar();
        }
        function calGoToday() { calYM = todayStr().slice(0, 7); calSelDay = ''; renderCalendar(); }
        function calPickDay(ds) { calSelDay = ds; renderCalendar(); }
        function renderCalDayList(dayMap) {
            const el = document.getElementById('calDayList');
            if (!el) return;
            if (!calSelDay || !(dayMap[calSelDay] || []).length) {
                el.innerHTML = '<div class="fc-dl-hd">点击日历中有圆点的日期查看当日打卡</div>';
                return;
            }
            const list = dayMap[calSelDay].slice().sort((a, b) => fpPointTime(a).localeCompare(fpPointTime(b)));
            el.innerHTML = '<div class="fc-dl-hd">' + calSelDay + ' · ' + list.length + ' 个打卡点</div>'
                + list.map(p => {
                    const t = fpHM(fpPointTime(p));
                    const name = p.name || '未命名地点';
                    const meta = [t, p.address || ''].filter(Boolean).join(' · ');
                    const cityAttr = p.city ? escapeHtml(p.city).replace(/'/g, "\\'") : '';
                    return '<div class="fc-point">'
                        + '<div class="fc-dot"></div>'
                        + '<div class="fc-pmain"><div class="fc-pname">' + escapeHtml(name) + '</div>'
                        + '<div class="fc-pmeta">' + escapeHtml(meta || '—') + '</div></div>'
                        + (cityAttr ? '<button class="btn btn-secondary btn-sm" style="flex:none;" onclick="focusCity(\'' + cityAttr + '\')">定位</button>' : '')
                        + '</div>';
                }).join('');
        }
        /* 心情文案：localStorage 持久化，默认落库一次 */
        function calMoodLoad() {
            const el = document.getElementById('calMoodText');
            if (!el) return;
            let v = '';
            try { v = localStorage.getItem(CAL_MOOD_KEY) || ''; } catch (e) { v = ''; }
            if (!v) { v = CAL_MOOD_DEFAULT; try { localStorage.setItem(CAL_MOOD_KEY, v); } catch (e) { } }
            el.value = v;
        }
        let calMoodTimer = null;
        function calMoodSave() {
            const el = document.getElementById('calMoodText');
            if (!el) return;
            const hint = document.getElementById('calMoodHint');
            if (hint) hint.textContent = '保存中…';
            clearTimeout(calMoodTimer);
            calMoodTimer = setTimeout(() => {
                try { localStorage.setItem(CAL_MOOD_KEY, el.value); if (hint) hint.textContent = '已保存'; }
                catch (e) { if (hint) hint.textContent = '保存失败（浏览器存储不可用）'; }
            }, 350);
        }

        /* ---------- B 地点维度时间线 ---------- */
        function placeAgg() {
            const map = {};   // name -> {name, visits:[点], first, last}
            fpDatedPts().forEach(p => {
                const name = String(p.name || '').trim();
                if (!name) return;                        // 无名点不参与地点聚合
                const o = map[name] || (map[name] = { name: name, visits: [] });
                o.visits.push(p);
            });
            const arr = Object.keys(map).map(k => {
                const o = map[k];
                o.visits.sort((a, b) => fpPointTime(b).localeCompare(fpPointTime(a)));   // 最近到访倒序
                o.count = o.visits.length;
                o.first = o.visits[o.visits.length - 1];
                o.last = o.visits[0];
                return o;
            });
            arr.sort((a, b) => fpPointTime(b.last).localeCompare(fpPointTime(a.last)) || b.count - a.count);
            return arr;
        }
        function renderPlaces() {
            const box = document.getElementById('placeList');
            const cntEl = document.getElementById('placeCount');
            if (!box) return;
            const arr = placeAgg();
            if (cntEl) cntEl.textContent = arr.length + ' 个地点';
            if (!arr.length) {
                box.innerHTML = '<div class="fp-empty-mini">还没有可聚合的地点<br>打卡点需要填写「地点名」，这里才会按地点归拢你的到访记录</div>';
                return;
            }
            box.innerHTML = arr.map(o => {
                const open = placesOpen === o.name;
                const firstD = fpPointTime(o.first).slice(0, 10), lastD = fpPointTime(o.last).slice(0, 10);
                const nameAttr = escapeHtml(o.name).replace(/'/g, "\\'");
                let visits = '';
                if (open) {
                    visits = '<div class="fp-place-visits">' + o.visits.map(p => {
                        const t = fpPointTime(p);
                        const meta = [fpMD(t), fpHM(t), p.address || '', p.city ? shortCity(p.city) : ''].filter(Boolean).join(' · ');
                        return '<div class="fp-visit"><div class="vmain">'
                            + '<div class="vt">' + escapeHtml(fpMD(t) + ' ' + fpHM(t)) + (p.mood ? ' ' + escapeHtml(p.mood) : '') + '</div>'
                            + '<div class="va">' + escapeHtml(meta) + '</div></div>'
                            + '<button class="vmemo" onclick="event.stopPropagation();fpWriteMemo(\'' + nameAttr + '\')">写回忆</button>'
                            + '</div>';
                    }).join('') + '</div>';
                }
                return '<div class="fp-place' + (open ? ' open' : '') + '" data-place="' + escapeHtml(o.name) + '" onclick="placeToggle(\'' + nameAttr + '\')">'
                    + '<div class="fp-place-top"><span class="fp-place-name">' + escapeHtml(o.name) + '</span>'
                    + '<span class="fp-place-badge">到访 ' + o.count + ' 次</span></div>'
                    + '<div class="fp-place-meta"><span>首次 ' + fpMD(firstD) + '</span><span>最近 ' + fpMD(lastD) + '</span></div>'
                    + visits
                    + '</div>';
            }).join('');
        }
        function placeToggle(name) {
            placesOpen = (placesOpen === name) ? '' : name;
            renderPlaces();
        }
        /* 「写回忆」→ 复用 location.html 的现有随笔弹窗（#diaryModal / openDiaryModal），
           跨页跳转并携带地点名预填，不重写弹窗（任务 #16-B 约束）。 */
        function fpWriteMemo(name) {
            location.href = '/location?diary=1&place=' + encodeURIComponent(name || '');
        }

        /* ============ 地图 ============ */
        async function initCnMap() {
            const wrap = document.getElementById('cnMapWrap');
            if (!wrap) return;
            try {
                const r = await fetch('/js/cn-provinces.json');
                if (!r.ok) throw new Error('HTTP ' + r.status);
                cnGeo = await r.json();
            } catch (e) {
                wrap.innerHTML = '<div class="fp-map-empty" style="height:100%;">'
                    + '<div class="t">地图数据加载失败</div>'
                    + '<div class="d">省份填色图依赖本地数据文件 public/js/cn-provinces.json，刷新重试即可；「光点图」不受影响。</div></div>';
                return;
            }
            buildCnMap();
            renderCnMap();
        }
        /* feature → [rings]：Polygon/MultiPolygon 归一 */
        function cnPolyUnits(f) {
            const g = f && f.geometry;
            if (!g) return [];
            return g.type === 'Polygon' ? [g.coordinates] : (g.type === 'MultiPolygon' ? g.coordinates : []);
        }
        /* 主图 / 南海角标拆分：外环含 17.5°N 以南点的环（西沙/南沙）+ 九段线要素 → 角标；其余 → 主图 */
        function cnSplitFeatures() {
            const main = [], inset = [];
            ((cnGeo && cnGeo.features) || []).forEach(f => {
                const name = (f.properties && f.properties.name) || '';
                const isJD = (f.properties && f.properties.adcode) === '100000_JD';
                cnPolyUnits(f).forEach(rings => {
                    if (isJD) { inset.push({ name: '', rings }); return; }
                    const outer = rings[0] || [];
                    const south = outer.some(pt => pt[1] < CN_MAIN_LAT);
                    (south ? inset : main).push({ name, rings });
                });
            });
            return { main, inset };
        }
        /* 坐标合法性守卫：坏数据（null/NaN）直接跳过，避免生成 NaN 的 SVG path（P0-3） */
        function cnValidPt(pt) { return !!pt && pt.length >= 2 && isFinite(pt[0]) && isFinite(pt[1]); }
        /* 等距投影器：bbox 自适应 viewBox，d 生成器 */
        function cnProjector(units) {
            let lo1 = 999, la1 = 999, lo2 = -999, la2 = -999;
            units.forEach(u => (u.rings[0] || []).forEach(pt => {
                if (!cnValidPt(pt)) return;
                if (pt[0] < lo1) lo1 = pt[0]; if (pt[0] > lo2) lo2 = pt[0];
                if (pt[1] < la1) la1 = pt[1]; if (pt[1] > la2) la2 = pt[1];
            }));
            if (lo1 > lo2) { lo1 = 73; lo2 = 136; la1 = 18; la2 = 54; }   // 空数据兑底
            const K = 10, KY = 10 * CN_PROJ_KY, PAD = 6;
            const dPath = rings => rings.map(ring => {
                const pts = ring.filter(cnValidPt);
                return pts.length >= 3
                    ? 'M' + pts.map(pt => ((pt[0] - lo1) * K).toFixed(1) + ',' + ((la2 - pt[1]) * KY).toFixed(1)).join('L') + 'Z'
                    : '';
            }).join('');
            const vb = (-PAD) + ' ' + (-PAD) + ' ' + ((lo2 - lo1) * K + PAD * 2) + ' ' + ((la2 - la1) * KY + PAD * 2);
            return { dPath, viewBox: vb };
        }
        function buildCnMap() {
            if (cnMapBuilt || !cnGeo) return;
            const { main, inset } = cnSplitFeatures();
            const svgMain = document.getElementById('cnMap');
            const svgInset = document.getElementById('cnInsetMap');
            if (!svgMain || !main.length) return;
            /* 主图：同名省多环合并为一个 path（fill-rule=evenodd 处理飞地/洞） */
            const byName = {};
            main.forEach(u => { (byName[u.name] = byName[u.name] || []).push(u.rings); });
            const mp = cnProjector(main);
            svgMain.setAttribute('viewBox', mp.viewBox);
            let html = '';
            Object.keys(byName).forEach(name => {
                let d = '';
                byName[name].forEach(rings => { d += mp.dPath(rings); });
                html += '<path class="cn-prov" data-name="' + escapeHtml(name) + '" d="' + d + '" fill-rule="evenodd"></path>';
            });
            svgMain.innerHTML = html;
            /* 南海诸岛角标：九段线 + 南部岛屿环，独立投影 */
            if (svgInset) {
                const ip = cnProjector(inset.length ? inset : [{ name: '', rings: [[[110, 3.7], [117.5, 3.7], [117.5, 20.5], [110, 20.5]]] }]);
                svgInset.setAttribute('viewBox', ip.viewBox);
                svgInset.innerHTML = inset.map(u => {
                    const cls = u.name ? 'cn-inset-prov' : 'cn-inset-jd';
                    const attr = u.name ? ' data-name="' + escapeHtml(u.name) + '"' : '';
                    return '<path class="' + cls + '"' + attr + ' d="' + ip.dPath(u.rings) + '" fill-rule="evenodd"></path>';
                }).join('');
            }
            /* 交互：悬浮提示 + 点击下钻 */
            svgMain.querySelectorAll('.cn-prov').forEach(p => {
                const nm = p.dataset.name;
                p.addEventListener('mouseenter', e => cnTipShow(e, nm));
                p.addEventListener('mousemove', e => cnTipMove(e));
                p.addEventListener('mouseleave', cnTipHide);
                p.addEventListener('click', () => provDetail(nm));
            });
            cnMapBuilt = true;
        }
        /* 当前年份视角下「已点亮省 → 数据」映射（结果缓存：hover 高频调用） */
        function cnLitMap() {
            if (cnLitCache && cnLitCacheFp === fp && cnLitCacheYear === cnYear) return cnLitCache;
            const lit = {};
            if (fp) {
                if (cnYear === 'all') {
                    (fp.provinces || []).forEach(p => { lit[p.province] = p; });
                } else {
                    const y = +cnYear;
                    (fp.cities || []).forEach(c => {
                        const f = +String(c.firstDate || '').slice(0, 4);
                        const l = +String(c.lastDate || '').slice(0, 4);
                        if (!f || !l || f > y || y > l) return;      // 城市足迹区间与该年不相交 → 不计
                        const k = c.province;
                        if (!k) return;
                        const o = lit[k] = lit[k] || { province: k, cityCount: 0, pointCount: 0, firstDate: c.firstDate };
                        o.cityCount++; o.pointCount += (c.pointCount || 0);
                        if (String(c.firstDate) < String(o.firstDate)) o.firstDate = c.firstDate;
                    });
                }
            }
            cnLitCache = lit; cnLitCacheYear = cnYear; cnLitCacheFp = fp;
            return lit;
        }
        function renderCnMap() {
            if (!cnMapBuilt) return;
            const lit = cnLitMap();
            const total = (fp && fp.provinceTotal) || 34;
            const n = Object.keys(lit).length;
            document.querySelectorAll('#cnMap .cn-prov').forEach(p => p.classList.toggle('lit', !!lit[p.dataset.name]));
            document.querySelectorAll('#cnInsetMap .cn-inset-prov').forEach(p => p.classList.toggle('lit', !!lit[p.dataset.name]));
            const cntEl = document.getElementById('mapCount');
            if (cntEl) cntEl.textContent = (cnYear === 'all' ? '已点亮 ' : cnYear + ' 年 ') + n + ' / ' + total + ' 省';
            const hint = document.getElementById('mapHint');
            if (hint) hint.innerHTML = cnYear === 'all'
                ? '填色图：去过的省份已点亮，共 <b>' + n + ' / ' + total + '</b> 个省级区域。悬浮查看首访时间，点击省份看城市足迹。数据仅存本机 <code>data/db.json</code>，不上传。'
                : cnYear + ' 年你的足迹覆盖 <b>' + n + '</b> 个省级区域 · 点上方年份可回看其它年份';
        }
        function cnYears() {
            const s = new Set();
            ((fp && fp.cities) || []).forEach(c => {
                const f = String(c.firstDate || '').slice(0, 4);
                const l = String(c.lastDate || '').slice(0, 4);
                if (/^\d{4}$/.test(f)) s.add(f);
                if (/^\d{4}$/.test(l)) s.add(l);
            });
            return Array.from(s).sort();
        }
        function buildCnYearChips() {
            const row = document.getElementById('cnYearRow');
            if (!row) return;
            const years = cnYears();
            /* 数据刷新后所选年份已不存在 → 回退「全部」 */
            if (cnYear !== 'all' && years.indexOf(cnYear) < 0) { cnYear = 'all'; cnLitCache = null; }
            if (years.length < 2) { row.style.display = 'none'; return; }   // 只有一年份时与「全部」无差别，不显示
            row.style.display = '';
            row.innerHTML = '<span class="fp-ctl-label">年份</span>'
                + '<button class="fp-chip' + (cnYear === 'all' ? ' active' : '') + '" onclick="setViewYear(\'all\')">全部</button>'
                + years.map(y => '<button class="fp-chip' + (String(cnYear) === y ? ' active' : '') + '" onclick="setViewYear(\'' + y + '\')">' + y + '</button>').join('');
        }
        function setViewYear(y) {
            cnYear = String(y);
            cnLitCache = null;
            buildCnYearChips();
            if (cnView === 'choro') renderCnMap();
        }
        function renderCnAll() { buildCnYearChips(); if (cnView === 'choro') renderCnMap(); }
        function setMapView(v) {
            if (v !== 'choro' && v !== 'light') return;
            cnView = v;
            document.querySelectorAll('#viewCtl .fp-chip').forEach(c => c.classList.toggle('active', c.dataset.view === v));
            const cnWrap = document.getElementById('cnMapWrap');
            const yearRow = document.getElementById('cnYearRow');
            const tools = document.getElementById('lightTools');
            const tmap = document.getElementById('tmap');
            const empty = document.getElementById('mapEmpty');
            if (cnWrap) cnWrap.style.display = (v === 'choro') ? '' : 'none';
            if (tools) tools.style.display = (v === 'choro') ? 'none' : '';
            if (v === 'choro') {
                if (tmap) tmap.style.display = 'none';
                if (empty) empty.style.display = 'none';
                buildCnYearChips();   // 年份行显隐由数据驱动（仅 1 年时隐藏），不在此覆盖
                renderCnMap();
            } else {
                if (yearRow) yearRow.style.display = 'none';
                if (map && mapReady) {
                    if (tmap) tmap.style.display = 'block';
                    if (empty) empty.style.display = 'none';
                    renderMapData._reapply = true;   // 刷新 mapCount/时间轴且不复位视野
                    renderMapData();
                } else {
                    if (tmap) tmap.style.display = 'none';
                    if (empty) empty.style.display = 'flex';   // initMap 已备好「无Key/加载失败」文案
                }
            }
        }
        function cnTipShow(e, name) {
            const tip = document.getElementById('cnTip');
            if (!tip) return;
            const d = cnLitMap()[name];
            tip.innerHTML = '<b>' + escapeHtml(name) + '</b>'
                + (d ? '<span>' + d.cityCount + ' 座城市 · 首访 ' + dateCN(d.firstDate) + '</span>'
                     : '<span>还未点亮 · 点击看看</span>');
            tip.style.display = 'block';
            cnTipMove(e);
        }
        function cnTipMove(e) {
            const tip = document.getElementById('cnTip');
            const wrap = document.getElementById('cnMapWrap');
            if (!tip || !wrap || tip.style.display === 'none') return;
            const r = wrap.getBoundingClientRect();
            let x = e.clientX - r.left + 14, y = e.clientY - r.top + 14;
            if (x + tip.offsetWidth > r.width - 6) x = r.width - tip.offsetWidth - 6;
            if (y + tip.offsetHeight > r.height - 6) y = r.height - tip.offsetHeight - 6;
            tip.style.left = Math.max(6, x) + 'px';
            tip.style.top = Math.max(6, y) + 'px';
        }
        function cnTipHide() { const tip = document.getElementById('cnTip'); if (tip) tip.style.display = 'none'; }
        /* G4 省份下钻弹层：该省点亮城市清单（跟随当前年份视角） */
        function provDetail(name) {
            const d = cnLitMap()[name];
            const y = cnYear;
            const cities = ((fp && fp.cities) || []).filter(c => c.province === name
                && (y === 'all' ? true : (+(String(c.firstDate || '').slice(0, 4)) <= +y && +y <= +(String(c.lastDate || '').slice(0, 4)))))
                .sort((a, b) => (b.pointCount || 0) - (a.pointCount || 0));
            document.getElementById('provModalTitle').textContent = name + (y === 'all' ? '' : ' · ' + y + ' 年');
            const provBody = document.getElementById('provModalBody');
            provBody.innerHTML =
                '<div class="pm-stats">'
                + '<div class="pm-stat"><div class="v">' + (d ? d.cityCount : 0) + '</div><div class="l">点亮城市</div></div>'
                + '<div class="pm-stat"><div class="v">' + (d ? (d.pointCount || 0) : 0) + '</div><div class="l">打卡点</div></div>'
                + '<div class="pm-stat"><div class="v">' + (d && d.firstDate ? dateCN(d.firstDate) : '—') + '</div><div class="l">首次到访</div></div>'
                + '</div>';
            if (cities.length) {
                provBody.insertAdjacentHTML('beforeend', '<div class="pm-cities">' + cities.map(c =>
                    '<div class="pm-city" onclick="provFocusCity(\'' + escapeHtml(c.city).replace(/'/g, "\\'") + '\')">'
                    + '<span class="n">' + escapeHtml(shortCity(c.city)) + (c.manual ? ' <i>手动</i>' : '') + '</span>'
                    + '<span class="m">' + [c.firstDate ? '首达 ' + c.firstDate.slice(2).replace(/-/g, '/') : '',
                        c.pointCount ? c.pointCount + ' 个打卡点' : '', c.dayCount > 1 ? c.dayCount + ' 天' : '',
                        c.photoCount ? c.photoCount + ' 张照片' : ''].filter(Boolean).join(' · ') + '</span>'
                    + '</div>').join('') + '</div>');
            } else {
                provBody.appendChild(uiEmpty({
                    size: 'block',
                    title: y === 'all' ? '还没有点亮这里的城市' : y + ' 年在这里还没有足迹',
                    text: '去「轨迹记录」打卡，或点上方「+ 点亮城市」手动补记'
                }));
            }
            openModal('provModal');
        }
        function provFocusCity(city) {
            closeModal('provModal');
            focusCity(city);
            if (map && mapReady) setMapView('light');   // 光点图可用时切过去真实飞到城市
        }

        function loadTMapSDK(key) {
            return new Promise((resolve, reject) => {
                if (window.TMap) return resolve();
                const s = document.createElement('script');
                s.src = 'https://map.qq.com/api/gljs?v=1.exp&key=' + encodeURIComponent(key);
                s.onload = () => window.TMap ? resolve() : reject(new Error('地图 SDK 加载异常'));
                s.onerror = () => reject(new Error('地图 SDK 加载失败，请检查网络或 Key 的域名白名单'));
                document.head.appendChild(s);
            });
        }
        function cityMarkerStyle(color, size) {
            const svg = "<svg xmlns='http://www.w3.org/2000/svg' width='" + (size + 12) + "' height='" + (size + 12) + "' viewBox='0 0 40 40'>"
                + "<circle cx='20' cy='20' r='16' fill='" + color + "' fill-opacity='0.18'/>"
                + "<circle cx='20' cy='20' r='9' fill='" + color + "' stroke='white' stroke-width='2.5'/></svg>";
            const s = size + 12;
            return new TMap.MarkerStyle({
                width: s, height: s, anchor: { x: s / 2, y: s / 2 },
                src: 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)
            });
        }
        function fpCenter() {
            const pts = fp.points.filter(p => p.lat != null && p.lng != null);
            if (pts.length) {
                const lat = pts.reduce((s, p) => s + p.lat, 0) / pts.length;
                const lng = pts.reduce((s, p) => s + p.lng, 0) / pts.length;
                return new TMap.LatLng(lat, lng);
            }
            return new TMap.LatLng(30.59, 114.31); // 默认武汉
        }
        async function initMap() {
            if (mapReady || mapTried) return;
            mapTried = true;
            const emptyEl = document.getElementById('mapEmpty');
            if (!fp.points.length && !fp.cities.length) {
                emptyEl.innerHTML = '<div class="big"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 6v16l6-2 6 2 6-2 4 2V6l-4-2-6 2-6-2-6 2z"/><path d="M8 6v.01"/><path d="M16 6v.01"/><path d="M8 16v.01"/><path d="M16 16v.01"/></svg></div><div class="t">还没有足迹</div>'
                    + '<div class="d">记录第一个打卡点，或手动点亮一座城市，这里会铺开你的足迹地图。</div>';
                return;
            }
            if (!mapKey) {
                emptyEl.innerHTML = '<div class="big"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg></div><div class="t">未配置地图 Key，暂以「城市列表」呈现</div>'
                    + '<div class="d">到 <b>系统设置 → 位置轨迹</b> 填入腾讯位置服务 Key（需勾选 JavaScript API GL）后，这里会显示真实底图上的足迹光点。'
                    + '<br>合规说明：按国家测绘规定，地图底图只能使用高德 / 腾讯 / 百度 / 天地图等有资质服务商，本系统不内置任何 Key。</div>'
                    + '<a class="btn btn-primary btn-sm" href="/settings">去配置地图 Key</a>';
                document.getElementById('mapHint').innerHTML = '当前以城市卡片列表展示足迹，全部功能可用。';
                return;
            }
            try {
                await loadTMapSDK(mapKey);
                document.getElementById('tmap').style.display = 'block';
                emptyEl.style.display = 'none';
                map = new TMap.Map(document.getElementById('tmap'), {
                    center: fpCenter(), zoom: 4, viewMode: '2D', showControl: true
                });
                /* 回放期间用户拖动地图 → 自动暂停，避免状态打架 */
                map.on('pan', () => { if (tlPlaying) tlStop(); });
                /* 先置 mapReady：renderMapData() 末尾会调 tlSetup()，而 tlSetup() 以 mapReady 作为
                   「地图可用」闸门。若仍按旧序（先 renderMapData 后 mapReady=true），首次渲染必然
                   走 tlSetup() 的隐藏分支且此后无人补调 → 回放条永远不显示（死锁）。
                   提前置位后，renderMapData() 开头的 `if (!map || !mapReady) return;` 恰好放行，
                   tlSetup() 也能读到正确就绪态，一次性渲染成功。 */
                mapReady = true;
                /* 地图就绪 → 显示图层/底图/照片数据切换器，并恢复上次底图选择（fail-soft） */
                const lc = document.getElementById('layerCtl'), bc = document.getElementById('baseCtl'), pc = document.getElementById('photoCtl');
                if (lc) lc.style.display = 'flex';
                if (bc) bc.style.display = 'flex';
                if (pc) pc.style.display = 'flex';
                apiGet('/api/map-config').then(cfg => {
                    const preset = cfg && cfg.data && cfg.data.preset;
                    if (preset && FP_BASE_MAP[preset]) setBaseMapMode(preset, false);
                }).catch(() => { /* 配置读取失败 → 用默认道路底图 */ });
                renderMapData();
                document.getElementById('mapHint').innerHTML = '地图服务：腾讯位置服务（底图）。足迹数据仅保存在本机 <code>data/db.json</code>，不会上传。';
            } catch (e) {
                document.getElementById('mapEmpty').innerHTML = '<div class="big"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg></div><div class="t">地图加载失败</div>'
                    + '<div class="d">' + escapeHtml(e.message) + '<br>常见原因：Key 的<b>域名白名单</b>未包含当前访问地址（如 127.0.0.1 / 局域网 IP / 你的域名），或该 Key 未勾选 JavaScript API GL。'
                    + '<br>足迹数据本身不受影响，城市列表、省份覆盖、年度报告均可正常使用。</div>'
                    + '<a class="btn btn-primary btn-sm" href="/settings">检查地图 Key 配置</a>';
                document.getElementById('mapHint').innerHTML = '可在「系统设置 → 位置轨迹」检查 Key，或核对 Key 的域名白名单是否包含当前访问地址。';
            }
        }
        /* 记忆当前视野：切图层时保持用户已缩放到的地方，不被 autoFit 复位 */
        function fpSaveView() {
            if (!map || !mapReady) return null;
            try { const c = map.getCenter(); return { lat: c.getLat(), lng: c.getLng(), zoom: map.getZoom() }; }
            catch (e) { return null; }
        }
        function fpRestoreView(v) {
            if (!v || !map || !mapReady) return;
            try { map.setCenter(new TMap.LatLng(v.lat, v.lng)); map.setZoom(v.zoom); } catch (e) { /* 个别环境不支持，忽略 */ }
        }
        /* 明细点地理数据：每个有 lat/lng 的点（含无 city 的点）都纳入 */
        function fpPointGeoms() {
            const out = [];
            (fp.points || []).forEach((p, i) => {
                if (p.lat == null || p.lng == null) return;
                out.push({ pt: p, idx: i, lat: p.lat, lng: p.lng });
            });
            return out;
        }
        /* 解析某个点归属的城市（用于明细点点击 → 聚焦城市） */
        function fpPointCity(p) {
            if (p.city) return p.city;
            const hit = (fp.points || []).find(x => x.lat === p.lat && x.lng === p.lng && x.city);
            return hit ? hit.city : '';
        }
        function renderMapData() {
            if (!map || !mapReady) return;
            /* 切换图层时保持视野：先记快照，onlyAutoFit 为 false 时才复原 */
            const keepView = renderMapData._reapply ? fpSaveView() : null;
            const doCity = (layerMode === 'city' || layerMode === 'both');
            const doPoint = (layerMode === 'point' || layerMode === 'both');

            /* ---- 城市聚合层（原逻辑保留）---- */
            const geoms = [];
            if (doCity) {
                fp.cities.forEach((c, i) => {
                    const pt = fp.points.find(x => x.city === c.city);
                    if (!pt) return;
                    const size = c.pointCount >= 10 ? 30 : (c.pointCount >= 4 ? 24 : 18);
                    geoms.push({
                        id: String(i), styleId: 'c' + (size), position: new TMap.LatLng(pt.lat, pt.lng),
                        properties: { city: c.city }
                    });
                });
            }
            const styles = {};
            [18, 24, 30].forEach(s => { styles['c' + s] = cityMarkerStyle('#3b82f6', s); });
            if (markerLayer) { markerLayer.setMap(null); markerLayer = null; }
            if (labelLayer) { labelLayer.setMap(null); labelLayer = null; }
            if (geoms.length) {
                markerLayer = new TMap.MultiMarker({ map: map, styles: styles, geometries: geoms });
                markerLayer.on('click', evt => {
                    const c = evt.geometry.properties.city;
                    if (c) focusCity(c);
                });
                try {
                    labelLayer = new TMap.MultiLabel({
                        map: map,
                        styles: { l: new TMap.LabelStyle({ color: '#1e293b', size: 12, offset: { x: 0, y: -22 }, alignment: 'center', verticalAlignment: 'bottom' }) },
                        geometries: geoms.map(g => ({
                            id: g.id, styleId: 'l', position: g.position, content: shortCity(g.properties.city)
                        }))
                    });
                } catch (e) { /* 部分环境不支持 Label，忽略 */ }
            }

            /* ---- 打卡点明细层（新增）：每个有坐标的点单画，无 city 的点也画 ---- */
            const pGeoms = [];
            if (doPoint) {
                fpPointGeoms().forEach(g => {
                    pGeoms.push({
                        id: 'p' + g.idx, styleId: 'pt', position: new TMap.LatLng(g.lat, g.lng),
                        properties: { name: g.pt.name || '', date: g.pt.date || '', city: fpPointCity(g.pt) }
                    });
                });
            }
            if (pointLayer) { pointLayer.setMap(null); pointLayer = null; }
            if (pointLabelLayer) { pointLabelLayer.setMap(null); pointLabelLayer = null; }
            if (pGeoms.length) {
                pointLayer = new TMap.MultiMarker({
                    map: map,
                    styles: { pt: cityMarkerStyle('#f59e0b', 12) },
                    geometries: pGeoms
                });
                pointLayer.on('click', evt => {
                    const pr = evt.geometry.properties;
                    const title = pr.name || '打卡点';
                    const meta = [pr.date ? dateCN(pr.date) : '', pr.city ? shortCity(pr.city) : '未归类城市'].filter(Boolean).join(' · ');
                    showToast('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg> ' + title + (meta ? '（' + meta + '）' : ''), 'info');
                    if (pr.city) focusCity(pr.city);
                });
                try {
                    /* 明细 Label 只画有名字的点，避免「自动记录点 #1」噪音堆叠 */
                    const named = pGeoms.filter(g => g.properties.name);
                    if (named.length) {
                        pointLabelLayer = new TMap.MultiLabel({
                            map: map,
                            styles: { pl: new TMap.LabelStyle({ color: '#b45309', size: 11, offset: { x: 0, y: -18 }, alignment: 'center', verticalAlignment: 'bottom' }) },
                            geometries: named.map(g => ({
                                id: g.id, styleId: 'pl', position: g.position, content: String(g.properties.name).slice(0, 12)
                            }))
                        });
                    }
                } catch (e) { /* 部分环境不支持 Label，忽略 */ }
            }

            /* ---- 照片数据层（v47）：独立于 layerMode/时间轴，始终按自身开关渲染 ---- */
            const photoGeoms = [];
            if (photoCfg.visible) {
                photoPts.forEach((p, i) => {
                    photoGeoms.push({
                        id: 'ph' + i, styleId: 'ph', position: new TMap.LatLng(p.lat, p.lng),
                        properties: { idx: i }
                    });
                });
            }
            if (photoLayer) { photoLayer.setMap(null); photoLayer = null; }
            if (photoInfoWin) { try { photoInfoWin.close(); } catch (e) { } photoInfoWin = null; }
            if (photoGeoms.length) {
                photoLayer = new TMap.MultiMarker({
                    map: map,
                    styles: { ph: cityMarkerStyle(photoCfg.color, 10) },
                    geometries: photoGeoms
                });
                photoLayer.on('click', evt => {
                    const p = photoPts[evt.geometry.properties.idx];
                    if (!p) return;
                    /* InfoWindow 内容用纯 DOM 构建：名称/时间走 textContent，缩略图走 img.src 属性赋值，杜绝注入 */
                    const box = document.createElement('div');
                    box.style.cssText = 'max-width:180px;padding:2px;';
                    if (p.thumb) {
                        const img = document.createElement('img');
                        img.src = p.thumb; img.alt = '';
                        img.style.cssText = 'width:100%;border-radius:6px;display:block;margin-bottom:6px;';
                        box.appendChild(img);
                    }
                    const t = document.createElement('div');
                    t.style.cssText = 'font-size:13px;font-weight:600;line-height:1.4;';
                    t.textContent = p.name || '照片点位';
                    box.appendChild(t);
                    if (p.time) {
                        const d = document.createElement('div');
                        d.style.cssText = 'font-size:11.5px;color:#64748b;margin-top:2px;';
                        d.textContent = p.time;
                        box.appendChild(d);
                    }
                    try {
                        photoInfoWin = new TMap.InfoWindow({
                            map: map, enableCustom: true, position: evt.geometry.position,
                            content: box, offset: { x: 0, y: -14 }
                        });
                        photoInfoWin.open();
                    } catch (e) { /* 个别环境不支持 InfoWindow → 忽略，点位本身不受影响 */ }
                });
            }

            const cityN = geoms.length, pointN = pGeoms.length;
            const cntEl = document.getElementById('mapCount');
            if (cntEl) {
                const parts = [];
                if (doCity) parts.push(cityN + ' 座城市');
                if (doPoint) parts.push(pointN + ' 个打卡点');
                if (photoCfg.visible && photoGeoms.length) parts.push(photoGeoms.length + ' 张照片');
                cntEl.textContent = parts.length ? (parts.join(' · ') + ' · ' + (fp.points.length) + ' 个点') : '—';
            }
            if (renderMapData._reapply) { fpRestoreView(keepView); renderMapData._reapply = false; }
            else { autoFit(fp.points); }
            tlSetup();   // 回放控制条随地图数据刷新（地图未就绪时内部自会隐藏）
        }
        /* 供切换器调用：重绘并保持视野、同步 chip 高亮 */
        function setLayerMode(m) {
            if (m !== 'city' && m !== 'point' && m !== 'both') return;
            if (tlPlaying) tlStop();
            layerMode = m;
            document.querySelectorAll('#layerCtl .fp-chip').forEach(c => c.classList.toggle('active', c.dataset.layer === m));
            renderMapData._reapply = true;
            renderMapData();
        }

        /* ---------- 底图切换（腾讯 GL 原生 setBaseMap）----------
           依据：腾讯位置服务 JS API GL 参考手册 —— `map.setBaseMap(baseMap)` 动态设置底图，
           支持 VectorBaseMap（type:'vector'）/ SatelliteBaseMap（type:'satellite'）/ TrafficBaseMap（type:'traffic'），
           亦可用数组叠加多种底图。二者均支持 `features` 数组精细控制渲染要素：
             vector   features 可取：base(道路及底面) / building3d / building2d / point(POI文字) / label(道路文字) / arrow(道路箭头)
             satellite features 可取：base(卫星影像) / road(路网图，含文字注记)
           故五档全部走原生能力，不需自绘瓦片层（零依赖、零回归风险）：
             road      全要素矢量道路底图（默认）
             minimal   仅道路+箭头 → 去 POI/文字/建筑，足迹光点最突出，最适合回看
             satellite 卫星影像去注记（突出足迹光点）
             satroad   卫星影像叠加路网线（野外打卡定位更清楚）
             traffic   道路 + 实时路况
           选择存入 db.settings.mapTileCfg.preset（经 /api/map-config，与「位置轨迹」设置页共用一份配置）；
           仅写 preset，**不动 urlTemplate/subs**，以免影响 location 页的瓦片源。
           任何异常一律 fail-soft：捕获后保留原底图，不影响标记与其它功能。 */
        const FP_BASE_MAP = {
            road: () => ({ type: 'vector' }),
            minimal: () => ({ type: 'vector', features: ['base', 'arrow'] }),
            satellite: () => ({ type: 'satellite', features: ['base'] }),
            satroad: () => ({ type: 'satellite', features: ['base', 'road'] }),
            traffic: () => ([{ type: 'vector' }, { type: 'traffic' }])
        };
        function setBaseMapMode(m, persist) {
            if (!FP_BASE_MAP[m]) return;
            baseMode = m;
            document.querySelectorAll('#baseCtl .fp-chip').forEach(c => c.classList.toggle('active', c.dataset.base === m));
            if (map && mapReady) {
                try { map.setBaseMap(FP_BASE_MAP[m]()); }
                catch (e) { /* 个别环境不支持该底图类型 → 保持原底图 */ }
            }
            /* persist !== false 时写回共享配置（仅记 preset，不动 urlTemplate/sub 以免影响 location 页瓦片源） */
            if (persist !== false && map && mapReady) {
                apiGet('/api/map-config').then(cfg => {
                    const cur = (cfg && cfg.data) || {};
                    return apiPut('/api/map-config', {
                        preset: m,
                        urlTemplate: cur.urlTemplate || '',
                        subs: cur.subs || '1234'
                    });
                }).catch(() => { /* 配置写入失败不影响本页底图 */ });
            }
        }

        /* ---------- 照片数据配置（v47）：显示开关 + 颜色选择 ----------
           与服务端 PHOTO_COLORS 白名单保持一致（服务端二次校验，前端只做展示）。 */
        const PHOTO_COLORS = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#14b8a6', '#3b82f6', '#a855f7', '#64748b'];
        /* 同步配置行 UI（chip 高亮 + 色点选中态）；loadAll 拿到 cfg 后与变更后各调一次 */
        function syncPhotoCtl() {
            const tog = document.getElementById('photoToggle');
            if (tog) tog.classList.toggle('active', !!photoCfg.visible);
            const row = document.getElementById('photoColors');
            if (row && !row.childElementCount) {
                PHOTO_COLORS.forEach(c => {
                    const b = document.createElement('button');
                    b.type = 'button'; b.className = 'fp-dot';
                    /* 用 backgroundColor 长属性：background 简写会内联重置 background-clip 为 border-box，导致 CSS 的 content-box 裁切失效 */
                    b.style.backgroundColor = c; b.dataset.color = c;
                    b.title = '照片点位颜色 ' + c;
                    b.setAttribute('aria-label', '照片点位颜色 ' + c);
                    b.addEventListener('click', () => setPhotoColor(c));
                    row.appendChild(b);
                });
            }
            if (row) row.querySelectorAll('.fp-dot').forEach(d => d.classList.toggle('active', d.dataset.color === photoCfg.color));
        }
        async function savePhotoCfg(patch) {
            photoCfg = Object.assign({}, photoCfg, patch);
            syncPhotoCtl();
            renderMapData._reapply = true;
            renderMapData();
            const r = await apiPut('/api/photo-points/cfg', patch);
            if (!r || r.code !== 200) showToast((r && r.message) || '照片显示配置保存失败', 'error');
        }
        function setPhotoVisible() { savePhotoCfg({ visible: !photoCfg.visible }); }
        function setPhotoColor(c) {
            if (!PHOTO_COLORS.includes(c) || c === photoCfg.color) return;
            savePhotoCfg({ color: c });
        }
        function autoFit(pts) {
            if (!map || !pts || !pts.length) return;
            let minLat = 90, maxLat = -90, minLng = 180, maxLng = -180;
            pts.forEach(p => {
                minLat = Math.min(minLat, p.lat); maxLat = Math.max(maxLat, p.lat);
                minLng = Math.min(minLng, p.lng); maxLng = Math.max(maxLng, p.lng);
            });
            const cLat = (minLat + maxLat) / 2, cLng = (minLng + maxLng) / 2;
            const span = Math.max(maxLat - minLat, (maxLng - minLng) * 0.75, 0.03);
            const zoom = Math.max(3, Math.min(13, Math.round(Math.log2(220 / span))));
            map.setCenter(new TMap.LatLng(cLat, cLng));
            map.setZoom(zoom);
        }

        /* ============ 时间轴回放（四·补） ============
           单个 TMap.MultiMarker 复用，每次 tick 用 setGeometries 整体替换为「已显现点」，
           已显现点累积保留 → 轨迹一点点长出来。不做连线（无真实轨迹线，连线是假路径）。
           节奏：tick 100ms，每 tick 前进 (点数/400)×速度 个点 → 1× 全程约 40 秒、4× 约 10 秒、16× 约 2.5 秒。
           降级：无 Key / 地图未就绪 / 点数 <2 → 播放条整体隐藏。 */
        function tlSetup() {
            const bar = document.getElementById('tlBar');
            if (!bar) return;
            tlStop();
            if (tlLayer) { tlLayer.setMap(null); tlLayer = null; }
            tlIdx = 0; tlPos = 0;
            // 时间轴数据：按时间升序（time 优先、date 兜底），>800 点抽样投放
            let pts = (fp.points || []).filter(p => p.lat != null && p.lng != null)
                .slice().sort((a, b) => String(a.time || a.date || '').localeCompare(String(b.time || b.date || '')));
            tlSampled = false;
            if (pts.length > 800) {
                const step = Math.ceil(pts.length / 800);
                const out = pts.filter((_, i) => i % step === 0);
                if (out[out.length - 1] !== pts[pts.length - 1]) out.push(pts[pts.length - 1]);
                pts = out;
                tlSampled = true;
            }
            tlPts = pts;
            if (!map || !mapReady || tlPts.length < 2) { bar.style.display = 'none'; return; }
            bar.style.display = 'block';
            document.getElementById('tlRange').value = '0';
            document.getElementById('tlPlayBtn').textContent = '▶';
            document.getElementById('tlStatus').textContent = '共 ' + tlPts.length + ' 个足迹（' + (tlPts[0].date || '—') + ' ~ ' + (tlPts[tlPts.length - 1].date || '—') + '）· 点 ▶ 回放' + (tlSampled ? ' · 已抽样加速' : '');
        }
        function tlEnsureLayer() {
            if (tlLayer) return;
            tlLayer = new TMap.MultiMarker({
                map: map,
                styles: { p: cityMarkerStyle('#38bdf8', 14) },
                geometries: []
            });
        }
        /* 播放前收起常规图层（城市级 + 明细点），避免「还没播就看到全部」破坏生长观感；
           结束/重置时 renderMapData() 会按当前 layerMode 复原 */
        function tlHideCityLayers() {
            if (markerLayer) { markerLayer.setMap(null); markerLayer = null; }
            if (labelLayer) { labelLayer.setMap(null); labelLayer = null; }
            if (pointLayer) { pointLayer.setMap(null); pointLayer = null; }
            if (pointLabelLayer) { pointLabelLayer.setMap(null); pointLabelLayer = null; }
        }
        function tlRender() {
            tlShownPts = tlPts.slice(0, tlIdx + 1);
            if (tlLayer) {
                tlLayer.setGeometries(tlShownPts.map((p, i) => ({
                    id: 'tl' + i, styleId: 'p', position: new TMap.LatLng(p.lat, p.lng)
                })));
            }
            const total = tlPts.length;
            document.getElementById('tlRange').value = total <= 1 ? '0' : String(Math.round(tlIdx / (total - 1) * 1000));
            const cities = new Set();
            tlShownPts.forEach(p => { if (p.city) cities.add(p.city); });
            const last = tlShownPts[tlShownPts.length - 1] || {};
            document.getElementById('tlStatus').textContent = '截至当前时点：' + cities.size + ' 城 · ' + tlShownPts.length + ' 个足迹 · ' + (last.date || '—') + (tlSampled ? ' · 已抽样加速' : '');
        }
        function tlTick() {
            tlPos += (tlPts.length / 400) * tlSpeed;   // 1× 全程 400 tick ≈ 40 秒
            tlIdx = Math.min(tlPts.length - 1, Math.floor(tlPos));
            tlRender();
            if (tlIdx >= tlPts.length - 1) tlFinish();
        }
        function tlToggle() {
            if (tlPlaying) { tlStop(); return; }
            if (!tlPts || tlPts.length < 2 || !map || !mapReady) return;
            if (tlIdx >= tlPts.length - 1) { tlIdx = 0; tlPos = 0; }   // 播完再点 → 从头开始
            tlHideCityLayers();
            tlEnsureLayer();
            tlPlaying = true;
            document.getElementById('tlPlayBtn').textContent = '⏸';
            tlTimer = setInterval(tlTick, 100);
            tlRender();
        }
        function tlStop() {
            if (tlTimer) { clearInterval(tlTimer); tlTimer = null; }
            if (tlPlaying) {
                tlPlaying = false;
                const b = document.getElementById('tlPlayBtn');
                if (b) b.textContent = '▶';
            }
        }
        function tlSeek(v) {
            tlStop();   // 拖动时自动暂停
            if (!tlPts || tlPts.length < 2 || !map || !mapReady) return;
            tlHideCityLayers();
            tlEnsureLayer();
            tlIdx = Math.max(0, Math.min(tlPts.length - 1, Math.round((+v || 0) / 1000 * (tlPts.length - 1))));
            tlPos = tlIdx;
            tlRender();
        }
        function tlSetSpeed(v) { tlSpeed = Math.max(1, +v || 1); }
        function tlReset() {
            tlStop();
            if (tlLayer) { tlLayer.setMap(null); tlLayer = null; }
            tlIdx = 0; tlPos = 0;
            renderMapData();   // 复原常规城市级标记（内部会重跑 tlSetup 重置滑块与状态行）
        }
        function tlFinish() {
            tlStop();
            if (tlLayer) { tlLayer.setMap(null); tlLayer = null; }
            tlIdx = 0; tlPos = 0;
            renderMapData();
            const st = document.getElementById('tlStatus');
            if (st) st.textContent = '回放结束 <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg> · 共 ' + fp.points.length + ' 个足迹 · ' + fp.litCityCount + ' 座城市（已复原全量视图）';
        }
        function focusCity(city) {
            if (tlPlaying) tlStop();   // 回放期间点击城市卡片 → 先停止播放
            selectedCity = city;
            renderCities();
            const el = document.querySelector('.fp-city[data-city="' + city.replace(/"/g, '\\"') + '"]');
            if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            const pt = fp.points.find(p => p.city === city);
            if (map && mapReady && pt) {
                map.setCenter(new TMap.LatLng(pt.lat, pt.lng));
                map.setZoom(11);
            }
        }

        /* ============ 手动点亮 ============ */
        function openManual() {
            myPos = null;
            document.getElementById('mCityKw').value = '';
            document.getElementById('mFirstDate').value = '';
            document.getElementById('mRemark').value = '';
            openModal('manualModal');
            citySearch('');
        }
        let cityTimer = null;
        function debouncedCitySearch() {
            clearTimeout(cityTimer);
            cityTimer = setTimeout(() => citySearch(document.getElementById('mCityKw').value.trim()), 260);
        }
        async function citySearch(kw) {
            const r = await apiGet('/api/footprint/cities?kw=' + encodeURIComponent(kw));
            const list = r.data || [];
            const box = document.getElementById('citySug');
            if (!list.length) { box.innerHTML = '<div class="empty">没有匹配的城市</div>'; return; }
            box.innerHTML = list.map(c =>
                '<div class="cs' + (c.lit ? ' lit' : '') + '" onclick="' + (c.lit ? '' : 'pickCity(\'' + c.city + '\',\'' + c.province + '\')') + '">'
                + '<span>' + escapeHtml(c.city) + '</span>'
                + '<small>' + (c.lit ? '已点亮' : escapeHtml(c.province)) + '</small></div>').join('');
        }
        function pickCity(city, province) {
            myPos = { city: city, province: province };
            document.getElementById('mCityKw').value = city;
            document.getElementById('citySug').innerHTML = '<div class="cs"><span>' + escapeHtml(city) + '</span><small>' + escapeHtml(province) + '</small></div>';
        }
        async function saveManual() {
            if (!myPos) return showToast('请先搜索并选择一个城市', 'warning');
            const r = await apiPost('/api/footprint/manual', {
                city: myPos.city, province: myPos.province,
                firstDate: document.getElementById('mFirstDate').value,
                remark: document.getElementById('mRemark').value
            });
            if (r.code !== 200) return showToast(r.message, 'error');
            closeModal('manualModal');
            showToast(r.message, 'success');
            await loadAll();
            if (map && mapReady) { autoFit(fp.points); }
        }
        async function delManual(id) {
            const okDel = await confirmModal({ title: '取消点亮', message: '确定从足迹中移除这座城市吗？（不会影响已记录的打卡数据）', confirmText: '移除' });
            if (!okDel) return;
            const r = await apiDelete('/api/footprint/manual/' + id);
            if (r.code !== 200) return showToast(r.message, 'error');
            showToast(r.message, 'success');
            await loadAll();
        }
        async function reparse() {
            const r = await apiPost('/api/footprint/reparse', {});
            if (r.code === 200) showToast(r.message, r.data && r.data.updated ? 'success' : 'info');
            await loadAll();
        }

        /* ============ 导入 / 导出（任务 #14） ============
           分工：CSV/GPX/EXIF 解析全部在前端（零依赖），服务端只收归一化点数组走白名单校验。
           入口：工具栏「导入 / 导出」按钮 + Web Share Target（?import-pending=1 取回暂存）。 */
        let ioPreviewPts = null;   // 当前预览待确认的点数组

        function openIoModal() {
            ioPreviewPts = null;
            const pv = document.getElementById('ioPreview');
            if (pv) pv.style.display = 'none';
            refreshPhotoStat();
            openModal('ioModal');
        }

        /* ---- 时间/点归一化 ---- */
        function ioFmtDate(d) {
            const p = n => String(n).padStart(2, '0');
            return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
        }
        function ioNormTime(s) {
            s = String(s || '').trim();
            if (!s) return '';
            if (/^\d{10}$/.test(s)) return ioFmtDate(new Date(+s * 1000));          // Unix 秒
            if (/^\d{13}$/.test(s)) return ioFmtDate(new Date(+s));                 // Unix 毫秒
            let d = new Date(s.indexOf('T') >= 0 ? s : s.replace(' ', 'T'));        // ISO / 本地格式
            if (isNaN(d)) d = new Date(s);
            return isNaN(d) ? '' : ioFmtDate(d);
        }
        function ioNormPoint(p) {
            return {
                lat: p.lat, lng: p.lng,
                name: String(p.name || '').slice(0, 100),
                address: String(p.address || '').slice(0, 200),
                time: p.time || '',
                province: String(p.province || '').slice(0, 50),
                city: String(p.city || '').slice(0, 50),
                district: String(p.district || '').slice(0, 50),
                remark: String(p.remark || '').slice(0, 300)
            };
        }

        /* ---- CSV 解析（宽容列名 + 引号转义 + 逗号/制表符分隔） ---- */
        function ioCsvSplit(line) {
            const sep = (line.indexOf('\t') >= 0 && line.indexOf(',') < 0) ? '\t' : ',';
            const out = []; let cur = '', q = false;
            for (let i = 0; i < line.length; i++) {
                const c = line[i];
                if (q) {
                    if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; }
                    else cur += c;
                } else if (c === '"') q = true;
                else if (c === sep) { out.push(cur); cur = ''; }
                else cur += c;
            }
            out.push(cur);
            return out;
        }
        const IO_CSV_KEYS = {
            '时间戳': 'time', '时间': 'time', 'timestamp': 'time', 'time': 'time', 'unix': 'time', 'date': 'time',
            '纬度': 'lat', 'lat': 'lat', 'latitude': 'lat',
            '经度': 'lng', 'lng': 'lng', 'lon': 'lng', 'longitude': 'lng',
            '地点': 'name', '地点名称': 'name', '名称': 'name', 'name': 'name', 'title': 'name', '标题': 'name',
            '地址': 'address', 'address': 'address',
            '省': 'province', '省份': 'province', 'province': 'province',
            '市': 'city', '城市': 'city', 'city': 'city',
            '区': 'district', '区县': 'district', 'district': 'district',
            '心情': 'mood', 'mood': 'mood',
            '天气': 'weather', 'weather': 'weather',
            '备注': 'remark', 'note': 'remark', 'remark': 'remark', '说明': 'remark'
        };
        function ioParseCsv(text) {
            const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/).filter(l => l.trim());
            if (!lines.length) return [];
            const head0 = ioCsvSplit(lines[0]).map(h => String(h || '').trim().toLowerCase().replace(/[\s_]/g, ''));
            let map, start;
            if (head0.some(h => IO_CSV_KEYS[h])) {                    // 表头行（中英混排皆可）
                map = head0.map(h => IO_CSV_KEYS[h] || null);
                start = 1;
            } else {                                                  // 无表头：按一生足迹列序兜底
                map = ['time', 'lat', 'lng', 'name', 'address', 'province', 'city', 'district', 'mood', 'weather', 'remark'];
                start = 0;
            }
            const pts = [];
            for (let i = start; i < lines.length; i++) {
                const cells = ioCsvSplit(lines[i]);
                const o = {};
                map.forEach((k, idx) => { if (k) o[k] = (cells[idx] || '').trim(); });
                const lat = +o.lat, lng = +o.lng;
                if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;   // 坐标非法的行丢弃（服务端还会再校验开区间）
                pts.push(ioNormPoint({ lat, lng, name: o.name, address: o.address, time: ioNormTime(o.time), province: o.province, city: o.city, district: o.district, remark: o.remark }));
            }
            return pts;
        }

        /* ---- GPX 解析（DOMParser，标准 1.1：trkpt，兼容 rtept/wpt） ---- */
        function ioParseGpx(text) {
            try {
                const doc = new DOMParser().parseFromString(String(text || ''), 'text/xml');
                if (doc.querySelector('parsererror')) return [];
                let nodes = doc.querySelectorAll('trkpt');
                if (!nodes.length) nodes = doc.querySelectorAll('rtept');
                if (!nodes.length) nodes = doc.querySelectorAll('wpt');
                const out = [];
                nodes.forEach(pt => {
                    const lat = +pt.getAttribute('lat'), lng = +pt.getAttribute('lng');
                    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
                    const tEl = pt.querySelector('time'), nEl = pt.querySelector('name'), rEl = pt.querySelector('desc') || pt.querySelector('cmt');
                    out.push(ioNormPoint({
                        lat, lng,
                        name: nEl ? nEl.textContent : '',
                        time: ioNormTime(tEl ? tEl.textContent : ''),
                        remark: rEl ? rEl.textContent : ''
                    }));
                });
                return out;
            } catch (e) { return []; }
        }
        function ioParseText(text, filename) {
            if (/\.gpx$/i.test(String(filename || ''))) return ioParseGpx(text);
            const pts = ioParseCsv(text);
            if (!pts.length && /^\s*(<\?xml|<gpx)/i.test(String(text || ''))) return ioParseGpx(text);
            return pts;
        }

        /* ---- EXIF GPS 解析（纯 DataView，JPEG → APP1 → TIFF → IFD0 → GPS IFD） ----
           返回 {lat, lng, time}（十进制度，南纬/西经为负；time 为 DateTimeOriginal）或 null。 */
        function parseExifGps(buf) {
            try {
                const v = new DataView(buf);
                if (v.byteLength < 12 || v.getUint16(0) !== 0xFFD8) return null;   // 非 JPEG（SOI 缺失）
                let off = 2, tiff = -1;
                while (off + 4 <= v.byteLength) {
                    const marker = v.getUint16(off);
                    if ((marker & 0xFF00) !== 0xFF00) return null;
                    if (marker === 0xFFE1 && v.getUint32(off + 4) === 0x45786966) { tiff = off + 10; break; }   // APP1 'Exif'
                    off += 2 + v.getUint16(off + 2);
                    if (marker === 0xFFDA) break;   // 进入图像数据，后面不会有 EXIF
                }
                if (tiff < 0 || tiff + 8 > v.byteLength) return null;
                const little = v.getUint16(tiff) === 0x4949;                        // 'II' 小端 / 'MM' 大端
                /* 魔数 0x2A 必须按 TIFF 自身端序读：II 存为 2A 00，MM 存为 00 2A */
                if (v.getUint16(tiff + 2, little) !== 0x2A) return null;
                const u16 = o => v.getUint16(o, little), u32 = o => v.getUint32(o, little);
                const ifd0 = tiff + u32(tiff + 4);
                if (ifd0 + 2 > v.byteLength) return null;
                let gpsOff = -1, exifOff = -1;
                const n0 = u16(ifd0);
                for (let i = 0; i < n0; i++) {
                    const e = ifd0 + 2 + i * 12;
                    if (e + 12 > v.byteLength) break;
                    const tag = u16(e);
                    if (tag === 0x8825) gpsOff = tiff + u32(e + 8);
                    else if (tag === 0x8769) exifOff = tiff + u32(e + 8);
                }
                const dms = (base, cnt) => {
                    const r = [];
                    for (let i = 0; i < cnt; i++) {
                        const num = u32(base + i * 8), den = u32(base + i * 8 + 4);
                        r.push(den ? num / den : 0);
                    }
                    return r[0] + (r[1] || 0) / 60 + (r[2] || 0) / 3600;
                };
                let lat = null, lng = null, time = '';
                if (gpsOff > 0 && gpsOff + 2 <= v.byteLength) {
                    let latRef = 'N', lngRef = 'E';
                    const gn = u16(gpsOff);
                    for (let i = 0; i < gn; i++) {
                        const e = gpsOff + 2 + i * 12;
                        if (e + 12 > v.byteLength) break;
                        const tag = u16(e), type = u16(e + 2), cnt = u32(e + 4);
                        /* ASCII ≤4 字节内联在 entry 里，否则为偏移；RATIONAL 8 字节必为偏移 */
                        const valOff = (type === 2 && cnt <= 4) ? e + 8 : tiff + u32(e + 8);
                        if (tag === 1 && type === 2) latRef = String.fromCharCode(v.getUint8(valOff));
                        else if (tag === 2 && type === 5 && valOff + 24 <= v.byteLength) lat = dms(valOff, 3);
                        else if (tag === 3 && type === 2) lngRef = String.fromCharCode(v.getUint8(valOff));
                        else if (tag === 4 && type === 5 && valOff + 24 <= v.byteLength) lng = dms(valOff, 3);
                    }
                    if (lat != null && latRef === 'S') lat = -lat;
                    if (lng != null && lngRef === 'W') lng = -lng;
                }
                if (exifOff > 0 && exifOff + 2 <= v.byteLength) {   // 顺带取拍摄时间（DateTimeOriginal 0x9003）
                    const en = u16(exifOff);
                    for (let i = 0; i < en; i++) {
                        const e = exifOff + 2 + i * 12;
                        if (e + 12 > v.byteLength) break;
                        if (u16(e) !== 0x9003 || u16(e + 2) !== 2) continue;
                        const cnt = u32(e + 4);
                        const o = cnt <= 4 ? e + 8 : tiff + u32(e + 8);
                        let s = '';
                        for (let k = 0; k < Math.min(cnt, 20) && o + k < v.byteLength; k++) { const c = v.getUint8(o + k); if (!c) break; s += String.fromCharCode(c); }
                        const m = s.match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}:\d{2}:\d{2})/);
                        if (m) time = m[1] + '-' + m[2] + '-' + m[3] + ' ' + m[4];
                    }
                }
                if (lat == null || lng == null) return parseXmpGps(buf);   /* EXIF 无 GPS → XMP 兜底 */
                return { lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6, time };
            } catch (e) { return null; }
        }

        /* ---- XMP 兜底：部分国产手机 GPS 只写进 XMP（EXIF GPS IFD 为空）。
           XMP 是 APP1 里的 XML 文本，形如 exif:GPSLatitude="39,54.252N"（度,分）或
           <exif:GPSLatitude>39,54,15.12N</exif:GPSLatitude>（度,分,秒）。只在解析失败路径上
           扫前 256KB（latin1 分块转字符串），成本可接受。 ---- */
        function parseXmpGps(buf) {
            try {
                const bytes = new Uint8Array(buf, 0, Math.min(buf.byteLength, 262144));
                let s = '';
                for (let i = 0; i < bytes.length; i += 8192) {
                    s += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + 8192, bytes.length)));
                }
                if (s.indexOf('GPSLatitude') < 0) return null;
                const grab = tag => {
                    const re = new RegExp(tag + '[\\s>=]*"?\\s*([0-9]+)[,\\s°]\\s*([0-9.]+)(?:[,\\s\'′]\\s*([0-9.]+))?\\s*([NSEWnsew])');
                    const m = s.match(re);
                    if (!m) return null;
                    return { v: (+m[1]) + (+m[2]) / 60 + (m[3] ? (+m[3]) / 3600 : 0), ref: m[4].toUpperCase() };
                };
                const la = grab('GPSLatitude'), lo = grab('GPSLongitude');
                if (!la || !lo) return null;
                let lat = la.v, lng = lo.v;
                if (la.ref === 'S') lat = -lat;
                if (lo.ref === 'W') lng = -lng;
                let time = '';
                const tm = s.match(/CreateDate[\s>=]*"?\s*(\d{4})-(\d{2})-(\d{2})[T ](\d{2}:\d{2}:\d{2})/);
                if (tm) time = tm[1] + '-' + tm[2] + '-' + tm[3] + ' ' + tm[4];
                return { lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6, time };
            } catch (e) { return null; }
        }
        /* 失败诊断：扫前 256KB，报告文件里是否还留有 EXIF / XMP GPS 痕迹（区分「被剥光」与「有 EXIF 无定位」） */
        function ioScanMeta(buf) {
            try {
                const bytes = new Uint8Array(buf, 0, Math.min(buf.byteLength, 262144));
                let s = '';
                for (let i = 0; i < bytes.length; i += 8192) {
                    s += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + 8192, bytes.length)));
                }
                return { hasExif: s.indexOf('Exif') >= 0, hasXmpGps: s.indexOf('GPSLatitude') >= 0 };
            } catch (e) { return { hasExif: false, hasXmpGps: false }; }
        }

        /* ---- 照片选择：EXIF 有 GPS 的进预览，其余分类计数跳过；照片本体不上传 ---- */
        let ioPhotoSkip = { noGps: 0, heic: 0, unreadable: 0 };
        function ioMakeThumb(file) {
            return new Promise(resolve => {
                let url = '';
                try {
                    url = URL.createObjectURL(file);
                    const img = new Image();
                    img.onload = () => {
                        try {
                            const c = document.createElement('canvas');
                            const s = Math.min(96 / img.width, 96 / img.height, 1);
                            c.width = Math.max(1, Math.round(img.width * s));
                            c.height = Math.max(1, Math.round(img.height * s));
                            c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
                            resolve(c.toDataURL('image/jpeg', 0.7));
                        } catch (e) { resolve(''); }
                        finally { URL.revokeObjectURL(url); }
                    };
                    img.onerror = () => { URL.revokeObjectURL(url); resolve(''); };
                    img.src = url;
                } catch (e) { if (url) URL.revokeObjectURL(url); resolve(''); }
            });
        }
        /* 识别 HEIC/HEIF：ISO BMFF 容器，第 4 字节起为 'ftyp' + 品牌（heic/heix/mif1 等）。
           iPhone 默认拍照格式，无 EXIF JPEG 结构，本解析器不支持（零依赖约束下不引 HEIC 解码库）。 */
        function ioIsHeic(buf) {
            try {
                if (buf.byteLength < 12) return false;
                const v = new DataView(buf);
                if (v.getUint32(4) !== 0x66747970) return false;   // 'ftyp'
                const brand = String.fromCharCode(v.getUint8(8), v.getUint8(9), v.getUint8(10), v.getUint8(11));
                return /^(heic|heix|hevc|hevx|mif1|msf1|heif)$/.test(brand);
            } catch (e) { return false; }
        }
        async function ioPhotoPick(input) {
            const files = Array.prototype.slice.call(input.files || []);
            input.value = '';
            if (!files.length) return;
            ioPhotoSkip = { noGps: 0, stripped: 0, heic: 0, unreadable: 0 };
            const pts = [];
            for (const f of files) {
                const buf = await f.arrayBuffer();
                let isJpeg = false;
                try { isJpeg = new DataView(buf).getUint16(0) === 0xFFD8; } catch (e) { }
                const ex = parseExifGps(buf);
                if (!ex) {
                    if (isJpeg) {
                        /* JPEG 却读不到定位：再看文件里 EXIF 痕迹是否还在，区分「选择器剥光」与「相机没记定位」 */
                        const meta = ioScanMeta(buf);
                        if (!meta.hasExif && !meta.hasXmpGps) ioPhotoSkip.stripped++;
                        else ioPhotoSkip.noGps++;
                    }
                    else if (ioIsHeic(buf)) ioPhotoSkip.heic++;
                    else ioPhotoSkip.unreadable++;
                    continue;
                }
                pts.push(ioNormPoint({
                    lat: ex.lat, lng: ex.lng,
                    name: f.name.replace(/\.[^.]+$/, ''),
                    time: ex.time
                }));
                pts[pts.length - 1].thumb = await ioMakeThumb(f);
            }
            /* 分类给出可操作原因，避免一句「无 GPS」让用户无从下手 */
            const skipParts = [];
            if (ioPhotoSkip.stripped) skipParts.push(ioPhotoSkip.stripped + ' 张的 EXIF 已被选图环节剥掉（安卓：请改用本弹窗的「文件选照片」，从 内部存储/DCIM/Camera 直选原图——相册缩略图选择器会剥掉定位；云同步照片请先从云端下载原图；iPhone：选图页点「选项」开「所有照片数据」）');
            if (ioPhotoSkip.noGps) skipParts.push(ioPhotoSkip.noGps + ' 张文件里有 EXIF 但没有定位字段（相机没记录位置：请在相机设置里开启「保存地理位置/记录位置」，微信/QQ 转发或截图的照片也没有定位）');
            if (ioPhotoSkip.heic) skipParts.push(ioPhotoSkip.heic + ' 张是 HEIC 格式（暂不支持：可在 iPhone「设置 → 相机 → 格式」选「兼容性最佳」后再拍，或分享时选 JPEG）');
            if (ioPhotoSkip.unreadable) skipParts.push(ioPhotoSkip.unreadable + ' 张不是 JPEG，无法解析');
            const skipMsg = skipParts.join('；');
            if (!pts.length) return showToast('所选照片均未识别出 GPS 定位。' + skipMsg, 'warning');
            if (skipMsg) showToast(skipMsg, 'info');
            ioSetPreview(pts, '照片定位导入', 'photo');
        }

        /* ---- 照片数据：从文件导入（本功能导出的 JSON 回导）/ 清空 / 统计 ---- */
        async function ioPhotoFilePick(input) {
            const f = input.files && input.files[0];
            input.value = '';
            if (!f) return;
            if (f.size > 20 * 1024 * 1024) return showToast('文件超过 20MB 限制', 'warning');
            let j = null;
            try { j = JSON.parse(await f.text()); } catch (e) { return showToast('文件不是有效的 JSON', 'error'); }
            const arr = Array.isArray(j) ? j : (j && Array.isArray(j.points) ? j.points : null);
            if (!arr || !arr.length) return showToast('文件中没有照片点位数据', 'warning');
            ioSetPreview(arr, '文件导入：' + f.name, 'photo');
        }
        async function ioPhotoClear() {
            if (!photoPts.length) return showToast('当前没有照片点位', 'info');
            // UI 评审 P0-2：与全站确认交互统一（Promise + 焦点圈 + Esc + 主题色）
            const msg = '确定清空全部 ' + photoPts.length + ' 条照片点位吗？此操作不可恢复（轨迹数据不受影响）。';
            const ok = await confirmModal({ title: '清空照片点位', message: msg, confirmText: '确认清空' });
            if (!ok) return;
            const r = await apiPost('/api/photo-points/clear', {});
            if (r.code !== 200) return showToast(r.message || '清空失败', 'error');
            showToast(r.message || '已清空', 'success');
            closeModal('ioModal');
            await loadAll();
        }
        /* 管理弹窗统计行（打开弹窗与导入后刷新） */
        function refreshPhotoStat() {
            const el = document.getElementById('photoStat');
            if (el) el.textContent = photoPts.length ? '已记录 ' + photoPts.length + ' 条照片点位' : '还没有照片点位，先导入一批吧';
        }

        /* ---- 预览与提交 ---- */
        let ioPreviewMode = 'track';   // track（CSV/GPX → 轨迹点）| photo（照片 EXIF/JSON → 照片数据层）
        function ioSetPreview(pts, from, mode) {
            ioPreviewMode = mode === 'photo' ? 'photo' : 'track';
            pts = (pts || []).filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lng)).slice(0, 5000);
            ioPreviewPts = pts;
            const box = document.getElementById('ioPreview');
            if (!box) return;
            if (!pts.length) {
                box.style.display = 'block';
                box.innerHTML = '<div style="color:var(--text-secondary);font-size:12.5px;">未解析出有效点位（需含纬度/经度）</div>';
                return;
            }
            const times = pts.map(p => p.time).filter(Boolean).sort();
            const dates = {};
            pts.forEach(p => { dates[(p.time || '').slice(0, 10) || '—'] = 1; });
            const isPhoto = ioPreviewMode === 'photo';
            const rows = pts.slice(0, 5).map(p =>
                '<tr>'
                + (isPhoto ? '<td style="padding:4px 6px;border-bottom:1px dashed var(--border-color);width:40px;">'
                    + (p.thumb ? '<img src="' + p.thumb + '" alt="" style="width:32px;height:32px;object-fit:cover;border-radius:4px;display:block;">' : '')
                    + '</td>' : '')
                + '<td style="padding:4px 6px;border-bottom:1px dashed var(--border-color);">' + escapeHtml(p.name || '（未命名）') + '</td>'
                + '<td style="padding:4px 6px;border-bottom:1px dashed var(--border-color);">' + p.lat.toFixed(5) + ', ' + p.lng.toFixed(5) + '</td>'
                + '<td style="padding:4px 6px;border-bottom:1px dashed var(--border-color);">' + escapeHtml(p.time || '—') + '</td>'
                + (isPhoto ? '' : '<td style="padding:4px 6px;border-bottom:1px dashed var(--border-color);">' + escapeHtml(p.city || '自动识别') + '</td>')
                + '</tr>').join('');
            const summary = isPhoto
                ? '共 <b style="color:var(--primary);">' + pts.length + '</b> 张照片点位 · 时间范围 '
                  + (times.length ? escapeHtml(times[0].slice(0, 10)) + ' ~ ' + escapeHtml(times[times.length - 1].slice(0, 10)) : '—')
                  + ' · 导入后作为独立图层显示（不生成轨迹）'
                : '共 <b style="color:var(--primary);">' + pts.length + '</b> 个点 · 时间范围 '
                  + (times.length ? escapeHtml(times[0].slice(0, 10)) + ' ~ ' + escapeHtml(times[times.length - 1].slice(0, 10)) : '—')
                  + ' · 将按日期分组到 <b>' + Object.keys(dates).length + '</b> 个行程';
            box.style.display = 'block';
            box.innerHTML = '<div style="font-size:13px;font-weight:600;margin-bottom:6px;">导入预览（来源：' + escapeHtml(from || '—') + '）</div>'
                + '<div style="font-size:12.5px;color:var(--text-secondary);line-height:1.8;">' + summary + '</div>'
                + '<table style="width:100%;font-size:12px;margin-top:8px;border-collapse:collapse;">'
                + '<thead><tr>' + (isPhoto ? '<th style="text-align:left;padding:4px 6px;border-bottom:1px solid var(--border-color);"></th>' : '')
                + '<th style="text-align:left;padding:4px 6px;border-bottom:1px solid var(--border-color);">' + (isPhoto ? '照片名' : '地点') + '</th>'
                + '<th style="text-align:left;padding:4px 6px;border-bottom:1px solid var(--border-color);">坐标</th>'
                + '<th style="text-align:left;padding:4px 6px;border-bottom:1px solid var(--border-color);">时间</th>'
                + (isPhoto ? '' : '<th style="text-align:left;padding:4px 6px;border-bottom:1px solid var(--border-color);">城市</th>') + '</tr></thead>'
                + '<tbody>' + rows + '</tbody></table>'
                + (pts.length > 5 ? '<div style="font-size:11.5px;color:var(--text-secondary);margin-top:4px;">…仅展示前 5 条</div>' : '')
                + '<button class="btn btn-primary btn-sm" id="ioConfirmBtn" style="margin-top:10px;" onclick="confirmIoImport()">确认导入 ' + pts.length + (isPhoto ? ' 张照片点位' : ' 个点') + '</button>';
        }
        async function confirmIoImport() {
            if (!ioPreviewPts || !ioPreviewPts.length) return showToast('请先解析出要导入的点', 'warning');
            const btn = document.getElementById('ioConfirmBtn');
            if (btn) { btn.disabled = true; btn.textContent = '导入中…'; }
            const total = ioPreviewPts.length;
            try {
                if (ioPreviewMode === 'photo') {
                    /* 照片数据：分批 100 投 /api/photo-points/import（含 base64 缩略图，控制单包体积） */
                    let added = 0, skipped = 0, invalid = 0;
                    for (let i = 0; i < ioPreviewPts.length; i += 100) {
                        const batch = ioPreviewPts.slice(i, i + 100).map(p => ({ lat: p.lat, lng: p.lng, name: p.name, time: p.time, thumb: p.thumb || '' }));
                        const r = await apiPost('/api/photo-points/import', { points: batch });
                        if (r.code !== 200) return showToast(r.message || '导入失败', 'error');
                        added += r.data.added; skipped += r.data.skipped; invalid += r.data.invalid;
                        if (btn) btn.textContent = '导入中… ' + Math.min(i + 100, total) + '/' + total;
                    }
                    showToast('照片点位导入完成：新增 ' + added + ' 条' + (skipped ? '，跳过重复/超限 ' + skipped + ' 条' : '') + (invalid ? '，无效 ' + invalid + ' 条' : ''), 'success');
                } else {
                    const points = ioPreviewPts.map(p => ({
                        lat: p.lat, lng: p.lng, name: p.name, address: p.address, time: p.time,
                        province: p.province, city: p.city, district: p.district, remark: p.remark
                    }));
                    const r = await apiPost('/api/footprint/import', { points });
                    if (r.code !== 200) return showToast(r.message || '导入失败', 'error');
                    showToast(r.message || '导入成功', 'success');
                }
                ioPreviewPts = null;
                const pv = document.getElementById('ioPreview');
                if (pv) pv.style.display = 'none';
                closeModal('ioModal');
                await loadAll();
            } finally {
                if (btn) { btn.disabled = false; btn.textContent = '确认导入 ' + total + (ioPreviewMode === 'photo' ? ' 张照片点位' : ' 个点'); }
            }
        }

        /* ---- 入口：文件 / 粘贴 ---- */
        async function ioFilePick(input) {
            const f = input.files && input.files[0];
            input.value = '';
            if (!f) return;
            if (f.size > 2 * 1024 * 1024) return showToast('文件超过 2MB 限制', 'warning');
            const text = await f.text();
            const pts = ioParseText(text, f.name);
            ioSetPreview(pts, f.name);
        }
        function ioPasteParse() {
            const t = document.getElementById('ioPaste').value || '';
            const isGpx = /^\s*(<\?xml|<gpx)/i.test(t);
            const pts = ioParseText(t, isGpx ? 'paste.gpx' : 'paste.csv');
            ioSetPreview(pts, '粘贴文本');
        }

        /* ---- Web Share Target 回流：?import-pending=1 → 取回暂存 → 预览 ---- */
        async function handleShareImport() {
            try {
                const sp = new URLSearchParams(location.search);
                const flag = sp.get('import-pending');
                if (!flag) return;
                history.replaceState(null, '', '/footprint');   // 清参防刷新重取
                if (flag === 'too-large') return showToast('分享的文件超过 2MB 限制，无法导入', 'error');
                if (flag === 'empty') return showToast('分享内容为空，未导入', 'warning');
                if (flag !== '1') return;
                const r = await apiGet('/api/footprint/import-pending');
                const d = r && r.data;
                if (!d || !d.content) return showToast('暂存的分享内容已失效或被取用', 'info');
                const pts = ioParseText(d.content, d.filename || '');
                openIoModal();
                ioSetPreview(pts, '系统分享：' + (d.filename || '文件'));
            } catch (e) { /* fail-soft：回流失败不影响页面 */ }
        }

        /* ============ 年度报告 ============ */
        async function openAnnual(year) {
            const years = [];
            const cur = new Date().getFullYear();
            for (let y = cur; y >= cur - 6; y--) years.push(y);
            const sel = document.getElementById('anYear');
            if (!sel.options.length) sel.innerHTML = '<option value="all">全部年份</option>'
                + years.map(y => '<option value="' + y + '">' + y + ' 年</option>').join('');
            const y = year || cur;   // 显式传参优先；默认仍为当年（原行为不变），「全部年份」可手动选择
            sel.value = String(y);
            const r = await apiGet('/api/footprint/annual?year=' + y);
            if (r.code !== 200) return showToast(r.message, 'error');
            const d = r.data;
            if (!d.trackCount && !d.newCities.length) {
                const annualBody = document.getElementById('annualBody');
                annualBody.innerHTML = '';
                annualBody.appendChild(uiEmpty({
                    size: 'block', icon: EMPTY_ICO.chart,
                    title: y === 'all' ? '还没有足迹' : y + ' 年还没有足迹',
                    text: '换个年份看看，或者去记录新的行程'
                }));
                openModal('annualModal');
                return;
            }
            const maxM = Math.max(1, ...d.byMonth.map(m => m.pointCount));
            const isAll = y === 'all';
            /* 'all' 模式按年柱状（month 字段为 4 位年份）；按年模式仍为 12 个月 */
            const months = (() => {
                if (isAll) return d.byMonth.map(m =>
                    '<div class="an-month"><i style="height:' + Math.round((m.pointCount || 0) / maxM * 100) + '%"></i><span>' + escapeHtml(m.month) + '</span></div>').join('');
                const map = {}; d.byMonth.forEach(m => { map[+m.month.slice(5)] = m; });
                let out = '';
                for (let i = 1; i <= 12; i++) out += '<div class="an-month"><i style="height:' + Math.round((map[i] ? map[i].pointCount : 0) / maxM * 100) + '%"></i><span>' + i + '</span></div>';
                return out;
            })();
            const heroTitle = isAll ? '<div class="yr">「一生」</div><div class="sub">全部足迹报告</div>' : '<div class="yr">' + y + '</div><div class="sub">年度足迹报告</div>';
            const heroLine = isAll
                ? '<div class="line">从 <b>' + escapeHtml(d.firstDate || '—') + '</b> 到今天，你走过 <b>' + d.cityCount + '</b> 座城市，跨越 <b>' + d.provinceCount + '</b> 个省份，'
                    + '留下 <b>' + d.pointCount + '</b> 个足迹，行程约 <b>' + fmtDist(d.distance) + '</b>。</div>'
                : '<div class="line">这一年，你走过 <b>' + d.cityCount + '</b> 座城市，跨越 <b>' + d.provinceCount + '</b> 个省份，'
                    + '留下 <b>' + d.pointCount + '</b> 个足迹，行程约 <b>' + fmtDist(d.distance) + '</b>。</div>';
            document.getElementById('annualBody').innerHTML =
                '<div class="an-hero">' + heroTitle + heroLine + '</div>'
                + '<div class="an-nums">'
                + '<div class="an-num"><div class="v">' + d.trackCount + '</div><div class="l">行程</div></div>'
                + '<div class="an-num"><div class="v">' + d.cityCount + '</div><div class="l">到访城市</div></div>'
                + '<div class="an-num"><div class="v">' + d.newCities.length + '</div><div class="l">新点亮</div></div>'
                + '<div class="an-num"><div class="v">' + fmtDist(d.distance) + '</div><div class="l">里程</div></div>'
                + '<div class="an-num"><div class="v">' + d.photoCount + '</div><div class="l">照片</div></div>'
                + '</div>'
                + (d.newCities.length ? '<div class="an-sec-title">🆕 ' + (isAll ? '历年来新点亮的城市' : '今年新点亮的城市') + '</div><div class="an-chips">'
                    + d.newCities.map(c => '<span class="an-chip">' + escapeHtml(shortCity(c.city)) + '</span>').join('') + '</div>' : '')
                + (d.provinces.length ? '<div class="an-sec-title"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="3" y1="22" x2="21" y2="22"/><line x1="6" y1="18" x2="6" y2="11"/><line x1="10" y1="18" x2="10" y2="11"/><line x1="14" y1="18" x2="14" y2="11"/><line x1="18" y1="18" x2="18" y2="11"/><polygon points="12 2 20 7 4 7"/></svg> 踏足的省份</div><div class="an-chips">'
                    + d.provinces.map(p => '<span class="an-chip">' + escapeHtml(shortCity(p.name)) + ' · ' + p.count + '</span>').join('') + '</div>' : '')
                + '<div class="an-sec-title"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg> ' + (isAll ? '历年足迹' : '各月足迹') + '</div><div class="an-months">' + months + '</div>'
                + (d.topPlaces.length ? '<div class="an-sec-title"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/></svg> 去得最多的地方</div><div class="an-list">'
                    + d.topPlaces.map(p => '<div class="an-item"><strong>' + escapeHtml(p.name) + '</strong><span>' + p.count + ' 次</span></div>').join('') + '</div>' : '')
                + (d.byMood.length ? '<div class="an-sec-title"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg> 心情分布</div><div class="an-chips">'
                    + d.byMood.map(m => '<span class="an-chip">' + escapeHtml(m.name) + ' ' + m.count + '</span>').join('') + '</div>' : '')
                + (d.latest.length ? '<div class="an-sec-title"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg> 最近的行程</div><div class="an-list">'
                    + d.latest.map(t => '<div class="an-item"><strong>' + escapeHtml(t.title) + '</strong><span>' + t.date + ' · ' + t.pointCount + ' 点</span></div>').join('') + '</div>' : '');
            window.__annual = d;
            openModal('annualModal');
        }
        /* ============ 条1：年度报告分享卡（canvas 纯前端绘制） ============
           只画文字/图形，绝不把照片画进 canvas（跨域照片会污染画布导致 toBlob 失败）。
           mode='card'：1080×动态高（不足 1400 取 1400，上限 1920）；mode='wallpaper'：1080×2340，
           字号约 1.5 倍 + 更大留白 + 底部装饰性轨迹点线。 */
        function renderAnnualCard(d, mode) {
            if (!d) return;
            const WALL = mode === 'wallpaper';
            const K = WALL ? 1.5 : 1;                 // 壁纸字号倍率
            const W = 1080;
            const PAD = WALL ? 110 : 72;              // 壁纸更大留白
            const FONT = '"PingFang SC","Microsoft YaHei",sans-serif';
            const G0 = 34 * K;                        // 基础段间距（壁纸模式的间距拉伸按它估算）
            const C_ACC1 = '#818cf8', C_ACC2 = '#38bdf8';
            const C_TXT = '#f1f5f9', C_SUB = 'rgba(226,232,240,.72)', C_FAINT = 'rgba(226,232,240,.55)';
            const isAll = d.year === 'all';
            const bigTitle = isAll ? '一生足迹' : String(d.year);
            const subTitle = isAll ? '全部足迹报告' : d.year + ' 年度足迹报告';
            const summary = '走过 ' + d.cityCount + ' 座城市 · 跨越 ' + d.provinceCount + ' 个省份 · 留下 ' + d.pointCount + ' 个足迹 · 行程约 ' + fmtDist(d.distance);
            const nums = [
                { v: String(d.trackCount), l: '行程' },
                { v: String(d.cityCount), l: '到访城市' },
                { v: String(d.newCities.length), l: '新点亮' },
                { v: fmtDist(d.distance), l: '里程' },
                { v: String(d.photoCount), l: '照片' }
            ];
            const chips = d.newCities.slice(0, 18).map(c => shortCity(c.city));
            const chipsMore = d.newCities.length - chips.length;   // 超出 18 个时「…等 N 座」
            const bars = isAll ? d.byMonth.slice(-14) : (() => {   // 'all' 按年柱状（最多近 14 年）
                const map = {}; d.byMonth.forEach(m => { map[+m.month.slice(5)] = m; });
                const out = [];
                for (let i = 1; i <= 12; i++) out.push({ month: String(i), pointCount: map[i] ? map[i].pointCount : 0 });
                return out;
            })();
            const places = d.topPlaces.slice(0, 5);

            function rr(ctx, x, y, w, h, r) {        // 圆角矩形路径（不依赖 ctx.roundRect）
                ctx.beginPath();
                ctx.moveTo(x + r, y);
                ctx.arcTo(x + w, y, x + w, y + h, r);
                ctx.arcTo(x + w, y + h, x, y + h, r);
                ctx.arcTo(x, y + h, x, y, r);
                ctx.arcTo(x, y, x + w, y, r);
                ctx.closePath();
            }
            function fitFont(ctx, text, weight, size, maxW) {  // 文本过宽时自动缩小字号
                let s = size;
                ctx.font = weight + ' ' + s + 'px ' + FONT;
                while (s > 12 && ctx.measureText(text).width > maxW) { s -= 2; ctx.font = weight + ' ' + s + 'px ' + FONT; }
                return s;
            }

            /* 一次排版绘制：返回内容结束 y。gapScale 用于壁纸模式拉伸段间距 */
            function paint(ctx, gapScale) {
                let y = PAD;
                // 顶部渐变饰条
                const barG = ctx.createLinearGradient(0, 0, W, 0);
                barG.addColorStop(0, C_ACC1); barG.addColorStop(1, C_ACC2);
                ctx.fillStyle = barG; ctx.fillRect(0, 0, W, 6);
                // hero
                ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
                ctx.fillStyle = C_TXT;
                let fs = fitFont(ctx, bigTitle, '800', Math.round(84 * K), W - 2 * PAD);
                ctx.fillText(bigTitle, PAD, y + fs);
                y += fs + 10 * K;
                ctx.fillStyle = C_ACC2;
                ctx.font = '600 ' + Math.round(30 * K) + 'px ' + FONT;
                ctx.fillText(subTitle, PAD, y + 30 * K);
                y += 30 * K + 18 * K;
                // 一句话总结（自动换行，最多 2 行）
                ctx.fillStyle = C_SUB;
                fs = fitFont(ctx, summary, '400', Math.round(27 * K), W - 2 * PAD);
                if (ctx.measureText(summary).width <= W - 2 * PAD) {
                    ctx.fillText(summary, PAD, y + fs); y += fs + 6 * K;
                } else {
                    const words = summary.split(' · ');
                    let line = '', lines = [];
                    words.forEach(wd => {
                        const t = line ? line + ' · ' + wd : wd;
                        if (ctx.measureText(t).width > W - 2 * PAD && line) { lines.push(line); line = wd; }
                        else line = t;
                    });
                    if (line) lines.push(line);
                    lines.slice(0, 2).forEach(ln => { ctx.fillText(ln, PAD, y + fs); y += fs + 8 * K; });
                }
                y += G0 * gapScale;
                // 5 个数字卡
                const nw = (W - 2 * PAD - 4 * 12 * K) / 5, nh = 118 * K;
                nums.forEach((n, i) => {
                    const x = PAD + i * (nw + 12 * K);
                    rr(ctx, x, y, nw, nh, 14 * K);
                    ctx.fillStyle = 'rgba(255,255,255,.07)'; ctx.fill();
                    ctx.strokeStyle = 'rgba(255,255,255,.12)'; ctx.lineWidth = 1; ctx.stroke();
                    ctx.textAlign = 'center';
                    const vs = fitFont(ctx, n.v, '700', Math.round(40 * K), nw - 16 * K);
                    ctx.fillStyle = i % 2 ? C_ACC2 : C_ACC1;
                    ctx.fillText(n.v, x + nw / 2, y + nh / 2 + 4 * K);
                    ctx.fillStyle = C_SUB;
                    ctx.font = '400 ' + Math.round(21 * K) + 'px ' + FONT;
                    ctx.fillText(n.l, x + nw / 2, y + nh - 20 * K);
                    ctx.textAlign = 'left';
                });
                y += nh + G0 * gapScale;
                // 新点亮城市 chips（≤18 + 「…等 N 座」）
                if (chips.length || chipsMore > 0) {
                    ctx.font = '500 ' + Math.round(22 * K) + 'px ' + FONT;
                    let cx = PAD, cy = y;
                    const ch = 46 * K, cp = 22 * K, cg = 12 * K;
                    const drawChip = (text, tcol) => {
                        const tw = ctx.measureText(text).width + cp * 2;
                        if (cx + tw > W - PAD) { cx = PAD; cy += ch + cg; }
                        rr(ctx, cx, cy, tw, ch, ch / 2);
                        ctx.fillStyle = 'rgba(129,140,248,.16)'; ctx.fill();
                        ctx.strokeStyle = 'rgba(129,140,248,.45)'; ctx.stroke();
                        ctx.fillStyle = tcol || C_TXT;
                        ctx.fillText(text, cx + cp, cy + ch / 2 + 8 * K);
                        cx += tw + cg;
                    };
                    chips.forEach(t => drawChip(t));
                    if (chipsMore > 0) drawChip('…等 ' + chipsMore + ' 座', C_FAINT);
                    y = cy + ch + G0 * gapScale;
                }
                // 柱状图（年度 12 月 / 全部按年）
                const bh = 190 * K, bw = (W - 2 * PAD) / bars.length;
                const maxB = Math.max(1, ...bars.map(b => b.pointCount));
                const baseY = y + bh;
                ctx.strokeStyle = 'rgba(255,255,255,.15)'; ctx.lineWidth = 1;
                ctx.beginPath(); ctx.moveTo(PAD, baseY + 1); ctx.lineTo(W - PAD, baseY + 1); ctx.stroke();
                bars.forEach((b, i) => {
                    const h = Math.max(b.pointCount ? 10 * K : 3 * K, b.pointCount / maxB * (bh - 30 * K));
                    const x = PAD + i * bw + bw * 0.16, bwr = bw * 0.68;
                    const g = ctx.createLinearGradient(0, baseY - h, 0, baseY);
                    g.addColorStop(0, C_ACC1); g.addColorStop(1, 'rgba(56,189,248,.35)');
                    ctx.fillStyle = g;
                    rr(ctx, x, baseY - h, bwr, h, 4 * K); ctx.fill();
                    if (b.pointCount) {
                        ctx.fillStyle = C_FAINT; ctx.textAlign = 'center';
                        ctx.font = '400 ' + Math.round(18 * K) + 'px ' + FONT;
                        ctx.fillText(String(b.pointCount), x + bwr / 2, baseY - h - 8 * K);
                        ctx.textAlign = 'left';
                    }
                    ctx.fillStyle = C_FAINT; ctx.textAlign = 'center';
                    ctx.font = '400 ' + Math.round(18 * K) + 'px ' + FONT;
                    ctx.fillText(b.month, x + bwr / 2, baseY + 26 * K);
                    ctx.textAlign = 'left';
                });
                y = baseY + 26 * K + G0 * gapScale;
                // 去得最多的地方（≤5）
                if (places.length) {
                    const maxC = Math.max(1, ...places.map(p => p.count));
                    places.forEach(p => {
                        ctx.fillStyle = C_TXT;
                        const nfs = fitFont(ctx, p.name, '600', Math.round(26 * K), W - 2 * PAD - 120 * K);
                        ctx.fillText(p.name, PAD, y + nfs);
                        ctx.textAlign = 'right'; ctx.fillStyle = C_ACC2;
                        ctx.font = '600 ' + Math.round(24 * K) + 'px ' + FONT;
                        ctx.fillText(p.count + ' 次', W - PAD, y + nfs);
                        ctx.textAlign = 'left';
                        const rowY = y + nfs + 12 * K;
                        rr(ctx, PAD, rowY, W - 2 * PAD, 8 * K, 4 * K);
                        ctx.fillStyle = 'rgba(255,255,255,.10)'; ctx.fill();
                        rr(ctx, PAD, rowY, Math.max(12 * K, (W - 2 * PAD) * p.count / maxC), 8 * K, 4 * K);
                        ctx.fillStyle = C_ACC1; ctx.fill();
                        y = rowY + 8 * K + 24 * K;
                    });
                    y += G0 * gapScale;
                }
                // 页脚
                ctx.fillStyle = C_FAINT; ctx.textAlign = 'center';
                ctx.font = '400 ' + Math.round(24 * K) + 'px ' + FONT;
                ctx.fillText('—— 生活驾驶舱 · 我的足迹', W / 2, y + 24 * K);
                ctx.textAlign = 'left';
                return y + 24 * K;
            }
            // 底部装饰性轨迹点线（仅壁纸）
            function paintTrail(ctx, fromY) {
                const y0 = fromY, amp = 26, seg = W / 14;
                ctx.strokeStyle = 'rgba(129,140,248,.5)';
                ctx.lineWidth = 3; ctx.setLineDash([2, 12]); ctx.lineCap = 'round';
                ctx.beginPath();
                for (let i = 0; i <= 14; i++) {
                    const x = PAD * 0.4 + i * seg, yy = y0 + Math.sin(i * 1.1) * amp;
                    if (i === 0) ctx.moveTo(x, yy); else ctx.lineTo(x, yy);
                }
                ctx.stroke(); ctx.setLineDash([]);
                for (let i = 0; i <= 14; i += 3) {
                    const x = PAD * 0.4 + i * seg, yy = y0 + Math.sin(i * 1.1) * amp;
                    ctx.beginPath(); ctx.arc(x, yy, i === 0 || i === 14 ? 9 : 5, 0, Math.PI * 2);
                    ctx.fillStyle = i === 0 ? C_ACC2 : (i === 14 ? C_ACC1 : 'rgba(255,255,255,.75)');
                    ctx.fill();
                }
            }
            // 深色渐变底
            function paintBg(ctx, h) {
                const g = ctx.createLinearGradient(0, 0, W, h);
                g.addColorStop(0, '#1e293b'); g.addColorStop(1, '#312e81');
                ctx.fillStyle = g; ctx.fillRect(0, 0, W, h);
            }

            // 量高：先在草稿画布上按基准间距排一遍，得到内容高度
            const scratch = document.createElement('canvas');
            scratch.width = W; scratch.height = 4800;
            const sctx = scratch.getContext('2d');
            const endY = paint(sctx, 1);
            const contentH = endY - PAD + 24 * K;
            const c = document.createElement('canvas');
            const ctx = c.getContext('2d');
            if (WALL) {
                // 壁纸：固定 2340，段间距拉伸填充余量，底部留装饰轨迹区
                const TRAIL = 170;
                const avail = 2340 - 2 * PAD - TRAIL;
                const gapsAt1 = 4 * G0;   // 基准段间距总量估算（summary/nums/chips/chart 之后各一次）
                const fixed = Math.max(0, contentH - gapsAt1);
                const gapScale = Math.max(0.6, Math.min(2.6, (avail - fixed) / gapsAt1));
                c.width = W; c.height = 2340;
                paintBg(ctx, 2340);
                const end2 = paint(ctx, gapScale);
                paintTrail(ctx, Math.min(2340 - 90, end2 + 60 * K));
            } else {
                // 分享卡：动态高（不足 1400 取 1400，上限 1920）
                let H = Math.max(1400, Math.ceil(endY + PAD));
                if (H > 1920) {
                    // 超上限：压缩段间距重排一版（chips≤18/places≤5 的数据量实际到不了这里）
                    H = 1920;
                    const scale = Math.max(0.3, (H - 2 * PAD) / contentH);
                    c.width = W; c.height = H;
                    paintBg(ctx, H);
                    paint(ctx, scale);
                } else {
                    c.width = W; c.height = H;
                    paintBg(ctx, H);
                    paint(ctx, 1);
                }
            }
            c.toBlob(blob => {
                if (!blob) { showToast('生成图片失败', 'error'); return; }
                const a = document.createElement('a');
                a.href = URL.createObjectURL(blob);
                a.download = (isAll ? '全部年份' : d.year) + '-足迹报告.png';
                a.click();
                setTimeout(() => URL.revokeObjectURL(a.href), 3000);
                showToast(WALL ? '壁纸已保存（1080×2340）' : '分享图已保存', 'success');
            }, 'image/png');
        }

        /* ============ G2 足迹名片：填色图 → 分享图 / 壁纸（canvas 纯前端绘制） ============
           与年报卡同一家族视觉：深色渐变底 + 顶部渐变饰条。地图为「当前 DOM 的 SVG 序列化」：
           path fill 内联后转 data URL 绘入 canvas（同源纯图形，不污染画布）；南海角标单独绘制。
           只画自源地图与文字，照片一律不入画布。mode='card' 1080×动态高；'wallpaper' 1080×2340。 */
        function openFpCardModal() { openModal('fpCardModal'); }
        function cnSvgDataUrl(svgId) {
            const svgEl = document.getElementById(svgId);
            if (!svgEl || !svgEl.getAttribute || !svgEl.getAttribute('viewBox')) return '';
            const lit = cnLitMap();
            const clone = svgEl.cloneNode(true);
            clone.querySelectorAll('.cn-prov').forEach(p => {
                p.setAttribute('fill', lit[p.dataset.name] ? '#3b82f6' : '#334155');
                p.setAttribute('stroke', '#0f172a');
                p.setAttribute('stroke-width', '1');
                p.removeAttribute('class');
                p.removeAttribute('style');
            });
            clone.querySelectorAll('.cn-inset-prov').forEach(p => {
                p.setAttribute('fill', lit[p.dataset.name] ? '#3b82f6' : '#334155');
                p.setAttribute('stroke', 'none');
                p.removeAttribute('class');
            });
            clone.querySelectorAll('.cn-inset-jd').forEach(p => {
                p.setAttribute('fill', 'none');
                p.setAttribute('stroke', 'rgba(148,163,184,.85)');
                p.setAttribute('stroke-width', '.8');
                p.removeAttribute('class');
            });
            const vb = svgEl.getAttribute('viewBox').split(' ').map(Number);
            if (vb.length !== 4 || !vb[2] || !vb[3]) return '';
            clone.setAttribute('width', vb[2]);
            clone.setAttribute('height', vb[3]);
            clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
            return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(clone));
        }
        function cnLoadImg(url) {
            return new Promise((resolve, reject) => {
                const im = new Image();
                im.onload = () => resolve(im);
                im.onerror = () => reject(new Error('svg image load failed'));
                im.src = url;
            });
        }
        async function renderFootprintCard(mode) {
            if (!cnMapBuilt) return showToast('填色图还没就绪，请稍候再试', 'info');
            const urlMain = cnSvgDataUrl('cnMap');
            const urlInset = cnSvgDataUrl('cnInsetMap');
            if (!urlMain || !urlInset) return showToast('生成图片失败', 'error');
            let imMain, imInset;
            try { imMain = await cnLoadImg(urlMain); imInset = await cnLoadImg(urlInset); }
            catch (e) { return showToast('地图数据生成失败', 'error'); }

            const WALL = mode === 'wallpaper';
            const W = 1080;
            const PAD = WALL ? 110 : 72;
            const FONT = '"PingFang SC","Microsoft YaHei",sans-serif';
            const C_ACC1 = '#818cf8', C_ACC2 = '#38bdf8';
            const C_TXT = '#f1f5f9', C_SUB = 'rgba(226,232,240,.72)', C_FAINT = 'rgba(226,232,240,.55)';
            const lit = cnLitMap();
            const provN = Object.keys(lit).length;
            const provT = (fp && fp.provinceTotal) || 34;
            const cityN = cnYear === 'all' ? (fp ? fp.litCityCount : 0)
                : Object.keys(lit).reduce((s, k) => s + lit[k].cityCount, 0);
            const ptN = cnYear === 'all' ? (fp && fp.stats ? fp.stats.pointCount : 0)
                : Object.keys(lit).reduce((s, k) => s + (lit[k].pointCount || 0), 0);
            const isAll = cnYear === 'all';
            const bigTitle = '我的足迹';
            const subTitle = (isAll ? '全部年份' : cnYear + ' 年') + ' · 省份填色足迹图';
            const summary = isAll
                ? '走过 ' + cityN + ' 座城市，点亮 ' + provN + ' / ' + provT + ' 个省份，留下 ' + ptN + ' 个足迹'
                + ((fp && fp.stats) ? '，行程约 ' + fmtDist(fp.stats.totalDistance) : '')
                : cnYear + ' 年点亮 ' + provN + ' 个省份，走过 ' + cityN + ' 座城市，留下 ' + ptN + ' 个足迹';
            const now = new Date();
            const dateStr = now.getFullYear() + '年' + (now.getMonth() + 1) + '月' + now.getDate() + '日';
            const G = 44;                                // 基准段间距

            function rr(ctx, x, y, w, h, r) {
                ctx.beginPath();
                ctx.moveTo(x + r, y);
                ctx.arcTo(x + w, y, x + w, y + h, r);
                ctx.arcTo(x + w, y + h, x, y + h, r);
                ctx.arcTo(x, y + h, x, y, r);
                ctx.arcTo(x, y, x + w, y, r);
                ctx.closePath();
            }
            /* 一次排版绘制：返回内容结束 y；gapScale 用于壁纸拉伸段间距 */
            function paint(ctx, gapScale) {
                let y = PAD;
                const barG = ctx.createLinearGradient(0, 0, W, 0);
                barG.addColorStop(0, C_ACC1); barG.addColorStop(1, C_ACC2);
                ctx.fillStyle = barG; ctx.fillRect(0, 0, W, 6);
                y += 6;
                ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
                ctx.fillStyle = C_TXT;
                ctx.font = '800 84px ' + FONT;
                ctx.fillText(bigTitle, PAD, y + 84); y += 84 + 14;
                ctx.fillStyle = C_ACC2;
                ctx.font = '600 30px ' + FONT;
                ctx.fillText(subTitle, PAD, y + 30); y += 30 + 16;
                ctx.fillStyle = C_SUB;
                ctx.font = '400 27px ' + FONT;
                ctx.fillText(summary, PAD, y + 27); y += 27 + G * gapScale;

                /* ---- 中国地图（主图 + 南海角标）---- */
                const mapW = W - 2 * PAD;
                const mapH = mapW * (imMain.height / imMain.width);
                const mapY = y;
                ctx.drawImage(imMain, PAD, mapY, mapW, mapH);
                const insW = Math.round(mapW * 0.185);
                const insH = insW * (imInset.height / imInset.width);
                const insX = PAD + mapW - insW - 8;
                const insY = mapY + mapH - insH - 34;
                /* 角标底框 + 边线（标准全图画法） */
                ctx.fillStyle = 'rgba(15,23,42,.6)';
                ctx.fillRect(insX, insY, insW, insH + 30);
                ctx.strokeStyle = 'rgba(148,163,184,.45)'; ctx.lineWidth = 1;
                ctx.strokeRect(insX + .5, insY + .5, insW - 1, insH + 29);
                ctx.drawImage(imInset, insX, insY, insW, insH);
                ctx.fillStyle = 'rgba(226,232,240,.8)';
                ctx.font = '400 20px ' + FONT; ctx.textAlign = 'center';
                ctx.fillText('南海诸岛', insX + insW / 2, insY + insH + 22);
                ctx.textAlign = 'left';
                y = mapY + mapH + G * gapScale;

                /* ---- 3 个数字卡 ---- */
                const nums = [
                    { v: provN + ' / ' + provT, l: '点亮省份' },
                    { v: String(cityN), l: '到访城市' },
                    { v: String(ptN), l: '足迹点' }
                ];
                const nw = (W - 2 * PAD - 2 * 12) / 3, nh = 118;
                nums.forEach((n, i) => {
                    const x = PAD + i * (nw + 12);
                    rr(ctx, x, y, nw, nh, 14);
                    ctx.fillStyle = 'rgba(255,255,255,.07)'; ctx.fill();
                    ctx.strokeStyle = 'rgba(255,255,255,.12)'; ctx.lineWidth = 1; ctx.stroke();
                    ctx.textAlign = 'center';
                    ctx.font = '700 40px ' + FONT;
                    ctx.fillStyle = i % 2 ? C_ACC2 : C_ACC1;
                    ctx.fillText(n.v, x + nw / 2, y + 58);
                    ctx.fillStyle = C_SUB;
                    ctx.font = '400 21px ' + FONT;
                    ctx.fillText(n.l, x + nw / 2, y + 96);
                    ctx.textAlign = 'left';
                });
                y += nh + G * gapScale;

                /* ---- 页脚 ---- */
                ctx.fillStyle = C_FAINT; ctx.textAlign = 'center';
                ctx.font = '400 24px ' + FONT;
                ctx.fillText(dateStr + ' · 生活驾驶舱', W / 2, y + 24);
                ctx.font = '400 19px ' + FONT;
                ctx.fillText('图片仅在本机生成，不会上传', W / 2, y + 56);
                ctx.textAlign = 'left';
                return y + 56;
            }
            function paintBg(ctx, h) {
                const g = ctx.createLinearGradient(0, 0, W, h);
                g.addColorStop(0, '#1e293b'); g.addColorStop(1, '#312e81');
                ctx.fillStyle = g; ctx.fillRect(0, 0, W, h);
            }
            function paintTrail(ctx, fromY) {
                const y0 = fromY, amp = 22, seg = W / 14;
                ctx.strokeStyle = 'rgba(129,140,248,.5)';
                ctx.lineWidth = 3; ctx.setLineDash([2, 12]); ctx.lineCap = 'round';
                ctx.beginPath();
                for (let i = 0; i <= 14; i++) {
                    const x = PAD * 0.4 + i * seg, yy = y0 + Math.sin(i * 1.1) * amp;
                    if (i === 0) ctx.moveTo(x, yy); else ctx.lineTo(x, yy);
                }
                ctx.stroke(); ctx.setLineDash([]);
                for (let i = 0; i <= 14; i += 3) {
                    const x = PAD * 0.4 + i * seg, yy = y0 + Math.sin(i * 1.1) * amp;
                    ctx.beginPath(); ctx.arc(x, yy, i === 0 || i === 14 ? 8 : 4, 0, Math.PI * 2);
                    ctx.fillStyle = i === 0 ? C_ACC2 : (i === 14 ? C_ACC1 : 'rgba(255,255,255,.75)');
                    ctx.fill();
                }
            }

            const c = document.createElement('canvas');
            const ctx = c.getContext('2d');
            if (WALL) {
                /* 壁纸：先量内容高，再拉伸段间距铺满 2340，底部留装饰轨迹区 */
                const scratch = document.createElement('canvas');
                scratch.width = W; scratch.height = 2600;
                const sctx = scratch.getContext('2d');
                const endY = paint(sctx, 1);
                const gapsAt1 = 3 * G;
                const fixed = endY - PAD - gapsAt1;
                const avail = 2340 - 2 * PAD - 170;
                const gapScale = Math.max(.6, Math.min(3, (avail - fixed) / gapsAt1));
                c.width = W; c.height = 2340;
                paintBg(ctx, 2340);
                const end2 = paint(ctx, gapScale);
                paintTrail(ctx, Math.min(2340 - 90, end2 + 70));
            } else {
                const scratch = document.createElement('canvas');
                scratch.width = W; scratch.height = 2200;
                const sctx = scratch.getContext('2d');
                const endY = paint(sctx, 1);
                let H = Math.max(1400, Math.ceil(endY + PAD));
                if (H > 1920) H = 1920;
                c.width = W; c.height = H;
                paintBg(ctx, H);
                paint(ctx, H > 1500 ? 1.3 : 1);
            }
            c.toBlob(blob => {
                if (!blob) { showToast('生成图片失败', 'error'); return; }
                const a = document.createElement('a');
                a.href = URL.createObjectURL(blob);
                a.download = '足迹名片-' + (isAll ? '全部年份' : cnYear + '年') + (WALL ? '-壁纸' : '') + '.png';
                a.click();
                setTimeout(() => URL.revokeObjectURL(a.href), 3000);
                closeModal('fpCardModal');
                showToast(WALL ? '壁纸已保存（1080×2340）' : '足迹名片已保存', 'success');
            }, 'image/png');
        }

        function viewPhoto(url) { document.getElementById('photoImg').src = url; openModal('photoModal'); }

        /* ============ 条2：最近一次自动备份状态（fail-soft） ============
           复用 /api/backup/status（与系统设置页同一接口，仅管理员可读）；
           接口失败（含非管理员 403）或字段为空 → 整行隐藏。 */
        async function loadBackupLine() {
            const el = document.getElementById('fpBackupLine');
            if (!el) return;
            try {
                const r = await apiGet('/api/backup/status');
                const d = r && r.data;
                if (!r || r.code !== 200 || !d || !d.lastRunDate) { el.style.display = 'none'; return; }
                // UI-51：状态词前缀替换（'ok · 12 个文件…' → '成功 · …'），保留尾部详情，避免中英混排
                const resTxt = String(d.lastResult || '').replace(/^(ok|success|failed|fail|error)\b/i, m => (/^(ok|success)/i.test(m) ? '成功' : '失败')).slice(0, 60);
                el.textContent = '上次自动备份：' + String(d.lastRunDate).slice(0, 16) + ' · ' + resTxt;
                el.style.display = 'block';
            } catch (e) { el.style.display = 'none'; }
        }

        renderShell('footprint', '足迹回顾');

        async function boot() {
            await loadAppConfig(); // 复用壳在途的同一份 /api/settings/config，消除首屏重复请求
            mapKey = (FEATURE_FLAGS && FEATURE_FLAGS.mapKey) || '';
            loadBackupLine();
            calMoodLoad();   // 任务 #16-A：心情文案（localStorage，缺省落默认文案）
            await loadAll();
            initCnMap();          // G1 填色图：本地 SVG，与 TMap SDK 并行加载（互不依赖）
            await initMap();
            setMapView(cnView);   // 统一校正显隐（initMap 成功会打开 tmap，默认视图填色图需拨回）
            handleShareImport(); // Web Share Target 回流检测（内部 fail-soft）
        }
        boot();
