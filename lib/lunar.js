/**
 * 农历 / 节假日纯函数模块
 * 从 server.js 抽出（#4 单文件拆分的第一步）：只做历法换算与节假日表，
 * 不依赖 db / 会话 / 文件系统等任何外部状态，纯输入输出，便于单测与复用。
 * 数据来源：1900-2100 农历对照表（LUNAR_INFO）。
 */

const LUNAR_INFO = [
0x04bd8,0x04ae0,0x0a570,0x054d5,0x0d260,0x0d950,0x16554,0x056a0,0x09ad0,0x055d2,
0x04ae0,0x0a5b6,0x0a4d0,0x0d250,0x1d255,0x0b540,0x0d6a0,0x0ada2,0x095b0,0x14977,
0x04970,0x0a4b0,0x0b4b5,0x06a50,0x06d40,0x1ab54,0x02b60,0x09570,0x052f2,0x04970,
0x06566,0x0d4a0,0x0ea50,0x06e95,0x05ad0,0x02b60,0x186e3,0x092e0,0x1c8d7,0x0c950,
0x0d4a0,0x1d8a6,0x0b550,0x056a0,0x1a5b4,0x025d0,0x092d0,0x0d2b2,0x0a950,0x0b557,
0x06ca0,0x0b550,0x15355,0x04da0,0x0a5b0,0x14573,0x052b0,0x0a9a8,0x0e950,0x06aa0,
0x0aea6,0x0ab50,0x04b60,0x0aae4,0x0a570,0x05260,0x0f263,0x0d950,0x05b57,0x056a0,
0x096d0,0x04dd5,0x04ad0,0x0a4d0,0x0d4d4,0x0d250,0x0d558,0x0b540,0x0b6a0,0x195a6,
0x095b0,0x049b0,0x0a974,0x0a4b0,0x0b27a,0x06a50,0x06d40,0x0af46,0x0ab60,0x09570,
0x04af5,0x04970,0x064b0,0x074a3,0x0ea50,0x06b58,0x055c0,0x0ab60,0x096d5,0x092e0,
0x0c960,0x0d954,0x0d4a0,0x0da50,0x07552,0x056a0,0x0abb7,0x025d0,0x092d0,0x0cab5,
0x0a950,0x0b4a0,0x0baa4,0x0ad50,0x055d9,0x04ba0,0x0a5b0,0x15176,0x052b0,0x0a930,
0x07954,0x06aa0,0x0ad50,0x05b52,0x04b60,0x0a6e6,0x0a4e0,0x0d260,0x0ea65,0x0d530,
0x05aa0,0x076a3,0x096d0,0x04afb,0x04ad0,0x0a4d0,0x1d0b6,0x0d250,0x0d520,0x0dd45,
0x0b5a0,0x056d0,0x055b2,0x049b0,0x0a577,0x0a4b0,0x0aa50,0x1b255,0x06d20,0x0ada0,
0x14b63,0x09370,0x049f8,0x04970,0x064b0,0x168a6,0x0ea50,0x06b20,0x1a6c4,0x0aae0,
0x0a2e0,0x0d2e3,0x0c960,0x0d557,0x0d4a0,0x0da50,0x05d55,0x056a0,0x0a6d0,0x055d4,
0x052d0,0x0a9b8,0x0a950,0x0b4a0,0x0b6a6,0x0ad50,0x055a0,0x0aba4,0x0a5b0,0x052b0,
0x0b273,0x06930,0x07337,0x06aa0,0x0ad50,0x14b55,0x04b60,0x0a570,0x054e4,0x0d160,
0x0e968,0x0d520,0x0daa0,0x16aa6,0x056d0,0x04ae0,0x0a9d4,0x0a2d0,0x0d150,0x0f252,
0x0d520];

