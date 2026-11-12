'use strict';
/* 模块注册表。
 * 顺序不重要：每条路由带 order（原始 if 链中的行号），由 router 排序恢复全局顺序。
 * 这里只决定 require 顺序，便于阅读。 */

const MODULES = [
  'wechat',
  'auth',
  'settings',
  'misc',
  'home',
  'insights',
  'brief',
  'ask',
  'ai',
  'tasks',
  'footprint',
  'notes',
  'anniversaries',
  'scheduled',
  'gifts',
  'family',
  'health',
  'ledger',
  'expiries',
  'vault',
  'finance',
  'backup',
];

module.exports = { MODULES };