/* ---------------- 节假日表（法定假日 / 调休 / 传统节日） ---------------- */
function lYearDaysLocal(y) {
  let sum = 348;
  for (let i = 0x8000; i > 0x8; i >>= 1) sum += (LUNAR_INFO[y - 1900] & i) ? 1 : 0;
  const leap = LUNAR_INFO[y - 1900] & 0xf;
  return sum + (leap ? ((LUNAR_INFO[y - 1900] & 0x10000) ? 30 : 29) : 0);
}
function lunar2solar(ly, lm, ld) {
  let offset = 0;
  for (let y = 1900; y < ly; y++) offset += lYearDaysLocal(y);
  const leap = LUNAR_INFO[ly - 1900] & 0xf;
  for (let m = 1; m < lm; m++) {
    offset += (LUNAR_INFO[ly - 1900] & (0x10000 >> m)) ? 30 : 29;
    if (leap > 0 && m === leap) offset += (LUNAR_INFO[ly - 1900] & 0x10000) ? 30 : 29;
  }
  offset += ld - 1;
  const d = new Date(Date.UTC(1900, 0, 31) + offset * 86400000);
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
}
function holidaysOf(year) {
  const pad = n => String(n).padStart(2, '0');
  const fixed = {
    '01-01': '元旦', '02-14': '情人节', '03-08': '妇女节', '03-12': '植树节',
    '04-01': '愚人节', '05-01': '劳动节', '05-04': '青年节', '06-01': '儿童节',
    '07-01': '建党节', '08-01': '建军节', '09-10': '教师节', '10-01': '国庆节',
    '12-24': '平安夜', '12-25': '圣诞节'
  };
  const map = {};
  Object.keys(fixed).forEach(k => { map[year + '-' + k] = { name: fixed[k], type: 'festival' }; });
  const lunarFest = {
    '1-1': '春节', '1-15': '元宵节', '2-2': '龙抬头', '5-5': '端午节',
    '7-7': '七夕节', '7-15': '中元节', '8-15': '中秋节', '9-9': '重阳节', '12-8': '腊八节'
  };
  Object.keys(lunarFest).forEach(k => {
    const parts = k.split('-').map(Number);
    try {
      const ds = lunar2solar(year, parts[0], parts[1]);
      if (ds.startsWith(String(year))) map[ds] = { name: lunarFest[k], type: 'lunar' };
    } catch (e) { /* 忽略 */ }
  });
  if (!map[year + '-04-04']) map[year + '-04-04'] = { name: '清明节', type: 'festival' };
  const legal = {
    2025: {
      '01-01': '元旦', '01-28': '除夕', '01-29': '春节', '01-30': '春节', '01-31': '春节',
      '02-01': '春节', '02-02': '春节', '02-03': '春节', '02-04': '春节',
      '04-04': '清明节', '04-05': '清明节', '04-06': '清明节',
      '05-01': '劳动节', '05-02': '劳动节', '05-03': '劳动节', '05-04': '劳动节', '05-05': '劳动节',
      '05-31': '端午节', '06-01': '端午节', '06-02': '端午节',
      '10-01': '国庆节', '10-02': '国庆节', '10-03': '国庆节', '10-04': '国庆节', '10-05': '国庆节',
      '10-06': '中秋节', '10-07': '国庆节', '10-08': '国庆节'
    },
    2026: {
      '01-01': '元旦', '01-02': '元旦', '01-03': '元旦',
      '02-15': '春节', '02-16': '除夕', '02-17': '春节', '02-18': '春节', '02-19': '春节',
      '02-20': '春节', '02-21': '春节', '02-22': '春节', '02-23': '春节',
      '04-04': '清明节', '04-05': '清明节', '04-06': '清明节',
      '05-01': '劳动节', '05-02': '劳动节', '05-03': '劳动节', '05-04': '劳动节', '05-05': '劳动节',
      '06-19': '端午节', '06-20': '端午节', '06-21': '端午节',
      '09-25': '中秋节', '09-26': '中秋节', '09-27': '中秋节',
      '10-01': '国庆节', '10-02': '国庆节', '10-03': '国庆节', '10-04': '国庆节', '10-05': '国庆节',
      '10-06': '国庆节', '10-07': '国庆节', '10-08': '国庆节'
    }
  };
  if (legal[year]) Object.keys(legal[year]).forEach(k => {
    map[year + '-' + k] = { name: legal[year][k], type: 'holiday' };
  });
  return map;
}

module.exports = { LUNAR_INFO, lYearDaysLocal, lunar2solar, holidaysOf };
